'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createShelly, ROOT } = require('../harness');
const limits = require('../limits');
const { GEN2_DEVICE, DEVICE_LOCATION, HEATING_SCRIPT_ID, HEATING_SCRIPT_ENTRY } = require('../settings');

const HEATING_SCRIPT = path.join(ROOT, 'SmartHeatingWidthShelly.js');
const SIMULATED_DEVICE = path.join(__dirname, 'shelly-device.js');
const ONE_CYCLE = path.join(__dirname, 'one-cycle.js');
const BINARY = path.join(__dirname, 'bin', 'espruino');
const CYCLE_SECONDS = 120;
const TIMEOUT_MS = 120000;
const POOL_BLOCKS = 5000;
const RESULT_MARK = 'MEMRESULT ';
const SCHEDULE_MARK = 'MOCK schedule.create ';
const ERROR_MARK = 'MOCKERR';

function hasBinary() {
    return fs.existsSync(BINARY);
}

function runInNode(deviceOptions) {
    const sim = createShelly(deviceOptions).load().runFor(CYCLE_SECONDS);
    if (sim.crashed) throw new Error('The run in Node crashed: ' + sim.crashed);
    return sim;
}

function scenarioOf(deviceOptions, sim) {
    return {
        now: Date.parse(deviceOptions.now),
        kvs: deviceOptions.kvs,
        http: sim.httpAnswers,
        deviceInfo: GEN2_DEVICE,
        location: DEVICE_LOCATION,
        scriptId: HEATING_SCRIPT_ID,
        scripts: [HEATING_SCRIPT_ENTRY],
        runSeconds: CYCLE_SECONDS,
        limits: {
            schedules: limits.SCHEDULE_LIMIT,
            scheduleCalls: limits.SCHEDULE_CALL_LIMIT,
            errInvalidArgument: limits.ERR_INVALID_ARGUMENT,
            errNotFound: limits.ERR_NOT_FOUND,
            errResourceExhausted: limits.ERR_RESOURCE_EXHAUSTED,
            errAssumed: limits.ERR_ASSUMED,
        },
    };
}

// stdin stays open: at end of input the Espruino console reads junk into its input line, which lives in the measured pool
function runBinary(files) {
    return new Promise((resolve, reject) => {
        const child = spawn(BINARY, files, {
            env: Object.assign({}, process.env, { ESPRUINO_VARS: String(POOL_BLOCKS) }),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        const killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', () => {
            clearTimeout(killTimer);
            resolve(output.replace(/\r/g, ''));
        });
    });
}

function linesAfter(lines, mark) {
    return lines.filter((line) => line.startsWith(mark)).map((line) => line.slice(mark.length));
}

function parse(output) {
    const lines = output.split('\n');
    const [resultText] = linesAfter(lines, RESULT_MARK);
    if (!resultText) throw new Error('Espruino printed no result:\n' + output.slice(-2000));
    const result = JSON.parse(resultText);
    return {
        peakBytes: (result.peakBlocks - result.baselineBlocks) * result.blockBytes,
        retainedBytes: (result.retainedBlocks - result.baselineBlocks) * result.blockBytes,
        blockBytes: result.blockBytes,
        isPoolFull: result.peakBlocks >= POOL_BLOCKS,
        crashed: result.crashed,
        engineErrors: result.errors,
        deviceErrors: lines.filter((line) => line.startsWith(ERROR_MARK)),
        timespecs: linesAfter(lines, SCHEDULE_MARK).map((text) => JSON.parse(text).timespec),
        output,
    };
}

async function measure(deviceOptions) {
    const sim = runInNode(deviceOptions);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-espruino-'));
    const scenarioFile = path.join(directory, 'scenario.js');
    try {
        fs.writeFileSync(scenarioFile, 'var __scenario = ' + JSON.stringify(scenarioOf(deviceOptions, sim)) + ';\n');
        const measured = parse(await runBinary([scenarioFile, SIMULATED_DEVICE, HEATING_SCRIPT, ONE_CYCLE]));
        return Object.assign(measured, { timespecsInNode: sim.timespecs() });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = { measure, hasBinary, BINARY };
