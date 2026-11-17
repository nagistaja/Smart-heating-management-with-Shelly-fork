'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { measure, hasBinary, BINARY } = require('./engine');
const {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
} = require('../settings');

const HIGHEST_PEAK_BYTES = 17430;
const HIGHEST_RETAINED_BYTES = 4536;
const SETTINGS = [
    ['default settings', DEFAULT_CONF],
    ['storage tank with forecast', STORAGE_TANK_CONF],
    ['hot water in 6 h periods', HOT_WATER_CONF],
];
const DAYS = [NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY];

describe('script memory in Espruino', { concurrency: true }, () => {
    before(() => {
        assert.ok(hasBinary(), `No Espruino at ${BINARY}, build it with tests/espruino/build-espruino.sh`);
    });

    for (const [settingsName, conf] of SETTINGS) {
        for (const day of DAYS) {
            it(`${settingsName}, prices of ${day.fixture}`, async (test) => {
                const measured = await measure({ now: day.now, elering: day.fixture, kvs: { SmartHeatingConf1: JSON.stringify(conf) } });
                test.diagnostic(`peak ${measured.peakBytes} B, retained ${measured.retainedBytes} B, block ${measured.blockBytes} B`);
                assert.equal(measured.crashed, null, measured.output);
                assert.deepEqual(measured.deviceErrors, [], measured.output);
                assert.deepEqual(measured.engineErrors, []);
                assert.equal(measured.isPoolFull, false);
                assert.deepEqual(measured.timespecs.slice().sort(), measured.timespecsInNode);
                assert.ok(measured.peakBytes <= HIGHEST_PEAK_BYTES, `peak ${measured.peakBytes} B`);
                assert.ok(measured.retainedBytes <= HIGHEST_RETAINED_BYTES, `retained ${measured.retainedBytes} B`);
            });
        }
    }
});
