/* ============================================================================
   Got Bus Anot? — pure, side-effect-free logic.

   These functions touch no DOM and no globals. They're loaded in the browser
   via a plain <script> tag and attach to the global object (window/self), so
   script.js can use them — no build step.
   ========================================================================= */

(function (root) {
  "use strict";

  /** "0512" -> "05:12"; blank/invalid -> "—". */
  function formatHHmm(hhmm) {
    if (!hhmm || hhmm.length !== 4 || !/^\d{4}$/.test(hhmm)) return "—";
    return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  }

  /**
   * True for a valid "HHmm" in the small hours (hour < 4), i.e. a time that
   * belongs to the next calendar day — the UI marks these with a "+1".
   */
  function isAfterMidnight(hhmm) {
    if (!hhmm || !/^\d{4}$/.test(hhmm)) return false;
    return parseInt(hhmm.slice(0, 2), 10) < 4;
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

  Object.assign(root, {
    formatHHmm,
    isAfterMidnight,
    localDateKey,
    dayType,
    haversine,
    formatDistance,
  });
})(typeof self !== "undefined" ? self : this);
