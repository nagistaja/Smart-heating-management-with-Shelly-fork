'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createShelly, runWatchdog, ROOT } = require('./harness');
const oracle = require('./oracle');
const {
    SCRIPT_VERSION, DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
    HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, GEN3_DEVICE,
} = require('./settings');

const CYCLE_SECONDS = 120;
const MINUTES_PER_HOUR = 60;
const HOUR_AND_OVERLAP_SECONDS = 3610;
const FALLBACK_LOG = 'Internet error';
const GROUP_MEMBER_COUNT = 9;
const OWN_COMPONENT_COUNT = GROUP_MEMBER_COUNT + 1;
const FORECAST_OF_8_HOURS = new Array(24).fill(-4);
const FORECAST_OF_7_AND_A_HALF_HOURS = new Array(24).fill(-3);
const SWITCH_ON = [{ method: 'Switch.Set', params: { id: 0, on: true } }];
const SWITCH_OFF = [{ method: 'Switch.Set', params: { id: 0, on: false } }];
const HISTORICALLY_CHEAP_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MIDDAY_OF_NORMAL_DAY = '2026-10-07T12:00:00+03:00';
const PRICES_OF_NORMAL_DAY = 'https://dashboard.elering.ee/api/nps/price/csv?fields=ee&start=2026-10-06T21:00Z&end=2026-10-07T21:00Z';
const RUNNING_WATCHDOG = { id: WATCHDOG_SCRIPT_ID, name: 'watchdog', running: true, enable: true };
const HEATING_SCRIPT_ENTRY = { id: HEATING_SCRIPT_ID, name: 'Smart Heating', running: true, enable: true };

function kvsWith(conf) {
    return { SmartHeatingConf1: JSON.stringify(Object.assign({}, DEFAULT_CONF, conf)) };
}

function systemData(scheduleId) {
    return JSON.stringify({ LastCalculation: 'x', ExistingSchedule: scheduleId, Version: SCRIPT_VERSION });
}

function run(options) {
    const sim = createShelly(options).load().runFor(CYCLE_SECONDS);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    return sim;
}

function hourlyTimespec(hours) {
    return ['0 0 ' + hours.join(',') + ' * * *'];
}

function expectedTimespec(day, conf) {
    const settings = Object.assign({}, DEFAULT_CONF, conf);
    return hourlyTimespec(oracle.plannedHours(day.fixture, day.isoDate, {
        packageName: settings.EnergyProvider,
        periodHours: settings.TimePeriod,
        hoursPerPeriod: Math.min(settings.HeatingTime, settings.TimePeriod),
        alwaysOnPrice: settings.AlwaysOnPrice,
        alwaysOffPrice: settings.AlwaysOffPrice,
    }));
}

function hasFallenBack(sim) {
    return sim.logs.some((line) => line.indexOf(FALLBACK_LOG) >= 0);
}

function callIndex(sim, method) {
    return sim.calls.findIndex((call) => call.method === method);
}

function hasCalled(sim, method, id) {
    return sim.calls.some((call) => call.method === method && call.params.id === id);
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
        assert.equal(stored.Version, SCRIPT_VERSION);
    });
});

describe('heating time', () => {
    it('heats HeatingTime hours a day', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.equal(sim.heatingMinutes(), DEFAULT_CONF.HeatingTime * MINUTES_PER_HOUR);
    });

    for (const [period, hours] of [[12, 3], [6, 2]]) {
        it(`heats HeatingTime hours in each ${period} h period`, () => {
            const sim = run({ kvs: kvsWith({ TimePeriod: period, HeatingTime: hours }) });
            assert.equal(sim.heatingMinutes(), (24 / period) * hours * MINUTES_PER_HOUR);
        });
    }

    it('derives the heating hours from the weather forecast', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), temps: FORECAST_OF_8_HOURS });
        assert.equal(sim.heatingMinutes(), 8 * MINUTES_PER_HOUR);
        assert.ok(sim.httpRequests[0].indexOf('forecast_hours=24') > 0);
    });

    it('rounds the forecast heating time down to whole hours', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), temps: FORECAST_OF_7_AND_A_HALF_HOURS });
        assert.equal(sim.heatingMinutes(), 7 * MINUTES_PER_HOUR);
    });
});

describe('relay', () => {
    it('is switched on by the schedule and off one hour and ten seconds later', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.deepEqual(sim.switchConfig, {
            auto_on: false, auto_on_delay: HOUR_AND_OVERLAP_SECONDS, auto_off: true, auto_off_delay: HOUR_AND_OVERLAP_SECONDS,
        });
        assert.deepEqual([...sim.schedules.values()][0].calls, SWITCH_ON);
    });

    it('is switched off by the schedule and on again later with InvertedRelay', () => {
        const sim = run({ kvs: kvsWith({ InvertedRelay: true }) });
        assert.deepEqual(sim.switchConfig, {
            auto_on: true, auto_on_delay: HOUR_AND_OVERLAP_SECONDS, auto_off: false, auto_off_delay: HOUR_AND_OVERLAP_SECONDS,
        });
        assert.deepEqual([...sim.schedules.values()][0].calls, SWITCH_OFF);
    });
});

describe('hourly planning', () => {
    it('schedules the cheapest hours with one schedule', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.deepEqual(sim.timespecs(), expectedTimespec(NORMAL_DAY, {}));
    });

    it('picks the cheapest hours per 12 h period', () => {
        const conf = { TimePeriod: 12, HeatingTime: 3 };
        const sim = run({ kvs: kvsWith(conf) });
        assert.deepEqual(sim.timespecs(), expectedTimespec(NORMAL_DAY, conf));
    });

    it('heats every hour whose market price is below AlwaysOnPrice without a period', () => {
        const conf = { TimePeriod: 0, AlwaysOnPrice: 1 };
        const sim = run({ kvs: kvsWith(conf), elering: NEGATIVE_DAY.fixture, now: NEGATIVE_DAY.now });
        assert.equal(sim.schedules.size, 1);
        assert.deepEqual(sim.timespecs(), expectedTimespec(NEGATIVE_DAY, conf));
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
        assert.deepEqual(sim.httpRequests, [PRICES_OF_NORMAL_DAY]);
    });

    it("asks Elering for today's prices when started during the day", () => {
        const sim = run({ kvs: kvsWith({}), now: MIDDAY_OF_NORMAL_DAY });
        assert.deepEqual(sim.httpRequests, [PRICES_OF_NORMAL_DAY]);
        assert.deepEqual(sim.timespecs(), expectedTimespec(NORMAL_DAY, {}));
    });

    it('plans the 25 hour day 2025-10-26', () => {
        const sim = run({ kvs: kvsWith({}), elering: AUTUMN_DST_DAY.fixture, now: AUTUMN_DST_DAY.now });
        assert.equal(hasFallenBack(sim), false);
        assert.deepEqual(sim.timespecs(), hourlyTimespec([0, 1, 2, 3, 4, 11, 12, 13, 14, 23]));
    });

    it('plans the 23 hour day 2026-03-29 with hour 0 of the next day among the ten', () => {
        const sim = run({ kvs: kvsWith({}), elering: SPRING_DST_DAY.fixture, now: SPRING_DST_DAY.now });
        assert.equal(hasFallenBack(sim), false);
        assert.deepEqual(sim.timespecs(), hourlyTimespec([0, 8, 9, 10, 12, 13, 14, 15, 16, 17]));
    });
});

describe('fallback without prices or forecast', () => {
    it('heats HeatingTime hours when Elering is unreachable', () => {
        const sim = run({ kvs: kvsWith({}), httpFail: /elering/ });
        assert.equal(sim.heatingMinutes(), DEFAULT_CONF.HeatingTime * MINUTES_PER_HOUR);
        assert.ok(hasFallenBack(sim));
    });

    it('uses the historically cheap hours when Elering is unreachable', () => {
        const sim = run({ kvs: kvsWith({}), httpFail: /elering/ });
        assert.deepEqual(sim.timespecs(), hourlyTimespec(HISTORICALLY_CHEAP_HOURS));
    });

    it('heats HeatingTime hours when the forecast is unreachable', () => {
        const sim = run({ kvs: kvsWith({ IsForecastUsed: true }), httpFail: /open-meteo/ });
        assert.equal(sim.heatingMinutes(), DEFAULT_CONF.HeatingTime * MINUTES_PER_HOUR);
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
        assert.ok(callIndex(sim, 'Schedule.Delete') < callIndex(sim, 'Schedule.Create'));
    });

    it('creates one new schedule when the user has deleted the stored one', () => {
        const sim = run({ kvs: Object.assign(kvsWith({}), { SmartHeatingSys1: systemData(7) }) });
        assert.ok(hasCalled(sim, 'Schedule.Delete', 7));
        assert.equal(sim.schedules.size, 1);
        assert.equal(sim.json('SmartHeatingSys1').ExistingSchedule, [...sim.schedules.keys()][0]);
    });
});

describe('watchdog', () => {
    it('creates a watchdog script, enables its autostart and starts it', () => {
        const sim = run({ kvs: kvsWith({}) });
        assert.ok(sim.calls.some((call) => call.method === 'Script.Create' && call.params.name === 'watchdog'));
        assert.ok(hasCalled(sim, 'Script.SetConfig', WATCHDOG_SCRIPT_ID));
        assert.ok(hasCalled(sim, 'Script.Start', WATCHDOG_SCRIPT_ID));
    });

    it('stops and rewrites an existing watchdog instead of creating a second one', () => {
        const sim = run({ kvs: kvsWith({}), scripts: [HEATING_SCRIPT_ENTRY, RUNNING_WATCHDOG] });
        assert.equal(callIndex(sim, 'Script.Create'), -1);
        assert.ok(hasCalled(sim, 'Script.Stop', WATCHDOG_SCRIPT_ID));
        assert.ok(hasCalled(sim, 'Script.PutCode', WATCHDOG_SCRIPT_ID));
        assert.ok(hasCalled(sim, 'Script.Start', WATCHDOG_SCRIPT_ID));
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

    it('installs nine components and their group, ten in all, on a fresh device', () => {
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
        assert.deepEqual(sim.timespecs(), expectedTimespec(NORMAL_DAY, { TimePeriod: 12, HeatingTime: 3 }));
        assert.equal(callIndex(sim, 'Virtual.Delete'), -1);
    });
});

describe('network fee', () => {
    function feeAt(provider, packageName, pricedTime, clockTime) {
        const sim = createShelly({ now: clockTime || pricedTime }).load();
        sim.eval(`_.prov = "${provider}"; c.pack = pack().${packageName};`);
        return sim.eval(`fFee(${Date.parse(pricedTime) / 1000})`);
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
    for (const [name, pricedTime, packageName, fee] of ELEKTRILEVI_CASES) {
        it(`Elektrilevi ${name}`, () => {
            assert.equal(feeAt('Elektlevi', packageName, pricedTime), fee);
            assert.equal(oracle.elektrileviFee(Date.parse(pricedTime) / 1000, packageName), fee);
        });
    }

    const WINTER_SATURDAY_MORNING = '2026-01-17T10:00:00+02:00';
    for (const [packageName, weekdayPeakRate] of [['VORK5', 81.8], ['VORK2', 60.7]]) {
        it(`Elektrilevi ${packageName} charges a winter weekend morning at the weekday peak rate`, () => {
            assert.equal(feeAt('Elektlevi', packageName, WINTER_SATURDAY_MORNING), weekdayPeakRate);
        });
    }

    const IMATRA_CASES = [
        ['summer weekday before 8 is night', '2026-06-10T07:30:00+03:00', 42],
        ['summer weekday day', '2026-06-10T08:30:00+03:00', 72.4],
        ['summer weekend is night', '2026-06-13T12:00:00+03:00', 42],
        ['winter weekday evening is day until 23', '2026-01-14T22:30:00+02:00', 72.4],
        ['winter weekday night', '2026-01-14T23:30:00+02:00', 42],
    ];
    for (const [name, pricedTime, fee] of IMATRA_CASES) {
        it(`Imatra ${name}`, () => {
            assert.equal(feeAt('Imatra', 'PARTN12', pricedTime), fee);
        });
    }

    it('Imatra takes summer or winter hours from the clock, not from the priced hour', () => {
        const summerMondayBefore8 = '2026-03-30T07:30:00+03:00';
        const winterEveningBeforeTheChange = '2026-03-28T23:20:00+02:00';
        assert.equal(feeAt('Imatra', 'PARTN12', summerMondayBefore8), 42);
        assert.equal(feeAt('Imatra', 'PARTN12', summerMondayBefore8, winterEveningBeforeTheChange), 72.4);
    });

    it('Latvia has one rate', () => {
        assert.equal(feeAt('Lv', 'PAMATA1', '2026-01-14T23:30:00+02:00'), 39.62);
    });
});
