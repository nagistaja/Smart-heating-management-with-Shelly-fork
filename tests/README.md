# Tests

The tests run `SmartHeatingWidthShelly.js` unchanged in Node, against a simulated Shelly device. Nothing here is loaded to a device.

```
npm test
```

Node 22 or newer, no dependencies. `npm test` sets `TZ=Europe/Tallinn`, because the script plans by the local time of the device.

## Files

| File | What it is |
|---|---|
| `characterization.test.js` | The behaviour of the script as it is today: settings in KVS, heating time, hourly planning, fallback, schedule bookkeeping, watchdog, Virtual Component mode, network fees. |
| `harness.test.js` | Checks that the simulated device enforces the limits listed below. |
| `harness.js` | The simulated device: `Shelly.call`, `Timer`, KVS, schedules, virtual components, a fake clock and HTTP answers from `fixtures/`. |
| `limits.js` | Device limits and RPC error codes used by the simulation. |
| `oracle.js` | Expected results calculated straight from the price file, without the code of the script. |
| `settings.js` | Configurations, days and device types shared by the tests. |
| `fixtures/` | Elering price answers (15 minute prices, `fields=ee`) and an Open-Meteo forecast, downloaded from the real services. |

## Options of `createShelly`

| Option | Meaning |
|---|---|
| `now` | ISO time of the device clock at start |
| `kvs` | KVS content at start, `{ key: stringValue }` |
| `schedules` | Schedules at start, `{ id: { timespec, calls } }` |
| `components` | Virtual components at start, `[{ key, status: { value }, config }]` |
| `elering` | Price fixture, or `null` for an answer without rows |
| `temps` | Forecast temperatures instead of the fixture |
| `httpFail` | RegExp of URLs whose `HTTP.GET` fails |
| `deviceInfo` | Result of `Shelly.getDeviceInfo()` |
| `scripts`, `scriptId` | `Script.List` content and the ID of the running script |
| `scriptFile`, `code` | Another script file, or source text, to run |

## What the simulated device enforces

| Limit or behaviour | Value | Source |
|---|---|---|
| RPC calls in flight per script | 5 | Shelly docs, Script Language Reference, Resource Limits |
| Active timers per script | 5 | Shelly docs, Script Language Reference, Resource Limits |
| Schedules per device | 20 | Shelly docs, Schedule |
| Calls in one schedule | 5 | Shelly docs, Schedule |
| Virtual components per device, the group included | 10 | Shelly docs, Virtual: "a limit of 10 instances per device". That the group counts is taken from the discussion of pull request #11, not measured. |
| Virtual component ID | 200 to 299, each once | Shelly docs, Virtual |
| KVS value | 253 bytes, every `"` counted twice | Shelly docs, KVS, for 253. The double count was measured on a Shelly Plus 1PM. |
| KVS key | 42 characters | Shelly docs, KVS |
| KVS keys per device | 50 | Shelly docs, KVS |
| `KVS.Get` of a missing key | `-105` | Measured on a Shelly Plus 1PM, firmware 1.7.6 |
| `Schedule.Delete` of a missing ID | `-103` | Device log in the discussion of pull request #11 |
| `Schedule.Update` of a missing ID | `-105` | Device log in the discussion of pull request #11 |
| ID of a new schedule | the lowest free one | Seen on devices, not documented |

The Shelly documentation gives no error code for a full limit (schedules, calls, virtual components, KVS value, key or key count), for a virtual component ID that is taken, or for `Virtual.Delete` of a missing component. The simulation answers these with `ERR_LIMIT_ASSUMED` or "not found". The scripts only test for a non-zero code, so the exact number does not change a test result, but it is an assumption until someone reads it from a device.

More than 5 RPC calls in flight, or more than 5 active timers, end a test with `sim.crashed` set. What the device itself does in that case is not documented.

## What is not simulated

A passing test does not prove these. They need a real device.

- The script engine. Node accepts JavaScript that the engine of the device does not.
- Memory use and the size of the script.
- The call stack of the engine. A Shelly Plus 1PM stopped a script at about five nested calls.
- The size of an HTTP answer.
- Paging of `Shelly.GetComponents`. The simulation returns every component in one answer.
- `Script.PutCode` accepting only ASCII.
- Other firmware versions and device generations than the ones named above.
