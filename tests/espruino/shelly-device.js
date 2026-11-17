var __device = {
    nowMs: __scenario.now,
    answeredCalls: 0,
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

// the firmware allocates every answer anew in the script's memory, so the script must not be handed the scenario's own strings and objects
function __freshCopy(value) {
    if (typeof value === 'string') return value.slice(0);
    if (value === null || typeof value !== 'object') return value;
    var copy = value instanceof Array ? [] : {};
    for (var key in value) copy[key] = __freshCopy(value[key]);
    return copy;
}

// A pending timer costs a script no memory on a device, so the queue must cost none here: its slots are made before the
// baseline is taken and reused. A slot keeps the shape it was made with, a large number in dueMs included, so filling it allocates nothing.
function __makeSlots(count) {
    for (var i = 0; i < count; i++) {
        __device.slots.push({ isUsed: false, dueMs: __scenario.now, sequence: 0, callback: null, userdata: null, answer: null, handle: 0, intervalMs: 0 });
    }
}

function __addTask(dueMs, callback, userdata, answer, handle, intervalMs) {
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (slot.isUsed) continue;
        slot.isUsed = true;
        slot.dueMs = dueMs;
        slot.sequence = __device.taskSequence++;
        slot.callback = callback;
        slot.userdata = userdata;
        slot.answer = answer;
        slot.handle = handle;
        slot.intervalMs = intervalMs;
        return;
    }
    __reportError('more than ' + __device.slots.length + ' timers and RPC answers pending');
}

function __free(slot) {
    slot.isUsed = false;
    slot.callback = null;
    slot.userdata = null;
    slot.answer = null;
}

var Shelly = {
    call: function (method, params, callback, userdata) {
        var recorded = __scenario.calls[__device.answeredCalls];
        __device.answeredCalls++;
        if (!recorded || recorded.method !== method) {
            __reportError('call ' + __device.answeredCalls + ' is ' + method + ', in Node it was ' + (recorded ? recorded.method : 'not made'));
            return;
        }
        if (recorded.timespec !== undefined && recorded.timespec !== params.timespec) {
            __reportError('schedule ' + params.timespec + ', in Node it was ' + recorded.timespec);
        }
        if (typeof callback === 'function') __addTask(__device.nowMs, callback, userdata, recorded.answer, 0, 0);
    },
    getComponentStatus: function (type) {
        if (type === 'sys') return { unixtime: Math.floor(__device.nowMs / __scenario.millisecondsPerSecond) };
        return { mem_used: 0, mem_peak: 0 };
    },
    getComponentConfig: function (type, id) {
        if (type === 'sys') return { location: __freshCopy(__scenario.location) };
        return { enable: __scenario.scripts.some(function (script) { return script.id === id && script.enable; }) };
    },
    getDeviceInfo: function () { return __freshCopy(__scenario.deviceInfo); },
    getCurrentScriptId: function () { return __scenario.scriptId; },
};

var Timer = {
    set: function (delayMs, isRepeating, callback, userdata) {
        var handle = ++__device.lastTimerHandle;
        __addTask(__device.nowMs + delayMs, callback, userdata, null, handle, isRepeating ? delayMs : 0);
        return handle;
    },
    clear: function (handle) {
        for (var i = 0; i < __device.slots.length; i++) {
            var slot = __device.slots[i];
            if (slot.isUsed && slot.handle === handle) {
                __free(slot);
                return true;
            }
        }
        return false;
    },
};

function __nextDueSlot(untilMs) {
    var next = null;
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (!slot.isUsed || slot.dueMs > untilMs) continue;
        if (!next || slot.dueMs < next.dueMs || (slot.dueMs === next.dueMs && slot.sequence < next.sequence)) next = slot;
    }
    return next;
}

function __runSlot(slot) {
    var callback = slot.callback;
    var userdata = slot.userdata;
    var answer = slot.answer;
    if (slot.dueMs > __device.nowMs) __setClock(slot.dueMs);
    if (slot.intervalMs > 0) {
        slot.dueMs = __device.nowMs + slot.intervalMs;
        slot.sequence = __device.taskSequence++;
    } else {
        __free(slot);
    }
    try {
        if (answer) callback(__freshCopy(answer[0]), answer[1], answer[2], userdata);
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
        answeredCalls: __device.answeredCalls,
        errors: E.getErrorFlags(),
        crashed: __device.crashed,
    }));
}

Math.random = function () { return 0; };
E.setDST(
    __scenario.daylightSaving.shiftMinutes, __scenario.daylightSaving.standardOffsetMinutes,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.marchIndex, 0, __scenario.daylightSaving.startMinuteOfDay,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.octoberIndex, 0, __scenario.daylightSaving.endMinuteOfDay
);
__setClock(__scenario.now);
__makeSlots(__scenario.pendingTaskLimit);

__device.baselineBlocks = process.memory(true).usage;
process.resetPeakMemory();
