/* ============================================================================
   Last Bus When Ah? — static front-end logic.

   Data is sharded (see scripts/fetch_data.py):
     * data/services.json      — tiny index of every service, loaded at boot.
     * data/svc/<SERVICE>.json  — one file per service, loaded on demand, with
                                  only that route's stops embedded.
     * data/holidays.json       — dates that use the Sun/PH schedule.

   So a visitor downloads a few KB for the one service they ask about instead
   of a multi-megabyte blob. Pure helpers live in logic.js (unit-tested).

   Plain script-tag JS so it runs directly on GitHub Pages, no build step.
   ========================================================================= */

"use strict";

// --- Data field indices (must match scripts/fetch_data.py shard shape) ------
// routes: [Direction, StopSequence, BusStopCode,
//          WD_First, WD_Last, SAT_First, SAT_Last, SUN_First, SUN_Last]
const R = {
  DIRECTION: 0, SEQ: 1, CODE: 2,
  WD_FIRST: 3, WD_LAST: 4, SAT_FIRST: 5, SAT_LAST: 6, SUN_FIRST: 7, SUN_LAST: 8,
};
// stops: { code: [RoadName, Description, Latitude, Longitude] }
const S = { ROAD: 0, DESC: 1, LAT: 2, LNG: 3 };

// Pure helpers from logic.js (attached to the global object by that script).
const { formatHHmm, dayType, haversine, formatDistance, statusFor } = self;

// --- State -----------------------------------------------------------------
let INDEX = null;            // { generated, services: Set<string> }
let HOLIDAYS = new Set();    // "YYYY-MM-DD" dates on the Sun/PH schedule
const shardCache = new Map();// service -> loaded shard (avoid refetching)

let currentService = null;   // the loaded shard { service, stops, routes }
let currentRouteStops = [];  // currentService.routes (the current service's records)
let terminalByDir = new Map();// direction -> terminal stop description
let serviceToken = 0;        // guards against out-of-order async shard loads

let userLocation = null;     // { lat, lng } once geolocation succeeds

let statusTimer = null;      // interval id for the live status line
let statusRoute = null;      // route currently driving the status line
let resultDirMap = null;     // direction -> route for the chosen stop
let activeDir = null;        // which direction's times are on screen

// --- DOM refs --------------------------------------------------------------
const el = {
  serviceInput: document.getElementById("service-input"),
  serviceClear: document.getElementById("service-clear"),
  stopHint:     document.getElementById("stop-hint"),
  serviceHint:  document.getElementById("service-hint"),
  locateBtn:    document.getElementById("locate-btn"),
  stopLists:    document.getElementById("stop-lists"),
  result:       document.getElementById("result"),
  resultStop:   document.getElementById("result-stop"),
  resultMeta:   document.getElementById("result-meta"),
  dirTabs:      document.getElementById("dir-tabs"),
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
    const res = await fetch("data/services.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const idx = await res.json();
    INDEX = { generated: idx.generated || "", services: new Set(idx.services || []) };
  } catch (err) {
    showMessage(
      "Couldn't load bus data. If you just cloned this repo, run the fetch " +
      "workflow to generate the data files (see README)."
    );
    console.error("Failed to load services.json:", err);
    return;
  }

  // Public holidays are a nice-to-have; a failure here just falls back to the
  // plain weekday/Saturday/Sunday split.
  try {
    const res = await fetch("data/holidays.json", { cache: "no-cache" });
    if (res.ok) {
      const h = await res.json();
      HOLIDAYS = new Set(h.holidays || []);
    }
  } catch (err) {
    console.warn("No holidays.json — public holidays won't be detected.", err);
  }

  // Footer freshness stamp.
  if (INDEX.generated) {
    const d = new Date(INDEX.generated);
    el.timestamp.textContent = isNaN(d)
      ? INDEX.generated
      : d.toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" });
  }

  wireEvents();
}

function wireEvents() {
  el.serviceInput.addEventListener("input", onServiceInput);
  el.locateBtn.addEventListener("click", onLocate);
  el.serviceClear.addEventListener("click", onServiceClear);

  // Prevent the form from actually submitting/reloading.
  document.getElementById("search-form").addEventListener("submit", (e) => e.preventDefault());

  // Don't keep the countdown ticking (or leave a stale value) while hidden.
  document.addEventListener("visibilitychange", onVisibilityChange);
}

// ===========================================================================
// Step 1 — bus service (loads the per-service shard)
// ===========================================================================

async function onServiceInput() {
  const service = el.serviceInput.value.trim().toUpperCase();
  updateClear(el.serviceInput, el.serviceClear);
  resetResult();

  if (service === "") {
    currentService = null;
    clearStopLists("Pick a service first.");
    return;
  }

  if (!INDEX.services.has(service)) {
    currentService = null;
    clearStopLists(`No service "${service}" found.`);
    return;
  }

  // Load the shard. This runs on every keystroke, so tag each request and
  // ignore any that a newer keystroke has superseded.
  const token = ++serviceToken;
  el.stopHint.textContent = "Loading stops…";
  let shard;
  try {
    shard = await loadService(service);
  } catch (err) {
    if (token === serviceToken) {
      currentService = null;
      clearStopLists("Couldn't load that service's stops — try again.");
    }
    console.error(`Failed to load shard for ${service}:`, err);
    return;
  }
  if (token !== serviceToken) return; // a later keystroke won

  currentService = shard;
  currentRouteStops = shard.routes;
  computeTerminals();

  el.locateBtn.disabled = false;
  const dirs = terminalByDir.size;
  const stopCount = new Set(currentRouteStops.map((r) => r[R.CODE])).size;
  el.stopHint.textContent =
    `${stopCount} stops` + (dirs > 1 ? ` in ${dirs} directions` : "") +
    ` — tap one for its times.`;
  renderStopLists();
}

/** Fetch (and cache) one service shard. Cache-busted by the dataset version. */
async function loadService(service) {
  if (shardCache.has(service)) return shardCache.get(service);
  const v = encodeURIComponent(INDEX.generated);
  const res = await fetch(`data/svc/${encodeURIComponent(service)}.json?v=${v}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const shard = await res.json();
  shardCache.set(service, shard);
  return shard;
}

/** Work out each direction's terminal (last stop) for nicer direction labels. */
function computeTerminals() {
  terminalByDir = new Map();
  const maxSeq = new Map(); // dir -> highest seq seen
  for (const r of currentRouteStops) {
    const dir = r[R.DIRECTION];
    if (!maxSeq.has(dir) || r[R.SEQ] > maxSeq.get(dir)) {
      maxSeq.set(dir, r[R.SEQ]);
      const stop = currentService.stops[r[R.CODE]];
      terminalByDir.set(dir, stop ? (stop[S.DESC] || stop[S.ROAD]) : null);
    }
  }
}

function directionLabel(dir) {
  const terminal = terminalByDir.get(dir);
  return terminal ? `to ${terminal}` : `direction ${dir}`;
}

function clearStopLists(hint) {
  currentRouteStops = [];
  el.stopLists.innerHTML = "";
  el.locateBtn.disabled = true;
  el.stopHint.textContent = hint;
}

// ===========================================================================
// Step 2 — the route's stops, one list per direction
// ===========================================================================

/** View-model for one stop record (code, name, road, distance from user). */
function makeCandidate(route) {
  const code = route[R.CODE];
  const stop = currentService.stops[code];
  const road = stop ? stop[S.ROAD] : "";
  const desc = stop ? stop[S.DESC] : "";
  const lat = stop ? stop[S.LAT] : null;
  const lng = stop ? stop[S.LNG] : null;
  let distance = null;
  if (userLocation && typeof lat === "number" && typeof lng === "number") {
    distance = haversine(userLocation.lat, userLocation.lng, lat, lng);
  }
  return { code, route, dir: route[R.DIRECTION], road, desc, distance };
}

/**
 * Build the route's stops grouped by direction, one group per direction
 * (labelled by that direction's terminal). Within each group, stops are ordered
 * by distance from the user (if we have their location) or by stop sequence.
 */
function buildDirectionGroups() {
  const groups = [];

  for (const dir of [...terminalByDir.keys()].sort((a, b) => a - b)) {
    // One entry per stop code within this direction.
    const seen = new Map();
    for (const r of currentRouteStops) {
      if (r[R.DIRECTION] !== dir) continue;
      const code = r[R.CODE];
      if (!seen.has(code)) seen.set(code, r);
    }

    const candidates = [...seen.values()].map(makeCandidate);
    if (userLocation) {
      candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    } else {
      candidates.sort((a, b) => a.route[R.SEQ] - b.route[R.SEQ]);
    }

    if (candidates.length) groups.push({ dir, label: directionLabel(dir), candidates });
  }

  return groups;
}

/** Render the whole route as one tappable list per direction. */
function renderStopLists() {
  const groups = buildDirectionGroups();
  if (groups.length === 0) {
    el.stopLists.innerHTML = "";
    return;
  }

  let html = "";
  for (const g of groups) {
    let items = "";
    for (const c of g.candidates) {
      const distTag = c.distance != null
        ? `<span class="stop-list__dist">${formatDistance(c.distance)}</span>`
        : "";
      const name = escapeHtml(c.desc || c.road || `Stop ${c.code}`);
      const sub = escapeHtml(`${c.road} · ${c.code}`);
      items +=
        `<li class="stop-list__item" role="button" tabindex="0" ` +
            `data-code="${c.code}" data-dir="${c.dir}">` +
          `<span><span class="stop-list__name">${name}</span>` +
          `<span class="stop-list__sub">${sub}</span></span>` +
          distTag +
        `</li>`;
    }
    html +=
      `<section class="stop-list">` +
        `<h3 class="stop-list__head">${escapeHtml(g.label)} · ${g.candidates.length} stops</h3>` +
        `<ul class="stop-list__items">${items}</ul>` +
      `</section>`;
  }
  el.stopLists.innerHTML = html;

  // Tap or keyboard-activate a stop — carry the direction it was listed under.
  el.stopLists.querySelectorAll(".stop-list__item").forEach((li) => {
    const pick = () => selectStop(li.dataset.code, Number(li.dataset.dir));
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
  });
}

/** Highlight the chosen stop across both direction lists. */
function markSelectedStop(code) {
  el.stopLists.querySelectorAll(".stop-list__item").forEach((li) => {
    li.classList.toggle("is-selected", li.dataset.code === code);
  });
}

/** Clear the service field and reset everything downstream of it. */
function onServiceClear() {
  el.serviceInput.value = "";
  onServiceInput();          // resets result, clears the stop lists
  el.serviceInput.focus();
}

/** Show a field's clear button only when it holds text and is enabled. */
function updateClear(input, btn) {
  btn.hidden = input.disabled || input.value === "";
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
      el.stopHint.textContent = "Each list now starts with the stops nearest you.";
      renderStopLists();
    },
    (err) => {
      el.locateBtn.textContent = "📍 Near me";
      el.locateBtn.disabled = false;
      el.stopHint.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — stops stay in route order."
          : "Couldn't get your location — stops stay in route order.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ===========================================================================
// Step 3 — result table + status (per direction)
// ===========================================================================

function selectStop(code, preferredDir) {
  // A stop may be served in both directions; the first/last times differ, so
  // group by direction and let the user switch between them.
  resultDirMap = new Map();
  for (const r of currentRouteStops) {
    if (r[R.CODE] === code && !resultDirMap.has(r[R.DIRECTION])) {
      resultDirMap.set(r[R.DIRECTION], r);
    }
  }
  if (resultDirMap.size === 0) return;

  const stop = currentService.stops[code];
  const stopName = stop ? (stop[S.DESC] || stop[S.ROAD]) : `Stop ${code}`;
  el.resultStop.textContent = stopName;
  markSelectedStop(code);

  renderDirTabs(code);

  // Open on the direction the stop was tapped under, if it serves this stop;
  // otherwise fall back to the lowest-numbered direction.
  const dirs = [...resultDirMap.keys()].sort((a, b) => a - b);
  const startDir = resultDirMap.has(preferredDir) ? preferredDir : dirs[0];
  showDirection(startDir, code);

  el.result.hidden = false;
  el.message.hidden = true;
  el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Build the direction switcher (hidden when a stop is single-direction). */
function renderDirTabs(code) {
  const dirs = [...resultDirMap.keys()].sort((a, b) => a - b);
  if (dirs.length < 2) {
    el.dirTabs.hidden = true;
    el.dirTabs.innerHTML = "";
    return;
  }
  el.dirTabs.innerHTML = dirs
    .map((dir) =>
      `<button type="button" class="dir-tab" role="tab" data-dir="${dir}">` +
        escapeHtml(directionLabel(dir)) +
      `</button>`
    )
    .join("");
  el.dirTabs.querySelectorAll(".dir-tab").forEach((btn) => {
    btn.addEventListener("click", () => showDirection(Number(btn.dataset.dir), code));
  });
  el.dirTabs.hidden = false;
}

function showDirection(dir, code) {
  const route = resultDirMap.get(dir);
  if (!route) return;
  activeDir = dir;

  const stop = currentService.stops[code];
  const service = el.serviceInput.value.trim().toUpperCase();
  el.resultMeta.textContent =
    `Service ${service} · ${directionLabel(dir)} · ${stop ? stop[S.ROAD] : ""} · Stop ${code}`;

  el.dirTabs.querySelectorAll(".dir-tab").forEach((btn) => {
    btn.setAttribute("aria-selected", Number(btn.dataset.dir) === dir);
  });

  renderTimes(route);
  startStatus(route);
}

function renderTimes(route) {
  const today = dayType(new Date(), HOLIDAYS);
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

// ===========================================================================
// Live status line for the last bus
// ===========================================================================

function startStatus(route) {
  statusRoute = route;
  if (statusTimer) clearInterval(statusTimer);
  updateStatus();
  // Refresh every 30s so the countdown stays live without being busy.
  statusTimer = setInterval(updateStatus, 30000);
}

function stopStatus() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

function updateStatus() {
  if (!statusRoute) return;
  const today = dayType(new Date(), HOLIDAYS);
  const lastStr =
    today === "SUN" ? statusRoute[R.SUN_LAST] :
    today === "SAT" ? statusRoute[R.SAT_LAST] :
    statusRoute[R.WD_LAST];

  const { text, cls } = statusFor(lastStr, new Date());
  el.status.textContent = text;
  el.status.className = "status " + cls;
}

/** Pause the ticking countdown while the tab is hidden; refresh on return. */
function onVisibilityChange() {
  if (document.hidden) {
    stopStatus();
  } else if (statusRoute && !el.result.hidden) {
    startStatus(statusRoute);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function resetResult() {
  el.result.hidden = true;
  stopStatus();
  statusRoute = null;
  resultDirMap = null;
  activeDir = null;
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
