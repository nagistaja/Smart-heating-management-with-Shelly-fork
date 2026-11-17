'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { measure, hasBinary, BINARY } = require('./engine');
const {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
} = require('../settings');

const DEVICE_BLOCK_BYTES = 14;
const CASES = [
    ['default settings', DEFAULT_CONF, NORMAL_DAY, 15736, 3976],
    ['default settings', DEFAULT_CONF, HOT_WATER_DAY, 16072, 3976],
    ['default settings', DEFAULT_CONF, NEGATIVE_DAY, 15652, 3976],
    ['default settings', DEFAULT_CONF, SPRING_DST_DAY, 15932, 3976],
    ['default settings', DEFAULT_CONF, AUTUMN_DST_DAY, 15890, 3976],
    ['storage tank with forecast', STORAGE_TANK_CONF, NORMAL_DAY, 15722, 3962],
    ['storage tank with forecast', STORAGE_TANK_CONF, HOT_WATER_DAY, 16058, 3962],
    ['storage tank with forecast', STORAGE_TANK_CONF, NEGATIVE_DAY, 15638, 3962],
    ['storage tank with forecast', STORAGE_TANK_CONF, SPRING_DST_DAY, 15918, 3962],
    ['storage tank with forecast', STORAGE_TANK_CONF, AUTUMN_DST_DAY, 15876, 3962],
    ['hot water in 6 h periods', HOT_WATER_CONF, NORMAL_DAY, 15708, 3948],
    ['hot water in 6 h periods', HOT_WATER_CONF, HOT_WATER_DAY, 16044, 3948],
    ['hot water in 6 h periods', HOT_WATER_CONF, NEGATIVE_DAY, 15624, 3948],
    ['hot water in 6 h periods', HOT_WATER_CONF, SPRING_DST_DAY, 15904, 3948],
    ['hot water in 6 h periods', HOT_WATER_CONF, AUTUMN_DST_DAY, 15862, 3948],
];

describe('script memory in Espruino', { concurrency: true }, () => {
    before(() => {
        assert.ok(hasBinary(), `No Espruino at ${BINARY}, build it with tests/espruino/build-espruino.sh`);
    });

    for (const [settingsName, conf, day, peakBytes, retainedBytes] of CASES) {
        it(`${settingsName}, prices of ${day.fixture}`, async (test) => {
            const measured = await measure({ now: day.now, elering: day.fixture, kvs: { SmartHeatingConf1: JSON.stringify(conf) } });
            test.diagnostic(`peak ${measured.peakBytes} B, retained ${measured.retainedBytes} B`);
            assert.equal(measured.crashed, null, measured.output);
            assert.deepEqual(measured.deviceErrors, [], measured.output);
            assert.deepEqual(measured.engineErrors, []);
            assert.equal(measured.isPoolFull, false);
            assert.equal(measured.answeredCalls, measured.callsInNode, 'the script made other RPC calls in Espruino than in Node');
            assert.equal(measured.blockBytes, DEVICE_BLOCK_BYTES, 'this Espruino is not the 32-bit build of build-espruino.sh');
            assert.equal(measured.peakBytes, peakBytes, 'peak');
            assert.equal(measured.retainedBytes, retainedBytes, 'retained');
        });
    }
});
