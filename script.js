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
let selectedRow = -1;        // keyboard highlight index in the results list

let statusTimer = null;      // interval id for the live status line
let statusRoute = null;      // route currently driving the status line
let resultDirMap = null;     // direction -> route for the chosen stop
let activeDir = null;        // which direction's times are on screen

// --- DOM refs --------------------------------------------------------------
const el = {
  serviceInput: document.getElementById("service-input"),
  serviceClear: document.getElementById("service-clear"),
  stopInput:    document.getElementById("stop-input"),
  stopClear:    document.getElementById("stop-clear"),
  stopHint:     document.getElementById("stop-hint"),
  serviceHint:  document.getElementById("service-hint"),
  locateBtn:    document.getElementById("locate-btn"),
  stopResults:  document.getElementById("stop-results"),
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
  el.stopInput.addEventListener("input", () => {
    updateClear(el.stopInput, el.stopClear);
    renderStopResults(el.stopInput.value);
  });
  el.stopInput.addEventListener("focus", () => {
    if (el.stopInput.value.trim() === "") renderStopResults("");
  });
  el.stopInput.addEventListener("keydown", onStopKeydown);
  el.locateBtn.addEventListener("click", onLocate);
  el.serviceClear.addEventListener("click", onServiceClear);
  el.stopClear.addEventListener("click", onStopClear);

  // Prevent the form from actually submitting/reloading.
  document.getElementById("search-form").addEventListener("submit", (e) => e.preventDefault());

  // Clicking outside the results list closes it.
  document.addEventListener("click", (e) => {
    if (!el.stopResults.contains(e.target) && e.target !== el.stopInput) {
      hideStopResults();
    }
  });

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
  hideStopResults();

  if (service === "") {
    currentService = null;
    disableStopSearch("Pick a service first.");
    return;
  }

  if (!INDEX.services.has(service)) {
    currentService = null;
    disableStopSearch(`No service "${service}" found.`);
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
      disableStopSearch("Couldn't load that service's stops — try again.");
    }
    console.error(`Failed to load shard for ${service}:`, err);
    return;
  }
  if (token !== serviceToken) return; // a later keystroke won

  currentService = shard;
  currentRouteStops = shard.routes;
  computeTerminals();

  // Enable stop search. Note: we must NOT steal focus here — otherwise typing
  // "196" would jump to the stop field the moment "19" matches a real service.
  el.stopInput.disabled = false;
  el.locateBtn.disabled = false;
  const dirs = terminalByDir.size;
  const stopCount = new Set(currentRouteStops.map((r) => r[R.CODE])).size;
  el.stopHint.textContent =
    `${stopCount} stops` + (dirs > 1 ? ` · ${dirs} directions` : "") +
    ` — search by name, road, or code.`;
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

function disableStopSearch(hint) {
  currentRouteStops = [];
  el.stopInput.value = "";
  el.stopInput.disabled = true;
  el.locateBtn.disabled = true;
  el.stopHint.textContent = hint;
  updateClear(el.stopInput, el.stopClear);
}

// ===========================================================================
// Step 2 — stop search
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
 * Build candidate stops grouped by direction, so the dropdown can show a
 * section per direction (labelled by that direction's terminal). Within each
 * group, stops are filtered by the query and ranked by distance (if we have
 * the user's location) or by stop sequence otherwise.
 */
function buildDirectionGroups(query) {
  const q = query.trim().toLowerCase();
  const groups = [];

  for (const dir of [...terminalByDir.keys()].sort((a, b) => a - b)) {
    // One entry per stop code within this direction.
    const seen = new Map();
    for (const r of currentRouteStops) {
      if (r[R.DIRECTION] !== dir) continue;
      const code = r[R.CODE];
      if (!seen.has(code)) seen.set(code, r);
    }

    let candidates = [];
    for (const route of seen.values()) {
      const c = makeCandidate(route);
      if (q) {
        const hay = `${c.desc} ${c.road} ${c.code}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      candidates.push(c);
    }

    if (userLocation) {
      candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    } else {
      candidates.sort((a, b) => a.route[R.SEQ] - b.route[R.SEQ]);
    }

    candidates = candidates.slice(0, 40); // cap per direction for sanity
    if (candidates.length) groups.push({ dir, label: directionLabel(dir), candidates });
  }

  return groups;
}

function renderStopResults(query) {
  if (el.stopInput.disabled) return;
  const groups = buildDirectionGroups(query);
  selectedRow = -1;

  const total = groups.reduce((n, g) => n + g.candidates.length, 0);
  if (total === 0) {
    el.stopResults.innerHTML =
      `<li class="stop-results__item" aria-disabled="true">No matching stops on this route.</li>`;
    openStopResults();
    return;
  }

  // Only show direction headers when there's more than one direction.
  const withHeaders = groups.length > 1;
  let html = "";
  let idx = 0; // running option index across groups (for ids / keyboard nav)
  for (const g of groups) {
    if (withHeaders) {
      html += `<li class="stop-results__group" role="presentation">${escapeHtml(g.label)}</li>`;
    }
    for (const c of g.candidates) {
      const distTag = c.distance != null
        ? `<span class="stop-results__dist">${formatDistance(c.distance)}</span>`
        : "";
      const name = escapeHtml(c.desc || c.road || `Stop ${c.code}`);
      const sub = escapeHtml(`${c.road} · ${c.code}`);
      html +=
        `<li class="stop-results__item" role="option" id="stop-opt-${idx}" ` +
            `aria-selected="false" data-code="${c.code}" data-dir="${c.dir}" data-index="${idx}">` +
          `<span><span class="stop-results__name">${name}</span>` +
          `<span class="stop-results__sub">${sub}</span></span>` +
          distTag +
        `</li>`;
      idx++;
    }
  }
  el.stopResults.innerHTML = html;

  // Wire clicks — carry the direction so the result opens on the side picked.
  el.stopResults.querySelectorAll(".stop-results__item[data-code]").forEach((li) => {
    li.addEventListener("click", () => selectStop(li.dataset.code, Number(li.dataset.dir)));
  });

  openStopResults();
}

function openStopResults() {
  el.stopResults.hidden = false;
  el.stopInput.setAttribute("aria-expanded", "true");
}

function hideStopResults() {
  el.stopResults.hidden = true;
  el.stopResults.innerHTML = "";
  selectedRow = -1;
  el.stopInput.setAttribute("aria-expanded", "false");
  el.stopInput.removeAttribute("aria-activedescendant");
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
    if (target) selectStop(target.dataset.code, Number(target.dataset.dir));
    return;
  } else if (e.key === "Escape") {
    hideStopResults();
    return;
  } else {
    return;
  }

  items.forEach((li, i) => li.setAttribute("aria-selected", i === selectedRow));
  if (selectedRow >= 0) {
    el.stopInput.setAttribute("aria-activedescendant", items[selectedRow].id);
    items[selectedRow].scrollIntoView({ block: "nearest" });
  } else {
    el.stopInput.removeAttribute("aria-activedescendant");
  }
}

/** Clear the service field and reset everything downstream of it. */
function onServiceClear() {
  el.serviceInput.value = "";
  onServiceInput();          // resets result, disables/clears stop search
  el.serviceInput.focus();
}

/** Clear the stop field, drop the result panel, and reopen the full list. */
function onStopClear() {
  el.stopInput.value = "";
  updateClear(el.stopInput, el.stopClear);
  resetResult();
  el.message.hidden = true;
  renderStopResults("");
  el.stopInput.focus();
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

// ===========================================================================
// Step 3 — result table + status (per direction)
// ===========================================================================

function selectStop(code, preferredDir) {
  hideStopResults();

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
  el.stopInput.value = stopName;
  updateClear(el.stopInput, el.stopClear);

  renderDirTabs(code);

  // Open on the direction the user picked from the dropdown, if it serves this
  // stop; otherwise fall back to the lowest-numbered direction.
  const dirs = [...resultDirMap.keys()].sort((a, b) => a - b);
  const startDir = resultDirMap.has(preferredDir) ? preferredDir : dirs[0];
  showDirection(startDir, code);

  el.result.hidden = false;
  el.message.hidden = true;
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
