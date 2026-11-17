'use strict';

const DEFAULT_CONF = {
    TimePeriod: 24, HeatingTime: 10, IsForecastUsed: false, EnergyProvider: 'VORK2', AlwaysOnPrice: 1,
    AlwaysOffPrice: 300, InvertedRelay: false, RelayId: 0, Country: 'ee', HeatingCurve: 0, ManualKVS: false,
};
const STORAGE_TANK_CONF = Object.assign({}, DEFAULT_CONF, {
    HeatingTime: 24, IsForecastUsed: true, EnergyProvider: 'VORK4', AlwaysOnPrice: -200, AlwaysOffPrice: 40,
});
const HOT_WATER_CONF = Object.assign({}, DEFAULT_CONF, {
    TimePeriod: 6, HeatingTime: 2, EnergyProvider: 'VORK4', AlwaysOnPrice: 40, AlwaysOffPrice: 300,
});

const NORMAL_DAY = { fixture: 'elering-2026-10-07.csv', isoDate: '2026-10-07', now: '2026-10-06T23:20:00+03:00' };
const HOT_WATER_DAY = { fixture: 'elering-2026-10-08.csv', isoDate: '2026-10-08', now: '2026-10-07T23:50:00+03:00' };
const NEGATIVE_DAY = { fixture: 'elering-2026-05-24-negative.csv', isoDate: '2026-05-24', now: '2026-05-23T23:50:00+03:00' };
const SPRING_DST_DAY = { fixture: 'elering-2026-03-29-dst-spring.csv', isoDate: '2026-03-29', now: '2026-03-28T23:20:00+02:00' };
const AUTUMN_DST_DAY = { fixture: 'elering-2025-10-26-dst-autumn.csv', isoDate: '2025-10-26', now: '2025-10-25T23:20:00+03:00' };

const HEATING_SCRIPT_ID = 1;
const WATCHDOG_SCRIPT_ID = 2;

const GEN2_DEVICE = { gen: 2, app: 'Plus1PM', ver: '1.7.5', id: 'shellyplus1pm-test' };
const GEN3_DEVICE = { gen: 3, app: 'S3SW-001P16EU', ver: '1.7.5', id: 'shelly1pmg3-test' };

module.exports = {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
    HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, GEN2_DEVICE, GEN3_DEVICE,
};
