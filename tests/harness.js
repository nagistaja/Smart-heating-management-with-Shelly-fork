'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const limits = require('./limits');
const { NORMAL_DAY, GEN2_DEVICE, HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID } = require('./settings');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const SCRIPT = path.join(ROOT, 'SmartHeatingWidthShelly.js');
const MAX_STEPS = 100000;
const WATCHDOG_RUN_SECONDS = 10;
const DEFAULT_SCRIPTS = [{ id: HEATING_SCRIPT_ID, name: 'Smart Heating', running: true }];
const LOCATION = { lat: 59.437, lon: 24.7536 };
const ELERING_HEADER = '"Ajatempel (UTC)";"Kuup\xe4ev (Eesti aeg)";"NPS Eesti"';

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'latin1');
}

function eleringRows(fixture) {
    const lines = readFixture(fixture).split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const fields = lines[i].split(';').map((field) => field.replace(/"/g, ''));
        rows.push({ ts: Number(fields[0]), price: Number(fields[2].replace(',', '.')), line: lines[i] });
    }
    return { header: lines[0], rows };
}

function forecastBody(temps, hours) {
    const values = temps.slice(0, hours);
    return JSON.stringify({ hourly: { time: values.map((value, i) => 'T' + i), apparent_temperature: values } });
}

function defaultTemps() {
    return JSON.parse(readFixture('open-meteo-24h.json')).hourly.apparent_temperature;
}

function createShelly(options) {
    const opts = Object.assign({
        now: NORMAL_DAY.now,
        kvs: {},
        schedules: {},
        elering: NORMAL_DAY.fixture,
        temps: null,
        httpFail: null,
        scriptFile: SCRIPT,
        code: null,
        scripts: DEFAULT_SCRIPTS.map((script) => Object.assign({}, script)),
        scriptId: HEATING_SCRIPT_ID,
        deviceInfo: GEN2_DEVICE,
        components: [],
    }, options);

    const sim = {
        nowMs: Date.parse(opts.now),
        kvs: Object.assign({}, opts.kvs),
        schedules: new Map(),
        calls: [],
        logs: [],
        httpRequests: [],
        switchConfig: {},
        scripts: opts.scripts.map((script) => Object.assign({}, script)),
        scriptCode: {},
        crashed: null,
        inFlight: 0,
        components: opts.components.map((component) => JSON.parse(JSON.stringify(component))),
        group: null,
        statusHandlers: [],
        timers: new Map(),
        timerSeq: 0,
        tasks: [],
        seq: 0,
    };
    for (const id of Object.keys(opts.schedules)) {
        sim.schedules.set(Number(id), Object.assign({ enable: true }, opts.schedules[id]));
    }

    const eleringData = opts.elering ? eleringRows(opts.elering) : null;
    const temps = opts.temps || defaultTemps();

    function enqueue(atMs, fn) {
        sim.tasks.push({ at: atMs, seq: sim.seq++, fn });
    }

    function log() {
        sim.logs.push(Array.prototype.map.call(arguments, String).join(' '));
    }

    function eleringResponse(url) {
        const query = new URL(url).searchParams;
        const start = Date.parse(query.get('start')) / 1000;
        const end = Date.parse(query.get('end')) / 1000;
        let body = (eleringData ? eleringData.header : ELERING_HEADER) + '\n';
        if (eleringData) {
            for (const row of eleringData.rows) {
                if (row.ts >= start && row.ts <= end) body += row.line + '\n';
            }
        }
        return { code: 200, body_b64: Buffer.from(body, 'latin1').toString('base64') };
    }

    function httpGet(params) {
        sim.httpRequests.push(params.url);
        if (opts.httpFail && opts.httpFail.test(params.url)) {
            return [null, limits.ERR_DEADLINE_EXCEEDED, 'Deadline exceeded'];
        }
        if (params.url.indexOf('dashboard.elering.ee') >= 0) {
            return [eleringResponse(params.url), 0, ''];
        }
        if (params.url.indexOf('api.open-meteo.com') >= 0) {
            const hours = Number(new URL(params.url).searchParams.get('forecast_hours'));
            return [{ code: 200, body: forecastBody(temps, hours) }, 0, ''];
        }
        return [null, limits.ERR_DEADLINE_EXCEEDED, 'Unknown host'];
    }

    function lowestFreeScheduleId() {
        let id = 1;
        while (sim.schedules.has(id)) id++;
        return id;
    }

    function scheduleCreate(params) {
        if (sim.schedules.size >= limits.SCHEDULE_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Too many schedules'];
        if (!params.calls || params.calls.length > limits.SCHEDULE_CALL_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Too many calls'];
        const id = lowestFreeScheduleId();
        sim.schedules.set(id, JSON.parse(JSON.stringify(params)));
        return [{ id, rev: id }, 0, ''];
    }

    function scheduleDelete(params) {
        return sim.schedules.delete(params.id) ? [{ rev: 1 }, 0, '']
            : [null, limits.ERR_INVALID_ARGUMENT, 'Invalid argument \'id\': Not found!'];
    }

    function scheduleUpdate(params) {
        const job = sim.schedules.get(params.id);
        if (!job) return [null, limits.ERR_NOT_FOUND, 'Argument \'id\' not found!'];
        Object.assign(job, params);
        return [{ rev: 1 }, 0, ''];
    }

    function kvsGet(params) {
        return params.key in sim.kvs ? [{ value: sim.kvs[params.key], etag: 'e' }, 0, '']
            : [null, limits.ERR_NOT_FOUND, 'Argument \'key\', value \'' + params.key + '\' not found!'];
    }

    function kvsSet(params) {
        const isNewKey = !(params.key in sim.kvs);
        if (params.key.length > limits.KVS_KEY_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Key too long'];
        if (limits.kvsLength(String(params.value)) > limits.KVS_VALUE_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Value too long'];
        if (isNewKey && Object.keys(sim.kvs).length >= limits.KVS_KEY_COUNT_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Too many keys'];
        sim.kvs[params.key] = params.value;
        return [{ etag: 'e', rev: 1 }, 0, ''];
    }

    function virtualAdd(params) {
        const key = params.type + ':' + params.id;
        if (params.id < limits.VIRTUAL_ID_FIRST || params.id > limits.VIRTUAL_ID_LAST) return [null, limits.ERR_INVALID_ARGUMENT, 'Id out of range'];
        if (sim.components.some((component) => component.key === key)) return [null, limits.ERR_LIMIT_ASSUMED, 'Id not available'];
        if (sim.components.length >= limits.VIRTUAL_COMPONENT_LIMIT) return [null, limits.ERR_LIMIT_ASSUMED, 'Too many virtual components'];
        sim.components.push({ key, status: { value: params.config.default_value }, config: params.config });
        return [{ id: params.id }, 0, ''];
    }

    function virtualDelete(params) {
        const remaining = sim.components.filter((component) => component.key !== params.key);
        if (remaining.length === sim.components.length) return [null, limits.ERR_NOT_FOUND, 'Component not found'];
        sim.components = remaining;
        return [null, 0, ''];
    }

    function scriptCreate(params) {
        const id = Math.max(0, ...sim.scripts.map((script) => script.id)) + 1;
        sim.scripts.push({ id, name: params.name, running: false });
        return [{ id }, 0, ''];
    }

    function unixtime() {
        return Math.floor(sim.nowMs / 1000);
    }

    function rpc(method, params) {
        const p = params || {};
        switch (method.toLowerCase()) {
            case 'kvs.get': return kvsGet(p);
            case 'kvs.set': return kvsSet(p);
            case 'schedule.create': return scheduleCreate(p);
            case 'schedule.delete': return scheduleDelete(p);
            case 'schedule.update': return scheduleUpdate(p);
            case 'virtual.add': return virtualAdd(p);
            case 'virtual.delete': return virtualDelete(p);
            case 'script.create': return scriptCreate(p);
            case 'http.get': return httpGet(p);
            case 'switch.setconfig':
                Object.assign(sim.switchConfig, p.config);
                return [{ restart_required: false }, 0, ''];
            case 'shelly.getcomponents':
                return [{ components: JSON.parse(JSON.stringify(sim.components)), offset: 0, total: sim.components.length }, 0, ''];
            case 'group.set':
                sim.group = p.value;
                return [null, 0, ''];
            case 'script.list':
                return [{ scripts: sim.scripts.map((script) => Object.assign({}, script)) }, 0, ''];
            case 'script.putcode':
                sim.scriptCode[p.id] = p.code;
                return [{ len: p.code.length }, 0, ''];
            case 'script.start':
            case 'script.stop':
            case 'script.setconfig':
                return [null, 0, ''];
            default:
                return [null, limits.ERR_UNAVAILABLE, 'Method ' + method + ' not mocked'];
        }
    }

    const Shelly = {
        call(method, params, callback, userdata) {
            sim.calls.push({ method, params: params ? JSON.parse(JSON.stringify(params)) : params });
            const answer = rpc(method, params);
            if (sim.inFlight >= limits.RPC_CALL_LIMIT) {
                sim.crashed = sim.crashed || `more than ${limits.RPC_CALL_LIMIT} RPC calls in flight (${method})`;
            }
            sim.inFlight++;
            enqueue(sim.nowMs, () => {
                sim.inFlight--;
                if (typeof callback === 'function') callback(answer[0], answer[1], answer[2], userdata);
            });
        },
        getComponentStatus(type, id) {
            if (type === 'sys') return { unixtime: unixtime() };
            if (String(type).indexOf('script') === 0) return { id, running: true, mem_used: 0, mem_peak: 0 };
            return {};
        },
        getComponentConfig(type) {
            if (type === 'sys') return { location: LOCATION };
            if (String(type).indexOf('script') === 0) return { enable: true };
            return {};
        },
        getDeviceInfo() { return opts.deviceInfo; },
        getCurrentScriptId() { return opts.scriptId; },
        addStatusHandler(fn) { sim.statusHandlers.push(fn); return sim.statusHandlers.length; },
    };

    const Timer = {
        set(ms, repeat, fn, userdata) {
            const timer = { handle: ++sim.timerSeq, cleared: false };
            const fire = () => {
                if (timer.cleared) return;
                if (repeat) enqueue(sim.nowMs + ms, fire);
                else timer.cleared = true;
                fn(userdata);
            };
            enqueue(sim.nowMs + ms, fire);
            sim.timers.set(timer.handle, timer);
            const active = [...sim.timers.values()].filter((t) => !t.cleared).length;
            if (active > limits.TIMER_LIMIT) sim.crashed = sim.crashed || `more than ${limits.TIMER_LIMIT} timers active`;
            return timer.handle;
        },
        clear(handle) {
            const timer = sim.timers.get(handle);
            if (timer) timer.cleared = true;
            return !!timer;
        },
    };

    const context = vm.createContext({
        Shelly,
        Timer,
        print: log,
        console: { log },
        atob: (b64) => Buffer.from(b64, 'base64').toString('latin1'),
        __now: () => sim.nowMs,
    });
    vm.runInContext(`
        (function () {
            const RealDate = Date;
            function FakeDate() {
                if (!new.target) return new RealDate(__now()).toString();
                return arguments.length ? new RealDate(...arguments) : new RealDate(__now());
            }
            FakeDate.prototype = RealDate.prototype;
            FakeDate.now = function () { return __now(); };
            FakeDate.UTC = RealDate.UTC;
            FakeDate.parse = RealDate.parse;
            globalThis.Date = FakeDate;
            Math.random = function () { return 0; };
        })();
    `, context);

    sim.eval = (code) => vm.runInContext(code, context);
    sim.load = () => {
        const code = opts.code === null ? fs.readFileSync(opts.scriptFile, 'utf8') : opts.code;
        vm.runInContext(code, context, { filename: path.basename(opts.scriptFile) });
        return sim;
    };
    sim.runFor = (seconds) => {
        const until = sim.nowMs + seconds * 1000;
        for (let steps = 0; steps < MAX_STEPS; steps++) {
            if (sim.crashed) return sim;
            let next = null;
            for (const task of sim.tasks) {
                if (task.at <= until && (!next || task.at < next.at || (task.at === next.at && task.seq < next.seq))) next = task;
            }
            if (!next) break;
            sim.tasks.splice(sim.tasks.indexOf(next), 1);
            sim.nowMs = Math.max(sim.nowMs, next.at);
            try {
                next.fn();
            } catch (error) {
                sim.crashed = error;
                sim.logs.push('Uncaught ' + error.stack);
            }
        }
        sim.nowMs = Math.max(sim.nowMs, until);
        return sim;
    };
    sim.rpc = (method, params) => {
        let answer = null;
        Shelly.call(method, params, (result, code, message) => { answer = { result, code, message }; });
        sim.runFor(0);
        return answer;
    };
    sim.setTimer = (ms) => Timer.set(ms, false, () => {});
    sim.emitStatus = (status) => {
        for (const handler of sim.statusHandlers) handler(status);
        return sim;
    };
    sim.timespecs = () => [...sim.schedules.values()].map((job) => job.timespec).sort();
    sim.json = (key) => JSON.parse(sim.kvs[key]);
    return sim;
}

function runWatchdog(sim, code, stoppedScriptId) {
    const watchdog = createShelly({ code, now: new Date(sim.nowMs).toISOString(), scriptId: WATCHDOG_SCRIPT_ID });
    watchdog.kvs = sim.kvs;
    watchdog.schedules = sim.schedules;
    watchdog.load();
    watchdog.emitStatus({ component: 'script:' + stoppedScriptId, name: 'script', id: stoppedScriptId, delta: { id: stoppedScriptId, running: false } });
    watchdog.runFor(WATCHDOG_RUN_SECONDS);
    return watchdog;
}

module.exports = { createShelly, runWatchdog, eleringRows, ROOT, SCRIPT };
