"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatHHmm,
  localDateKey,
  dayType,
  haversine,
  formatDistance,
  scheduledDate,
  statusFor,
} = require("../logic.js");

test("formatHHmm formats valid times and rejects junk", () => {
  assert.equal(formatHHmm("0512"), "05:12");
  assert.equal(formatHHmm("2359"), "23:59");
  assert.equal(formatHHmm("0000"), "00:00");
  assert.equal(formatHHmm(""), "—");
  assert.equal(formatHHmm("512"), "—");
  assert.equal(formatHHmm("ab30"), "—");
  assert.equal(formatHHmm(null), "—");
});

test("localDateKey uses local calendar fields, zero-padded", () => {
  assert.equal(localDateKey(new Date(2026, 0, 1, 23, 30)), "2026-01-01");
  assert.equal(localDateKey(new Date(2026, 11, 9, 0, 5)), "2026-12-09");
});

test("dayType splits weekday / Saturday / Sunday", () => {
  assert.equal(dayType(new Date(2026, 6, 1), []), "WD");  // Wed 1 Jul 2026
  assert.equal(dayType(new Date(2026, 6, 4), []), "SAT"); // Sat 4 Jul 2026
  assert.equal(dayType(new Date(2026, 6, 5), []), "SUN"); // Sun 5 Jul 2026
});

test("dayType treats a public holiday as Sun/PH even on a weekday", () => {
  const holidays = ["2026-01-01"]; // New Year's Day, a Thursday
  assert.equal(dayType(new Date(2026, 0, 1), holidays), "SUN");
  assert.equal(dayType(new Date(2026, 0, 2), holidays), "WD"); // next day is normal
  // Also accepts a Set.
  assert.equal(dayType(new Date(2026, 0, 1), new Set(holidays)), "SUN");
});

test("scheduledDate keeps evening times on the same day", () => {
  const ref = new Date(2026, 6, 1, 22, 0); // 22:00
  const d = scheduledDate("2300", ref);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 23);
});

test("scheduledDate rolls after-midnight times onto the next day", () => {
  const ref = new Date(2026, 6, 1, 23, 30); // late evening
  const d = scheduledDate("0030", ref);
  assert.equal(d.getDate(), 2);  // belongs to the small hours of the next day
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 30);
});

test("statusFor covers each state", () => {
  const now = new Date(2026, 6, 1, 22, 0); // 22:00

  assert.equal(statusFor("2300", now).cls, "is-plenty"); // +60 min
  assert.equal(statusFor("2230", now).cls, "is-soon");   // +30 min
  assert.equal(statusFor("2145", now).cls, "is-late");   // -15 min
  assert.equal(statusFor("2100", now).cls, "is-ended");  // -60 min
  assert.equal(statusFor("", now).cls, "is-ended");
  assert.equal(statusFor("99:99", now).cls, "is-ended");

  assert.match(statusFor("2230", now).text, /~30 min/);
});

test("statusFor handles an after-midnight last bus", () => {
  const now = new Date(2026, 6, 1, 23, 45); // 23:45
  const s = statusFor("0030", now);         // 00:30 next day, +45 min
  assert.equal(s.cls, "is-soon");
});

test("haversine and formatDistance", () => {
  // ~1.11 km per 0.01° of latitude near the equator.
  const d = haversine(1.30, 103.80, 1.31, 103.80);
  assert.ok(Math.abs(d - 1112) < 20, `expected ~1112 m, got ${d}`);
  assert.equal(formatDistance(0), "0 m");
  assert.equal(formatDistance(123), "120 m");
  assert.equal(formatDistance(1500), "1.5 km");
});
