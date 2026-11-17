'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createShelly, ROOT } = require('../harness');
const limits = require('../limits');
const {
    GEN2_DEVICE, DEVICE_LOCATION, DEVICE_DAYLIGHT_SAVING, HEATING_SCRIPT_ID, HEATING_SCRIPT_ENTRY, MILLISECONDS_PER_SECOND,
} = require('../settings');

const HEATING_SCRIPT = path.join(ROOT, 'SmartHeatingWidthShelly.js');
const SIMULATED_DEVICE = path.join(__dirname, 'shelly-device.js');
const ONE_CYCLE = path.join(__dirname, 'one-cycle.js');
const BINARY = path.join(__dirname, 'bin', 'espruino');
const CYCLE_SECONDS = 120;
const TIMEOUT_MS = 120000;
const POOL_BLOCKS = 5000;
const MARKS = { result: 'MEMRESULT', error: 'DEVICEERROR' };

function hasBinary() {
    return fs.existsSync(BINARY);
}

function runInNode(deviceOptions) {
    const sim = createShelly(deviceOptions).load().runFor(CYCLE_SECONDS);
    if (sim.crashed) throw new Error('The run in Node crashed: ' + sim.crashed);
    return sim;
}

function recordedCall(call) {
    return { method: call.method, timespec: call.params ? call.params.timespec : undefined, answer: call.answer };
}

function scenarioOf(deviceOptions, sim) {
    return {
        now: Date.parse(deviceOptions.now),
        deviceInfo: deviceOptions.deviceInfo,
        scripts: deviceOptions.scripts,
        scriptId: deviceOptions.scriptId,
        location: DEVICE_LOCATION,
        daylightSaving: DEVICE_DAYLIGHT_SAVING,
        calls: sim.calls.map(recordedCall),
        pendingTaskLimit: limits.RPC_CALL_LIMIT + limits.TIMER_LIMIT,
        runSeconds: CYCLE_SECONDS,
        millisecondsPerSecond: MILLISECONDS_PER_SECOND,
        marks: MARKS,
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
        let isTimedOut = false;
        const killTimer = setTimeout(() => {
            isTimedOut = true;
            child.kill('SIGKILL');
        }, TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (exitCode, signal) => {
            clearTimeout(killTimer);
            resolve({ output: output.replace(/\r/g, ''), exitCode, signal, isTimedOut });
        });
    });
}

function linesAfter(lines, mark) {
    return lines.filter((line) => line.startsWith(mark + ' ')).map((line) => line.slice(mark.length + 1));
}

function parse(run) {
    const lines = run.output.split('\n');
    const [resultText] = linesAfter(lines, MARKS.result);
    if (!resultText) {
        const ending = run.isTimedOut ? `was killed after ${TIMEOUT_MS} ms` : `ended with exit code ${run.exitCode} and signal ${run.signal}`;
        throw new Error(`Espruino printed no result and ${ending}:\n${run.output.slice(-2000)}`);
    }
    const result = JSON.parse(resultText);
    return {
        peakBytes: (result.peakBlocks - result.baselineBlocks) * result.blockBytes,
        retainedBytes: (result.retainedBlocks - result.baselineBlocks) * result.blockBytes,
        blockBytes: result.blockBytes,
        isPoolFull: result.peakBlocks >= POOL_BLOCKS,
        answeredCalls: result.answeredCalls,
        crashed: result.crashed,
        engineErrors: result.errors,
        deviceErrors: linesAfter(lines, MARKS.error),
        output: run.output,
    };
}

async function measure(caseOptions) {
    const deviceOptions = Object.assign({ deviceInfo: GEN2_DEVICE, scripts: [HEATING_SCRIPT_ENTRY], scriptId: HEATING_SCRIPT_ID }, caseOptions);
    const sim = runInNode(deviceOptions);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-espruino-'));
    const scenarioFile = path.join(directory, 'scenario.js');
    try {
        fs.writeFileSync(scenarioFile, 'var __scenario = ' + JSON.stringify(scenarioOf(deviceOptions, sim)) + ';\n');
        const measured = parse(await runBinary([scenarioFile, SIMULATED_DEVICE, HEATING_SCRIPT, ONE_CYCLE]));
        return Object.assign(measured, { callsInNode: sim.calls.length });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = { measure, hasBinary, BINARY };
