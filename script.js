/* ============================================================================
   Last Bus When Ah? — static front-end logic.

   Reads the pre-generated data/data.json (no live API calls) and lets the user:
     1. enter a bus service number,
     2. find a stop along that route (by name / road / code, or "near me"),
     3. see scheduled first/last bus times with today's row highlighted and a
        live status line for the last bus.

   Plain ES modules-free JS so it runs directly on GitHub Pages, no build step.
   ========================================================================= */

"use strict";

// --- Data field indices (must match scripts/fetch_data.py) -----------------
// routes: [ServiceNo, Direction, StopSequence, BusStopCode,
//          WD_First, WD_Last, SAT_First, SAT_Last, SUN_First, SUN_Last]
const R = {
  SERVICE: 0, DIRECTION: 1, SEQ: 2, CODE: 3,
  WD_FIRST: 4, WD_LAST: 5, SAT_FIRST: 6, SAT_LAST: 7, SUN_FIRST: 8, SUN_LAST: 9,
};
// stops: { code: [RoadName, Description, Latitude, Longitude] }
const S = { ROAD: 0, DESC: 1, LAT: 2, LNG: 3 };

// --- State -----------------------------------------------------------------
let DATA = null;             // full parsed data.json
let currentRouteStops = [];  // route records for the currently entered service
let userLocation = null;     // { lat, lng } once geolocation succeeds
let statusTimer = null;      // interval id for the live status line
let selectedRow = -1;        // keyboard highlight index in the results list

// --- DOM refs --------------------------------------------------------------
const el = {
  serviceInput: document.getElementById("service-input"),
  stopInput:    document.getElementById("stop-input"),
  stopHint:     document.getElementById("stop-hint"),
  serviceHint:  document.getElementById("service-hint"),
  locateBtn:    document.getElementById("locate-btn"),
  stopResults:  document.getElementById("stop-results"),
  result:       document.getElementById("result"),
  resultStop:   document.getElementById("result-stop"),
  resultMeta:   document.getElementById("result-meta"),
  timesBody:    document.getElementById("times-body"),
  status:       document.getElementById("status"),
  message:      document.getElementById("message"),
  timestamp:    document.getElementById("data-timestamp"),
};

// ===========================================================================
// Boot
// ===========================================================================

init();

async function init() {
  try {
    const res = await fetch("data/data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    showMessage(
      "Couldn't load bus data. If you just cloned this repo, run the fetch " +
      "workflow to generate data/data.json (see README)."
    );
    console.error("Failed to load data.json:", err);
    return;
  }

  // Footer freshness stamp.
  if (DATA.generated) {
    const d = new Date(DATA.generated);
    el.timestamp.textContent = isNaN(d)
      ? DATA.generated
      : d.toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" });
  }

  wireEvents();
}

function wireEvents() {
  el.serviceInput.addEventListener("input", onServiceInput);
  el.stopInput.addEventListener("input", () => renderStopResults(el.stopInput.value));
  el.stopInput.addEventListener("focus", () => {
    if (el.stopInput.value.trim() === "") renderStopResults("");
  });
  el.stopInput.addEventListener("keydown", onStopKeydown);
  el.locateBtn.addEventListener("click", onLocate);

  // Prevent the form from actually submitting/reloading.
  document.getElementById("search-form").addEventListener("submit", (e) => e.preventDefault());

  // Clicking outside the results list closes it.
  document.addEventListener("click", (e) => {
    if (!el.stopResults.contains(e.target) && e.target !== el.stopInput) {
      hideStopResults();
    }
  });
}

// ===========================================================================
// Step 1 — bus service
// ===========================================================================

function onServiceInput() {
  const service = el.serviceInput.value.trim().toUpperCase();
  resetResult();
  hideStopResults();

  if (service === "") {
    disableStopSearch("Pick a service first.");
    return;
  }

  // All route records for this service (both directions).
  currentRouteStops = DATA.routes.filter(
    (r) => String(r[R.SERVICE]).toUpperCase() === service
  );

  if (currentRouteStops.length === 0) {
    disableStopSearch(`No service "${service}" found.`);
    return;
  }

  // Enable stop search. Note: this runs on every keystroke, so we must NOT
  // steal focus here — otherwise typing "196" would jump to the stop field
  // the moment "19" matches a real service. The user tabs/clicks over when ready.
  el.stopInput.disabled = false;
  el.locateBtn.disabled = false;
  const dirs = new Set(currentRouteStops.map((r) => r[R.DIRECTION])).size;
  el.stopHint.textContent =
    `${currentRouteStops.length} stops` + (dirs > 1 ? ` · ${dirs} directions` : "") +
    ` — search by name, road, or code.`;
}

function disableStopSearch(hint) {
  currentRouteStops = [];
  el.stopInput.value = "";
  el.stopInput.disabled = true;
  el.locateBtn.disabled = true;
  el.stopHint.textContent = hint;
}

// ===========================================================================
// Step 2 — stop search
// ===========================================================================

/**
 * Build the list of candidate stops for the current route, optionally filtered
 * by a text query, and optionally ranked by distance from the user.
 * Returns an array of view-model objects.
 */
function buildStopCandidates(query) {
  const q = query.trim().toLowerCase();

  // De-duplicate by bus stop code (a stop can appear once per direction; we
  // keep the first occurrence but remember the direction + sequence for meta).
  const seen = new Map();
  for (const r of currentRouteStops) {
    const code = r[R.CODE];
    if (!seen.has(code)) seen.set(code, r);
  }

  let candidates = [];
  for (const [code, route] of seen) {
    const stop = DATA.stops[code];
    const road = stop ? stop[S.ROAD] : "";
    const desc = stop ? stop[S.DESC] : "";
    const lat = stop ? stop[S.LAT] : null;
    const lng = stop ? stop[S.LNG] : null;

    // Text match against description, road, or code.
    if (q) {
      const hay = `${desc} ${road} ${code}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    let distance = null;
    if (userLocation && typeof lat === "number" && typeof lng === "number") {
      distance = haversine(userLocation.lat, userLocation.lng, lat, lng);
    }

    candidates.push({ code, route, road, desc, lat, lng, distance });
  }

  // Rank: by distance if we have the user's location, else by stop sequence.
  if (userLocation) {
    candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  } else {
    candidates.sort((a, b) => a.route[R.SEQ] - b.route[R.SEQ]);
  }

  return candidates.slice(0, 40); // cap the list for performance / sanity
}

function renderStopResults(query) {
  if (el.stopInput.disabled) return;
  const candidates = buildStopCandidates(query);
  selectedRow = -1;

  if (candidates.length === 0) {
    el.stopResults.innerHTML =
      `<li class="stop-results__item" aria-disabled="true">No matching stops on this route.</li>`;
    el.stopResults.hidden = false;
    return;
  }

  el.stopResults.innerHTML = candidates
    .map((c, i) => {
      const distTag = c.distance != null
        ? `<span class="stop-results__dist">${formatDistance(c.distance)}</span>`
        : "";
      const name = escapeHtml(c.desc || c.road || `Stop ${c.code}`);
      const sub = escapeHtml(`${c.road} · ${c.code}`);
      return (
        `<li class="stop-results__item" role="option" data-code="${c.code}" data-index="${i}">` +
          `<span><span class="stop-results__name">${name}</span>` +
          `<span class="stop-results__sub">${sub}</span></span>` +
          distTag +
        `</li>`
      );
    })
    .join("");

  // Wire clicks.
  el.stopResults.querySelectorAll(".stop-results__item[data-code]").forEach((li) => {
    li.addEventListener("click", () => selectStop(li.dataset.code));
  });

  el.stopResults.hidden = false;
}

function hideStopResults() {
  el.stopResults.hidden = true;
  el.stopResults.innerHTML = "";
  selectedRow = -1;
}

/** Keyboard navigation within the results list. */
function onStopKeydown(e) {
  const items = [...el.stopResults.querySelectorAll(".stop-results__item[data-code]")];
  if (el.stopResults.hidden || items.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedRow = Math.min(selectedRow + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedRow = Math.max(selectedRow - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const target = selectedRow >= 0 ? items[selectedRow] : items[0];
    if (target) selectStop(target.dataset.code);
    return;
  } else if (e.key === "Escape") {
    hideStopResults();
    return;
  } else {
    return;
  }

  items.forEach((li, i) => li.setAttribute("aria-selected", i === selectedRow));
  if (selectedRow >= 0) items[selectedRow].scrollIntoView({ block: "nearest" });
}

// ===========================================================================
// Geolocation — "near me"
// ===========================================================================

function onLocate() {
  if (!navigator.geolocation) {
    el.stopHint.textContent = "Geolocation isn't supported by this browser.";
    return;
  }
  el.locateBtn.disabled = true;
  el.locateBtn.textContent = "Locating…";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      el.locateBtn.textContent = "📍 Nearest";
      el.locateBtn.disabled = false;
      el.stopHint.textContent = "Showing nearest stops on this route first.";
      renderStopResults(el.stopInput.value);
      el.stopInput.focus();
    },
    (err) => {
      el.locateBtn.textContent = "📍 Near me";
      el.locateBtn.disabled = false;
      el.stopHint.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — search by name instead."
          : "Couldn't get your location — search by name instead.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
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

// ===========================================================================
// Step 3 — result table + status
// ===========================================================================

function selectStop(code) {
  hideStopResults();

  // A stop may appear in both directions; gather all matching route records.
  const matches = currentRouteStops.filter((r) => r[R.CODE] === code);
  if (matches.length === 0) return;

  // Default to the first direction; if two exist, we show direction 1's times
  // but note the presence of the other in the meta line.
  const route = matches[0];
  const stop = DATA.stops[code];

  const stopName = stop ? (stop[S.DESC] || stop[S.ROAD]) : `Stop ${code}`;
  el.resultStop.textContent = stopName;

  const service = el.serviceInput.value.trim().toUpperCase();
  const dirNote = matches.length > 1 ? " · both directions" : ` · direction ${route[R.DIRECTION]}`;
  el.resultMeta.textContent =
    `Service ${service}${dirNote} · ${stop ? stop[S.ROAD] : ""} · Stop ${code}`;

  el.stopInput.value = stopName;

  renderTimes(route);
  el.result.hidden = false;
  el.message.hidden = true;

  // Kick off (and keep refreshing) the live status line.
  startStatus(route);
}

/** Which schedule column applies today: 'WD' | 'SAT' | 'SUN'. */
function dayType(date = new Date()) {
  const day = date.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0) return "SUN";
  if (day === 6) return "SAT";
  return "WD";
}

function renderTimes(route) {
  const today = dayType();
  const rows = [
    { key: "WD",  label: "Weekday",  first: route[R.WD_FIRST],  last: route[R.WD_LAST] },
    { key: "SAT", label: "Saturday", first: route[R.SAT_FIRST], last: route[R.SAT_LAST] },
    { key: "SUN", label: "Sun / PH", first: route[R.SUN_FIRST], last: route[R.SUN_LAST] },
  ];

  el.timesBody.innerHTML = rows
    .map((row) => {
      const cls = row.key === today ? ' class="is-today"' : "";
      return (
        `<tr${cls}>` +
          `<td>${row.label}</td>` +
          `<td>${formatHHmm(row.first)}</td>` +
          `<td>${formatHHmm(row.last)}</td>` +
        `</tr>`
      );
    })
    .join("");
}

/** "0512" -> "05:12"; blank/invalid -> "—". */
function formatHHmm(hhmm) {
  if (!hhmm || hhmm.length !== 4 || !/^\d{4}$/.test(hhmm)) return "—";
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
}

// ===========================================================================
// Live status line for the last bus
// ===========================================================================

function startStatus(route) {
  if (statusTimer) clearInterval(statusTimer);
  updateStatus(route);
  // Refresh every 30s so the countdown stays live without being busy.
  statusTimer = setInterval(() => updateStatus(route), 30000);
}

function updateStatus(route) {
  const today = dayType();
  const lastStr =
    today === "SUN" ? route[R.SUN_LAST] :
    today === "SAT" ? route[R.SAT_LAST] :
    route[R.WD_LAST];

  const setStatus = (text, cls) => {
    el.status.textContent = text;
    el.status.className = "status " + cls;
  };

  if (!lastStr || !/^\d{4}$/.test(lastStr)) {
    setStatus("No scheduled last-bus time for today.", "is-ended");
    return;
  }

  const now = new Date();
  // scheduledDate() handles after-midnight last-bus times (e.g. "0030"), which
  // belong to the small hours of the next calendar day.
  const last = scheduledDate(lastStr, now);
  const diffMin = Math.round((last - now) / 60000);

  if (diffMin > 45) {
    setStatus(`Plenty of time — last bus at ${formatHHmm(lastStr)}.`, "is-plenty");
  } else if (diffMin >= 0) {
    setStatus(`Last bus due soon — ~${diffMin} min (${formatHHmm(lastStr)}).`, "is-soon");
  } else if (diffMin >= -20) {
    setStatus(
      `Past scheduled last bus by ${Math.abs(diffMin)} min — may still be running late.`,
      "is-late"
    );
  } else {
    setStatus("Service has ended for today.", "is-ended");
  }
}

/** Build a Date for an "HHmm" time on the same calendar day as `ref`,
 *  accounting for after-midnight (00:00–03:59) last-bus times that belong to
 *  the small hours of the *next* day. */
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

// ===========================================================================
// Helpers
// ===========================================================================

function resetResult() {
  el.result.hidden = true;
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

function showMessage(text) {
  el.message.textContent = text;
  el.message.hidden = false;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
