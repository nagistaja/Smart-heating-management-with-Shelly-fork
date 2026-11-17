'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { measure, hasBinary, BINARY } = require('./engine');
const {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
} = require('../settings');

const DEVICE_BLOCK_BYTES = 14;
const DEFAULT_SETTINGS = { name: 'default settings', conf: DEFAULT_CONF };
const STORAGE_TANK = { name: 'storage tank with forecast', conf: STORAGE_TANK_CONF };
const HOT_WATER = { name: 'hot water in 6 h periods', conf: HOT_WATER_CONF };
const VERSION_4_9 = [
    { settings: DEFAULT_SETTINGS, day: NORMAL_DAY, peakBytes: 15736, retainedBytes: 3948 },
    { settings: DEFAULT_SETTINGS, day: HOT_WATER_DAY, peakBytes: 16072, retainedBytes: 3948 },
    { settings: DEFAULT_SETTINGS, day: NEGATIVE_DAY, peakBytes: 15652, retainedBytes: 3948 },
    { settings: DEFAULT_SETTINGS, day: SPRING_DST_DAY, peakBytes: 15932, retainedBytes: 3948 },
    { settings: DEFAULT_SETTINGS, day: AUTUMN_DST_DAY, peakBytes: 15890, retainedBytes: 3948 },
    { settings: STORAGE_TANK, day: NORMAL_DAY, peakBytes: 15722, retainedBytes: 3934 },
    { settings: STORAGE_TANK, day: HOT_WATER_DAY, peakBytes: 16058, retainedBytes: 3934 },
    { settings: STORAGE_TANK, day: NEGATIVE_DAY, peakBytes: 15638, retainedBytes: 3934 },
    { settings: STORAGE_TANK, day: SPRING_DST_DAY, peakBytes: 15918, retainedBytes: 3934 },
    { settings: STORAGE_TANK, day: AUTUMN_DST_DAY, peakBytes: 15876, retainedBytes: 3934 },
    { settings: HOT_WATER, day: NORMAL_DAY, peakBytes: 15708, retainedBytes: 3920 },
    { settings: HOT_WATER, day: HOT_WATER_DAY, peakBytes: 16044, retainedBytes: 3920 },
    { settings: HOT_WATER, day: NEGATIVE_DAY, peakBytes: 15624, retainedBytes: 3920 },
    { settings: HOT_WATER, day: SPRING_DST_DAY, peakBytes: 15904, retainedBytes: 3920 },
    { settings: HOT_WATER, day: AUTUMN_DST_DAY, peakBytes: 15862, retainedBytes: 3920 },
];

const EMPTY_FUNCTION = 'function tick() {}';
const ONE_TIMER = ' Timer.set(1000, false, tick);';
const ONE_PENDING_TIMER = ' Timer.set(3600000, false, tick);';
const ONE_RPC_ANSWER = " Shelly.call('KVS.Get', { key: 'missing' }, tick);";
const EMPTY_FUNCTION_RETAINED_BYTES = 126;
const SCRIPTS_THAT_KEEP_NO_MORE = [
    ['five timers that have fired', EMPTY_FUNCTION + ONE_TIMER.repeat(5)],
    ['three pending timers', EMPTY_FUNCTION + ONE_PENDING_TIMER.repeat(3)],
    ['three RPC answers', EMPTY_FUNCTION + ONE_RPC_ANSWER.repeat(3)],
];
const OWN_SHARE = { code: EMPTY_FUNCTION + ONE_TIMER + ONE_RPC_ANSWER, peakBytes: 532, retainedBytes: 126 };
const IN_NODE = "typeof process === 'undefined'";
const ANOTHER_CALL = `Shelly.call(${IN_NODE} ? 'KVS.Get' : 'Script.List', { key: 'missing' }, function () {});`;
const ANOTHER_KEY = `Shelly.call('KVS.Get', { key: ${IN_NODE} ? 'in Node' : 'in Espruino' }, function () {});`;

function assertSameRunAsInNode(measured) {
    assert.equal(measured.crashed, null, measured.output);
    assert.deepEqual(measured.differencesFromNode, [], measured.output);
    assert.deepEqual(measured.engineErrors, [], measured.output);
    assert.equal(measured.isPoolFull, false, 'Espruino ran out of the memory the test gives it');
    assert.equal(measured.callCount, measured.callsInNode, 'another number of RPC calls than in Node');
    assert.equal(measured.readCount, measured.readsInNode, 'another number of status and configuration reads than in Node');
    assert.equal(measured.blockBytes, DEVICE_BLOCK_BYTES, 'this Espruino is not the 32-bit build of build-espruino.sh');
}

before(() => {
    assert.ok(hasBinary(), `No Espruino at ${BINARY}, build it with tests/espruino/build-espruino.sh`);
});

describe('memory of version 4.9 in Espruino', { concurrency: true }, () => {
    for (const { settings, day, peakBytes, retainedBytes } of VERSION_4_9) {
        it(`${settings.name}, prices of ${day.fixture}`, async (test) => {
            const measured = await measure({ now: day.now, elering: day.fixture, kvs: { SmartHeatingConf1: JSON.stringify(settings.conf) } });
            test.diagnostic(`peak ${measured.peakBytes} B, retained ${measured.retainedBytes} B`);
            assertSameRunAsInNode(measured);
            assert.equal(measured.peakBytes, peakBytes, 'peak');
            assert.equal(measured.retainedBytes, retainedBytes, 'retained');
        });
    }
});

describe('the simulated device in Espruino', { concurrency: true }, () => {
    it('measures an empty function', async () => {
        const measured = await measure({ code: EMPTY_FUNCTION });
        assertSameRunAsInNode(measured);
        assert.equal(measured.retainedBytes, EMPTY_FUNCTION_RETAINED_BYTES);
    });

    for (const [name, code] of SCRIPTS_THAT_KEEP_NO_MORE) {
        it(`adds nothing to what an empty function retains for ${name}`, async () => {
            const measured = await measure({ code });
            assertSameRunAsInNode(measured);
            assert.equal(measured.retainedBytes, EMPTY_FUNCTION_RETAINED_BYTES);
        });
    }

    it('adds its own share to a script with one timer and one RPC answer', async () => {
        const measured = await measure({ code: OWN_SHARE.code });
        assertSameRunAsInNode(measured);
        assert.equal(measured.peakBytes, OWN_SHARE.peakBytes, 'peak');
        assert.equal(measured.retainedBytes, OWN_SHARE.retainedBytes, 'retained');
    });

    it('reports an RPC call that is another one than in Node', async () => {
        const measured = await measure({ code: ANOTHER_CALL });
        assert.match(measured.differencesFromNode.join('\n'), /is Script\.List, in Node it was KVS\.Get/);
    });

    it('reports RPC parameters that differ from Node', async () => {
        const measured = await measure({ code: ANOTHER_KEY });
        assert.match(measured.differencesFromNode.join('\n'), /KVS\.Get with .*in Espruino.*in Node with .*in Node/);
    });
});
