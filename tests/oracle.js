'use strict';

const { eleringRows } = require('./harness');

const PACKAGES = {
    NONE: { dayRate: 0, nightRate: 0, dayPeakRate: 0, holidayPeakRate: 0 },
    VORK2: { dayRate: 60.7, nightRate: 35.1, dayPeakRate: 60.7, holidayPeakRate: 35.1 },
    VORK4: { dayRate: 36.9, nightRate: 21, dayPeakRate: 36.9, holidayPeakRate: 21 },
    VORK5: { dayRate: 52.9, nightRate: 30.3, dayPeakRate: 81.8, holidayPeakRate: 47.4 },
};
const MINUTES_PER_DAY = 24 * 60;
const RELAY_OVERLAP_SECONDS = 10;
const FIRST_WINTER_MONTH = 10;
const LAST_WINTER_MONTH = 2;

function elektrileviFee(ts, packageName) {
    const rates = PACKAGES[packageName];
    const date = new Date(ts * 1000);
    const hour = date.getHours();
    const day = date.getDay();
    const isWinter = date.getMonth() >= FIRST_WINTER_MONTH || date.getMonth() <= LAST_WINTER_MONTH;
    const isWeekend = day === 0 || day === 6;
    const isEveningPeak = hour >= 16 && hour < 20;
    const isMorningPeak = hour >= 9 && hour < 12;
    if (isWinter && isWeekend && isEveningPeak) return rates.holidayPeakRate;
    if (isWinter && !isWeekend && (isMorningPeak || isEveningPeak)) return rates.dayPeakRate;
    if (hour < 7 || hour >= 22 || isWeekend) return rates.nightRate;
    return rates.dayRate;
}

function localMidnight(isoDate, dayOffset) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day + dayOffset).getTime() / 1000;
}

function roundToCents(price) {
    return Math.round(price * 100) / 100;
}

function hourlyPrices(fixture, isoDate, packageName) {
    const dayStart = localMidnight(isoDate, 0);
    const dayEnd = localMidnight(isoDate, 1);
    const quarters = eleringRows(fixture).rows.filter((row) => row.ts >= dayStart && row.ts < dayEnd);
    const hours = [];
    for (const quarter of quarters) {
        const hour = new Date(quarter.ts * 1000).getHours();
        const last = hours[hours.length - 1];
        if (last && last.hour === hour) {
            last.sum += quarter.price;
            last.count++;
        } else {
            hours.push({ hour, ts: quarter.ts, sum: quarter.price, count: 1 });
        }
    }
    return hours.map((entry, index) => {
        const market = roundToCents(entry.sum / entry.count);
        return { index, hour: entry.hour, market, total: market + elektrileviFee(entry.ts, packageName) };
    });
}

function cheapest(hours, count) {
    return hours.slice().sort((a, b) => a.total - b.total || a.index - b.index).slice(0, count);
}

function cheapestHours(fixture, isoDate, packageName, count) {
    return cheapest(hourlyPrices(fixture, isoDate, packageName), count).map((entry) => entry.hour).sort((a, b) => a - b);
}

function plannedHours(fixture, isoDate, plan) {
    const hours = hourlyPrices(fixture, isoDate, plan.packageName);
    const chosen = new Set(hours.filter((entry) => entry.market < plan.alwaysOnPrice));
    const periodCount = plan.periodHours > 0 ? Math.ceil(24 / plan.periodHours) : 0;
    for (let period = 0; period < periodCount; period++) {
        const inPeriod = hours.filter((entry) => Math.floor(entry.hour / plan.periodHours) === period);
        for (const entry of cheapest(inPeriod, plan.hoursPerPeriod)) chosen.add(entry);
    }
    return [...chosen].filter((entry) => !(entry.market > plan.alwaysOffPrice))
        .sort((a, b) => a.index - b.index).map((entry) => entry.hour);
}

function heatingMinutes(sim) {
    const minutesPerStart = (sim.switchConfig.auto_off_delay - RELAY_OVERLAP_SECONDS) / 60;
    const minutesOn = new Set();
    for (const timespec of sim.timespecs()) {
        const fields = timespec.split(' ');
        for (const minute of fields[1].split(',').map(Number)) {
            for (const hour of fields[2].split(',').map(Number)) {
                for (let i = 0; i < minutesPerStart; i++) minutesOn.add((hour * 60 + minute + i) % MINUTES_PER_DAY);
            }
        }
    }
    return minutesOn.size;
}

module.exports = { elektrileviFee, hourlyPrices, cheapestHours, plannedHours, heatingMinutes };
