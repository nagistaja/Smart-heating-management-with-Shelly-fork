var __device = {
    nowMs: 0,
    callCount: 0,
    readCount: 0,
    slots: [],
    taskSequence: 0,
    lastTimerHandle: 0,
    crashed: null,
    baselineBlocks: 0,
};

function __setClock(ms) {
    __device.nowMs = ms;
    setTime(ms / __scenario.millisecondsPerSecond);
}

function __reportError(text) {
    print(__scenario.marks.error + ' ' + text);
}

// The firmware allocates every answer anew in the script's memory, so the script must not be handed the scenario's own strings and
// objects. '' + value copies a string; value.slice(0) would also create Espruino's String object in the measured memory.
function __freshCopy(value) {
    if (typeof value === 'string') return '' + value;
    if (value === null || typeof value !== 'object') return value;
    var copy = value instanceof Array ? [] : {};
    for (var key in value) copy[key] = __freshCopy(value[key]);
    return copy;
}

// A pending timer costs a script no memory on a device, so the queue must cost none here. The slots are made before the baseline is
// taken and filling one must allocate nothing: Espruino gives every new number and every null a block of its own, so times live in
// typed arrays and an empty field is undefined. The calibration cases of script-memory.js fail when this stops being true.
function __makeSlots(count) {
    for (var i = 0; i < count; i++) {
        __device.slots.push({
            isUsed: false, dueMs: new Float64Array(1), intervalMs: new Float64Array(1), sequence: 0, handle: 0,
            callback: undefined, userdata: undefined, answer: undefined,
        });
    }
}

function __addTask(dueMs, callback, userdata, answer, handle, intervalMs) {
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (slot.isUsed) continue;
        slot.isUsed = true;
        slot.dueMs[0] = dueMs;
        slot.intervalMs[0] = intervalMs;
        slot.sequence = __device.taskSequence++;
        slot.handle = handle;
        slot.callback = callback;
        slot.userdata = userdata;
        slot.answer = answer;
        return;
    }
    __reportError('more than ' + __device.slots.length + ' timers and RPC answers pending');
}

function __free(slot) {
    slot.isUsed = false;
    slot.callback = undefined;
    slot.userdata = undefined;
    slot.answer = undefined;
}

function __compareWithNode(recorded, params) {
    var paramsText = JSON.stringify(recorded.isKeyOnly ? { key: params.key } : params);
    if (paramsText !== recorded.paramsText) {
        __reportError(recorded.method + ' with ' + paramsText + ', in Node with ' + recorded.paramsText);
    }
}

function __replayedRead(name) {
    var recorded = __scenario.reads[__device.readCount];
    __device.readCount++;
    if (!recorded || recorded.name !== name) {
        __reportError('read ' + __device.readCount + ' is ' + name + ', in Node it was ' + (recorded ? recorded.name : 'not made'));
        return undefined;
    }
    return __freshCopy(recorded.answer);
}

var Shelly = {
    call: function (method, params, callback, userdata) {
        var recorded = __scenario.calls[__device.callCount];
        __device.callCount++;
        if (!recorded || recorded.method !== method) {
            __reportError('call ' + __device.callCount + ' is ' + method + ', in Node it was ' + (recorded ? recorded.method : 'not made'));
            return;
        }
        if (__scenario.isComparing) __compareWithNode(recorded, params);
        if (typeof callback === 'function') __addTask(__device.nowMs, callback, userdata, recorded.answer, 0, 0);
    },
    getComponentStatus: function () { return __replayedRead('getComponentStatus'); },
    getComponentConfig: function () { return __replayedRead('getComponentConfig'); },
    getDeviceInfo: function () { return __freshCopy(__scenario.deviceInfo); },
    getCurrentScriptId: function () { return __scenario.scriptId; },
};

var Timer = {
    set: function (delayMs, isRepeating, callback, userdata) {
        var handle = ++__device.lastTimerHandle;
        __addTask(__device.nowMs + delayMs, callback, userdata, undefined, handle, isRepeating ? delayMs : 0);
        return handle;
    },
    clear: function (handle) {
        for (var i = 0; i < __device.slots.length; i++) {
            var slot = __device.slots[i];
            if (slot.isUsed && slot.handle > 0 && slot.handle === handle) {
                __free(slot);
                return true;
            }
        }
        return undefined;
    },
};

function __nextDueSlot(untilMs) {
    var next = null;
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (!slot.isUsed || slot.dueMs[0] > untilMs) continue;
        if (!next || slot.dueMs[0] < next.dueMs[0] || (slot.dueMs[0] === next.dueMs[0] && slot.sequence < next.sequence)) next = slot;
    }
    return next;
}

function __runSlot(slot) {
    var callback = slot.callback;
    var userdata = slot.userdata;
    var answer = slot.answer;
    if (slot.dueMs[0] > __device.nowMs) __setClock(slot.dueMs[0]);
    if (slot.intervalMs[0] > 0) {
        slot.dueMs[0] = __device.nowMs + slot.intervalMs[0];
        slot.sequence = __device.taskSequence++;
    } else {
        __free(slot);
    }
    try {
        if (answer) callback(answer[1] === 0 ? __freshCopy(answer[0]) : undefined, answer[1], __freshCopy(answer[2]), userdata);
        else callback(userdata);
    } catch (error) {
        __device.crashed = String(error) + (error && error.stack ? '\n' + error.stack : '');
        __reportError('uncaught ' + __device.crashed);
    }
}

function __runFor(seconds) {
    var untilMs = __device.nowMs + seconds * __scenario.millisecondsPerSecond;
    for (var slot = __nextDueSlot(untilMs); slot && !__device.crashed; slot = __nextDueSlot(untilMs)) {
        __runSlot(slot);
    }
    __setClock(untilMs);
}

function __report() {
    var memory = process.memory(true);
    print(__scenario.marks.result + ' ' + JSON.stringify({
        baselineBlocks: __device.baselineBlocks,
        peakBlocks: memory.peak,
        retainedBlocks: memory.usage,
        blockBytes: memory.blocksize,
        callCount: __device.callCount,
        readCount: __device.readCount,
        errors: E.getErrorFlags(),
        crashed: __device.crashed,
    }));
}

Math.random = function () { return 0; };
E.setDST(
    __scenario.daylightSaving.shiftMinutes, __scenario.daylightSaving.standardOffsetMinutes,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.marchIndex,
    __scenario.daylightSaving.dayOffset, __scenario.daylightSaving.startMinuteOfDay,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.octoberIndex,
    __scenario.daylightSaving.dayOffset, __scenario.daylightSaving.endMinuteOfDay
);
__setClock(__scenario.now);
__makeSlots(__scenario.pendingTaskLimit);

__device.baselineBlocks = process.memory(true).usage;
process.resetPeakMemory();
