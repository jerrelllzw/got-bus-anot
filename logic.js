/* ============================================================================
   Last Bus When Ah? — pure, side-effect-free logic.

   These functions touch no DOM and no globals, so they can be unit-tested in
   Node (see tests/logic.test.js) and are reused by the browser front-end
   (script.js). Loaded in the browser via a plain <script> tag (attaches to the
   global object) and in Node via require() — no build step either way.
   ========================================================================= */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;              // Node / tests
  } else {
    Object.assign(root, api);          // browser global (window/self)
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** "0512" -> "05:12"; blank/invalid -> "—". */
  function formatHHmm(hhmm) {
    if (!hhmm || hhmm.length !== 4 || !/^\d{4}$/.test(hhmm)) return "—";
    return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  }

  /** Local calendar date as "YYYY-MM-DD" (not UTC — holidays are local dates). */
  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Which schedule column applies on `date`: 'WD' | 'SAT' | 'SUN'.
   * Public holidays (a Set/array of "YYYY-MM-DD") use the Sun/PH schedule.
   */
  function dayType(date, holidays) {
    const set = holidays instanceof Set ? holidays : new Set(holidays || []);
    if (set.has(localDateKey(date))) return "SUN";
    const day = date.getDay(); // 0 = Sun, 6 = Sat
    if (day === 0) return "SUN";
    if (day === 6) return "SAT";
    return "WD";
  }

  /** Great-circle distance in metres between two lat/lng points. */
  function haversine(lat1, lng1, lat2, lng2) {
    const Rearth = 6371000; // metres
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * Rearth * Math.asin(Math.sqrt(a));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  /**
   * Build a Date for an "HHmm" time on the same calendar day as `ref`,
   * accounting for after-midnight (00:00–03:59) last-bus times that belong to
   * the small hours of the *next* day.
   */
  function scheduledDate(hhmm, ref) {
    const h = parseInt(hhmm.slice(0, 2), 10);
    const m = parseInt(hhmm.slice(2), 10);
    const d = new Date(ref);
    d.setHours(h, m, 0, 0);
    // After-midnight service times: if the scheduled hour is in the small hours
    // and it's currently late evening, the bus runs after today's midnight.
    if (h < 4 && ref.getHours() >= 12) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  /**
   * Decide the live last-bus status for a scheduled "HHmm" time at `now`.
   * Returns { text, cls } where cls is one of
   * is-plenty | is-soon | is-late | is-ended. Pure — the caller renders it.
   */
  function statusFor(lastStr, now) {
    if (!lastStr || !/^\d{4}$/.test(lastStr)) {
      return { text: "No scheduled last-bus time for today.", cls: "is-ended" };
    }
    const last = scheduledDate(lastStr, now);
    const diffMin = Math.round((last - now) / 60000);
    const hhmm = formatHHmm(lastStr);

    if (diffMin > 45) {
      return { text: `Plenty of time — last bus at ${hhmm}.`, cls: "is-plenty" };
    }
    if (diffMin >= 0) {
      return { text: `Last bus due soon — ~${diffMin} min (${hhmm}).`, cls: "is-soon" };
    }
    if (diffMin >= -20) {
      return {
        text: `Past scheduled last bus by ${Math.abs(diffMin)} min — may still be running late.`,
        cls: "is-late",
      };
    }
    return { text: "Service has ended for today.", cls: "is-ended" };
  }

  return {
    formatHHmm,
    localDateKey,
    dayType,
    haversine,
    formatDistance,
    scheduledDate,
    statusFor,
  };
});
