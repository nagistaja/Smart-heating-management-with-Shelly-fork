var __device = {
    nowMs: __scenario.now,
    scheduleIds: [],
    tasks: [],
    taskSequence: 0,
    lastTimerHandle: 0,
    clearedTimers: {},
    crashed: null,
    baselineBlocks: 0,
};

function __setClock(ms) {
    __device.nowMs = ms;
    setTime(ms / 1000);
}

function __addTask(dueMs, callback, args) {
    __device.tasks.push({ dueMs: dueMs, sequence: __device.taskSequence++, callback: callback, args: args });
}

function __ok(result) {
    return [result, 0, ''];
}

function __failed(code, message) {
    return [null, code, message];
}

// the firmware allocates every HTTP answer anew in the script's memory, so the script must not get the scenario's own string
function __httpGet(params) {
    var answer = __scenario.http[params.url];
    if (!answer) {
        print('MOCKERR no answer for ' + params.url);
        return __failed(__scenario.limits.errAssumed, 'No answer');
    }
    var result = answer[0];
    if (!result) return __failed(answer[1], answer[2]);
    var copy = { code: result.code };
    if (result.body_b64 !== undefined) copy.body_b64 = result.body_b64.slice(0);
    if (result.body !== undefined) copy.body = result.body.slice(0);
    return __ok(copy);
}

function __scheduleCreate(params) {
    if (__device.scheduleIds.length >= __scenario.limits.schedules) return __failed(__scenario.limits.errResourceExhausted, 'Reached the maximum of jobs');
    if (params.calls.length > __scenario.limits.scheduleCalls) return __failed(__scenario.limits.errInvalidArgument, 'Invalid argument \'calls\'');
    var id = 1;
    __device.scheduleIds.forEach(function (takenId) { if (takenId >= id) id = takenId + 1; });
    __device.scheduleIds.push(id);
    print('MOCK schedule.create ' + JSON.stringify({ id: id, timespec: params.timespec }));
    return __ok({ id: id, rev: 1 });
}

function __scheduleDelete(params) {
    var index = __device.scheduleIds.indexOf(params.id);
    if (index < 0) return __failed(__scenario.limits.errInvalidArgument, 'Invalid argument \'id\': Not found!');
    __device.scheduleIds.splice(index, 1);
    return __ok({ rev: 1 });
}

function __kvsGet(params) {
    var value = __scenario.kvs[params.key];
    if (value === undefined) return __failed(__scenario.limits.errNotFound, 'Argument \'key\', value \'' + params.key + '\' not found!');
    return __ok({ value: value, etag: 'e' });
}

// the device keeps KVS outside the script's memory, so a written value is printed and not stored here
function __kvsSet(params) {
    print('MOCK kvs.set ' + JSON.stringify({ key: params.key, value: params.value }));
    return __ok({ etag: 'e', rev: 1 });
}

function __isKnownScript(id) {
    return __scenario.scripts.some(function (script) { return script.id === id; });
}

function __scriptList() {
    return __ok({ scripts: __scenario.scripts.map(function (script) { return { id: script.id, name: script.name, running: script.running }; }) });
}

var __RPC_HANDLERS = {
    'kvs.get': __kvsGet,
    'kvs.set': __kvsSet,
    'schedule.create': __scheduleCreate,
    'schedule.delete': __scheduleDelete,
    'http.get': __httpGet,
    'script.list': __scriptList,
    'switch.setconfig': function () { return __ok({ restart_required: false }); },
    'script.create': function () { return __ok({ id: __scenario.scripts.length + 1 }); },
    'script.putcode': function (params) { return __ok({ len: params.code.length }); },
    'script.setconfig': function () { return __ok({ restart_required: false }); },
    'script.start': function () { return __ok({ was_running: false }); },
};

var Shelly = {
    call: function (method, params, callback, userdata) {
        var handler = __RPC_HANDLERS[method.toLowerCase()];
        if (!handler) {
            print('MOCKERR method ' + method + ' is not simulated');
            return;
        }
        var answer = handler(params || {});
        if (typeof callback === 'function') __addTask(__device.nowMs, callback, [answer[0], answer[1], answer[2], userdata]);
    },
    getComponentStatus: function (type) {
        if (type === 'sys') return { unixtime: Math.floor(__device.nowMs / 1000) };
        return { mem_used: 0, mem_peak: 0 };
    },
    getComponentConfig: function (type, id) {
        if (type === 'sys') return { location: { lat: __scenario.location.lat, lon: __scenario.location.lon } };
        return { enable: __isKnownScript(id) };
    },
    getDeviceInfo: function () { return __scenario.deviceInfo; },
    getCurrentScriptId: function () { return __scenario.scriptId; },
};

var Timer = {
    set: function (delayMs, isRepeating, callback, userdata) {
        var handle = ++__device.lastTimerHandle;
        var fire = function (data) {
            if (__device.clearedTimers[handle]) return;
            if (isRepeating) __addTask(__device.nowMs + delayMs, fire, [data]);
            callback(data);
        };
        __addTask(__device.nowMs + delayMs, fire, [userdata]);
        return handle;
    },
    clear: function (handle) {
        __device.clearedTimers[handle] = true;
        return true;
    },
};

function __nextDueTaskIndex(untilMs) {
    var next = -1;
    for (var i = 0; i < __device.tasks.length; i++) {
        var task = __device.tasks[i];
        if (task.dueMs > untilMs) continue;
        var best = __device.tasks[next];
        if (next < 0 || task.dueMs < best.dueMs || (task.dueMs === best.dueMs && task.sequence < best.sequence)) next = i;
    }
    return next;
}

function __runTask(task) {
    if (task.dueMs > __device.nowMs) __setClock(task.dueMs);
    process.memory(true);
    try {
        task.callback.apply(undefined, task.args);
    } catch (error) {
        __device.crashed = String(error) + (error && error.stack ? '\n' + error.stack : '');
        print('MOCKERR uncaught ' + __device.crashed);
    }
}

function __runFor(seconds) {
    var untilMs = __device.nowMs + seconds * 1000;
    for (var index = __nextDueTaskIndex(untilMs); index >= 0 && !__device.crashed; index = __nextDueTaskIndex(untilMs)) {
        __runTask(__device.tasks.splice(index, 1)[0]);
    }
    __setClock(untilMs);
}

function __report() {
    var memory = process.memory(true);
    print('MEMRESULT ' + JSON.stringify({
        baselineBlocks: __device.baselineBlocks,
        peakBlocks: memory.peak,
        retainedBlocks: memory.usage,
        blockBytes: memory.blocksize,
        errors: E.getErrorFlags(),
        crashed: __device.crashed,
        version: process.version,
    }));
}

Math.random = function () { return 0; };
E.setTimeZone(2);
E.setDST(60, 120, 4, 0, 2, 0, 180, 4, 0, 9, 0, 240);
__setClock(__scenario.now);

__device.baselineBlocks = process.memory(true).usage;
process.resetPeakMemory();
