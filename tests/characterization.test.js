'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createShelly, runWatchdog, ROOT } = require('./harness');
const oracle = require('./oracle');
const {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
    HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, GEN3_DEVICE,
} = require('./settings');

const CYCLE_SECONDS = 120;
const FALLBACK_LOG = 'Internet error';
const OWN_COMPONENT_COUNT = 10;
const GROUP_MEMBER_COUNT = 9;
const FORECAST_OF_8_HOURS = new Array(24).fill(-4);
const FORECAST_OF_7_AND_A_HALF_HOURS = new Array(24).fill(-3);
const SWITCH_ON = [{ method: 'Switch.Set', params: { id: 0, on: true } }];

function kvsWith(conf) {
    return { SmartHeatingConf1: JSON.stringify(Object.assign({}, DEFAULT_CONF, conf)) };
}

function systemData(scheduleId) {
    return JSON.stringify({ LastCalculation: 'x', ExistingSchedule: scheduleId, Version: 4.9 });
}

function run(options) {
    const sim = createShelly(options).load().runFor(CYCLE_SECONDS);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    return sim;
}

function hourlyTimespec(hours) {
    return ['0 0 ' + hours.join(',') + ' * * *'];
}

function hasFallenBack(sim) {
    return sim.logs.some((line) => line.indexOf(FALLBACK_LOG) >= 0);
}

describe('settings in KVS', () => {
    it('writes all eleven settings on first install', () => {
        const sim = run({});
        assert.deepEqual(sim.json('SmartHeatingConf1'), DEFAULT_CONF);
    });

    it('keeps the stored settings unchanged', () => {
        const sim = run({ kvs: { SmartHeatingConf1: JSON.stringify(STORAGE_TANK_CONF) } });
        assert.deepEqual(sim.json('SmartHeatingConf1'), STORAGE_TANK_CONF);
    });

    it('stores one schedule ID and the version in SmartHeatingSys', () => {
        const sim = run({ kvs: kvsWith({}) });
        const stored = sim.json('SmartHeatingSys1');
        assert.equal(stored.ExistingSchedule, [...sim.schedules.keys()][0]);
        assert.equal(stored.Version, sim.eval('_.newV'));
    });
});

describe('heating time', () => {
    it('heats HeatingTime hours a day', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.equal(oracle.heatingMinutes(sim), 10 * 60);
    });

    for (const [period, hours] of [[12, 3], [6, 2]]) {
        it(`heats HeatingTime hours in each ${period} h period`, () => {
            const sim = run({ kvs: kvsWith({ TimePeriod: period, HeatingTime: hours }) });
            assert.equal(oracle.heatingMinutes(sim), (24 / period) * hours * 60);
        });
    }

    it('derives the heating hours from the weather forecast', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), temps: FORECAST_OF_8_HOURS });
        assert.equal(oracle.heatingMinutes(sim), 8 * 60);
        assert.ok(sim.httpRequests[0].indexOf('forecast_hours=24') > 0);
    });

    it('rounds the forecast heating time down to whole hours', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), temps: FORECAST_OF_7_AND_A_HALF_HOURS });
        assert.equal(oracle.heatingMinutes(sim), 7 * 60);
    });

    it('turns the relay off one hour and ten seconds after each start', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.deepEqual(sim.switchConfig, { auto_on: false, auto_on_delay: 3610, auto_off: true, auto_off_delay: 3610 });
        assert.deepEqual([...sim.schedules.values()][0].calls, SWITCH_ON);
    });
});

describe('hourly planning', () => {
    it('schedules the cheapest hours with one schedule', () => {
        const sim = run({ kvs: kvsWith({}) });
        const hours = oracle.cheapestHours(NORMAL_DAY.fixture, NORMAL_DAY.isoDate, 'VORK2', 10);
        assert.deepEqual(sim.timespecs(), hourlyTimespec(hours));
    });

    it('picks the cheapest hours per 12 h period', () => {
        const sim = run({ kvs: kvsWith({ TimePeriod: 12, HeatingTime: 3 }) });
        const hours = oracle.plannedHours(NORMAL_DAY.fixture, NORMAL_DAY.isoDate, {
            packageName: 'VORK2', periodHours: 12, hoursPerPeriod: 3, alwaysOnPrice: 1, alwaysOffPrice: 300,
        });
        assert.deepEqual(sim.timespecs(), hourlyTimespec(hours));
    });

    it('heats every hour whose market price is below AlwaysOnPrice without a period', () => {
        const sim = run({ kvs: kvsWith({ TimePeriod: 0, AlwaysOnPrice: 1 }), elering: NEGATIVE_DAY.fixture, now: NEGATIVE_DAY.now });
        const hours = oracle.plannedHours(NEGATIVE_DAY.fixture, NEGATIVE_DAY.isoDate, {
            packageName: 'VORK2', periodHours: 0, hoursPerPeriod: 0, alwaysOnPrice: 1, alwaysOffPrice: 300,
        });
        assert.ok(hours.length > 0);
        assert.deepEqual(sim.timespecs(), hourlyTimespec(hours));
    });

    it('does not heat when the market price is above AlwaysOffPrice', () => {
        const sim = run({ kvs: kvsWith({ AlwaysOnPrice: -20, AlwaysOffPrice: -10 }) });
        assert.equal(sim.schedules.size, 0);
    });

    it('reproduces the schedule a hot water device made on 2026-10-08', () => {
        const sim = run({ kvs: { SmartHeatingConf1: JSON.stringify(HOT_WATER_CONF) }, elering: HOT_WATER_DAY.fixture, now: HOT_WATER_DAY.now });
        assert.deepEqual(sim.timespecs(), hourlyTimespec([3, 4, 6, 7, 14, 15, 22, 23]));
    });

    it("asks Elering for tomorrow's prices in one request after 23:00", () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.deepEqual(sim.httpRequests, ['https://dashboard.elering.ee/api/nps/price/csv?fields=ee&start=2026-10-06T21:00Z&end=2026-10-07T21:00Z']);
    });

    for (const day of [SPRING_DST_DAY, AUTUMN_DST_DAY]) {
        it(`plans the daylight saving change of ${day.isoDate} without falling back`, () => {
            const sim = run({ kvs: kvsWith({}), elering: day.fixture, now: day.now });
            assert.equal(hasFallenBack(sim), false);
            assert.ok(sim.schedules.size > 0);
        });
    }
});

describe('fallback without prices or forecast', () => {
    it('heats HeatingTime hours when Elering is unreachable', () => {
        const sim = run({ kvs: kvsWith({}), httpFail: /elering/ });
        assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        assert.ok(hasFallenBack(sim));
    });

    it('uses the historically cheap hours when Elering is unreachable', () => {
        const sim = run({ kvs: kvsWith({}), httpFail: /elering/ });
        assert.deepEqual(sim.timespecs(), hourlyTimespec([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    });

    it('heats HeatingTime hours when the forecast is unreachable', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), httpFail: /open-meteo/ });
        assert.equal(oracle.heatingMinutes(sim), 10 * 60);
    });
});

describe('schedule bookkeeping', () => {
    it('deletes the previous schedule before creating a new one', () => {
        const sim = run({
            kvs: Object.assign(kvsWith({}), { SmartHeatingSys1: systemData(7) }),
            schedules: { 7: { timespec: '0 0 23 * * *', calls: SWITCH_ON } },
        });
        assert.equal(sim.schedules.has(7), false);
        assert.equal(sim.schedules.size, 1);
    });

    it('creates one new schedule when the user has deleted the stored one', () => {
        const sim = run({ kvs: Object.assign(kvsWith({}), { SmartHeatingSys1: systemData(7) }) });
        assert.ok(sim.calls.some((call) => call.method === 'Schedule.Delete' && call.params.id === 7));
        assert.equal(sim.schedules.size, 1);
        assert.equal(sim.json('SmartHeatingSys1').ExistingSchedule, [...sim.schedules.keys()][0]);
    });
});

describe('watchdog', () => {
    it('creates and starts a watchdog script', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.ok(sim.calls.some((call) => call.method === 'Script.Create' && call.params.name === 'watchdog'));
        assert.ok(sim.calls.some((call) => call.method === 'Script.Start' && call.params.id === WATCHDOG_SCRIPT_ID));
    });

    it('installs the code of files/watchdog-min.js', () => {
        const sim = run({ kvs: kvsWith({}) });
        const expected = fs.readFileSync(path.join(ROOT, 'files', 'watchdog-min.js'), 'utf8').trim();
        assert.equal(sim.scriptCode[WATCHDOG_SCRIPT_ID], expected);
    });

    it('deletes the schedule when the heating script stops', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.equal(sim.schedules.size, 1);
        const watchdog = runWatchdog(sim, sim.scriptCode[WATCHDOG_SCRIPT_ID], HEATING_SCRIPT_ID);
        assert.equal(watchdog.crashed, null, watchdog.logs.join('\n'));
        assert.equal(sim.schedules.size, 0);
        assert.equal(sim.json('SmartHeatingSys1').ExistingSchedule, 0);
    });
});

describe('Virtual Component mode', () => {
    const virtualComponents = (values) => Object.keys(values).map((key) => ({ key, status: { value: values[key] }, config: {} }));
    const PERIOD_OF_12_HOURS = {
        'enum:200': '12', 'number:200': 3, 'boolean:200': false, 'enum:201': 'VORK2', 'number:201': 1,
        'number:202': 300, 'boolean:201': false, 'enum:202': 'ee', 'number:203': 0,
    };
    const FOREIGN_COMPONENTS = virtualComponents({ 'boolean:210': true, 'number:250': 21 });

    it('installs ten components and the group on a fresh device', () => {
        const sim = run({ deviceInfo: GEN3_DEVICE });
        assert.equal(sim.components.length, OWN_COMPONENT_COUNT);
        assert.equal(sim.group.length, GROUP_MEMBER_COUNT);
        assert.equal(sim.schedules.size, 1);
    });

    it('deletes every component already on the device before a clean install', () => {
        const sim = run({ deviceInfo: GEN3_DEVICE, components: FOREIGN_COMPONENTS });
        assert.equal(sim.components.length, OWN_COMPONENT_COUNT);
        for (const foreign of FOREIGN_COMPONENTS) {
            assert.equal(sim.components.some((component) => component.key === foreign.key), false);
        }
        assert.equal(sim.logs.some((line) => line.indexOf('is not added') >= 0), false);
    });

    it('plans from the component values of an existing installation', () => {
        const sim = run({ deviceInfo: GEN3_DEVICE, kvs: { SmartHeatingSys1: systemData(0) }, components: virtualComponents(PERIOD_OF_12_HOURS) });
        const hours = oracle.plannedHours(NORMAL_DAY.fixture, NORMAL_DAY.isoDate, {
            packageName: 'VORK2', periodHours: 12, hoursPerPeriod: 3, alwaysOnPrice: 1, alwaysOffPrice: 300,
        });
        assert.deepEqual(sim.timespecs(), hourlyTimespec(hours));
        assert.equal(sim.calls.some((call) => call.method === 'Virtual.Delete'), false);
    });
});

describe('network fee', () => {
    function feeAt(provider, packageName, isoTime) {
        const sim = createShelly({ now: isoTime }).load();
        sim.eval(`_.prov = "${provider}"; c.pack = pack().${packageName};`);
        return sim.eval(`fFee(${Date.parse(isoTime) / 1000})`);
    }

    const ELEKTRILEVI_CASES = [
        ['winter weekday morning peak', '2026-01-14T10:00:00+02:00', 'VORK5', 81.8],
        ['winter weekday evening peak', '2026-01-14T17:00:00+02:00', 'VORK5', 81.8],
        ['winter weekend evening peak', '2026-01-17T17:00:00+02:00', 'VORK5', 47.4],
        ['winter weekday day', '2026-01-14T13:00:00+02:00', 'VORK5', 52.9],
        ['winter weekday before the morning peak', '2026-01-14T08:45:00+02:00', 'VORK5', 52.9],
        ['winter weekday after the morning peak', '2026-01-14T12:00:00+02:00', 'VORK5', 52.9],
        ['winter weekday after the evening peak', '2026-01-14T20:00:00+02:00', 'VORK5', 52.9],
        ['winter weekend after the evening peak', '2026-01-17T20:00:00+02:00', 'VORK5', 30.3],
        ['winter weekday night', '2026-01-14T23:00:00+02:00', 'VORK5', 30.3],
        ['summer weekday day', '2026-06-10T10:00:00+03:00', 'VORK2', 60.7],
        ['summer weekday early morning', '2026-06-10T06:45:00+03:00', 'VORK2', 35.1],
        ['summer weekday first day hour', '2026-06-10T07:00:00+03:00', 'VORK2', 60.7],
        ['summer weekday first night hour', '2026-06-10T22:00:00+03:00', 'VORK2', 35.1],
        ['summer weekend day', '2026-06-13T12:00:00+03:00', 'VORK4', 21],
    ];
    for (const [name, isoTime, packageName, fee] of ELEKTRILEVI_CASES) {
        it(`Elektrilevi ${name}`, () => {
            assert.equal(feeAt('Elektlevi', packageName, isoTime), fee);
            assert.equal(oracle.elektrileviFee(Date.parse(isoTime) / 1000, packageName), fee);
        });
    }

    const IMATRA_CASES = [
        ['summer weekday before 8 is night', '2026-06-10T07:30:00+03:00', 42],
        ['summer weekday day', '2026-06-10T08:30:00+03:00', 72.4],
        ['summer weekend is night', '2026-06-13T12:00:00+03:00', 42],
        ['winter weekday evening is day until 23', '2026-01-14T22:30:00+02:00', 72.4],
        ['winter weekday night', '2026-01-14T23:30:00+02:00', 42],
    ];
    for (const [name, isoTime, fee] of IMATRA_CASES) {
        it(`Imatra ${name}`, () => {
            assert.equal(feeAt('Imatra', 'PARTN12', isoTime), fee);
        });
    }

    it('Latvia has one rate', () => {
        assert.equal(feeAt('Lv', 'PAMATA1', '2026-01-14T23:30:00+02:00'), 39.62);
    });
});
