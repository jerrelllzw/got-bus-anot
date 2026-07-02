/* ============================================================================
   Got Bus Anot? — static front-end logic.

   Data is sharded (see scripts/fetch_data.py):
     * data/services.json      — tiny index of every service, loaded at boot.
     * data/svc/<SERVICE>.json  — one file per service, loaded on demand, with
                                  only that route's stops embedded.
     * data/holidays.json       — dates that use the Sun/PH schedule.

   So a visitor downloads a few KB for the one service they ask about instead
   of a multi-megabyte blob. Pure helpers live in logic.js.

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
const { formatHHmm, isAfterMidnight, dayType, haversine, formatDistance } = self;

// localStorage keys for the little bits of state we persist between visits.
const LS = { GEO: "lbwa:geo" };

// --- State -----------------------------------------------------------------
let INDEX = null;            // { generated, services: Set<string> }
let HOLIDAYS = new Set();    // "YYYY-MM-DD" dates on the Sun/PH schedule
const shardCache = new Map();// service -> loaded shard (avoid refetching)

let currentService = null;   // the loaded shard { service, stops, routes }
let currentRouteStops = [];  // currentService.routes (the current service's records)
let terminalByDir = new Map();// direction -> terminal stop description
let serviceToken = 0;        // guards against out-of-order async shard loads

let userLocation = null;     // { lat, lng } once geolocation succeeds
let stopFilter = "";         // text narrowing the direction lists
let activeListDir = null;    // which direction the single stop list is showing

let activeCode = null;       // stop code currently shown in the result


// --- DOM refs --------------------------------------------------------------
const el = {
  clock:          document.getElementById("clock"),
  serviceInput:   document.getElementById("service-input"),
  serviceClear:   document.getElementById("service-clear"),
  stopHint:       document.getElementById("stop-hint"),
  serviceHint:    document.getElementById("service-hint"),
  locateBtn:      document.getElementById("locate-btn"),
  stopTools:       document.getElementById("stop-tools"),
  stopFilter:      document.getElementById("stop-filter"),
  stopFilterClear: document.getElementById("stop-filter-clear"),
  stopDirToggle:  document.getElementById("stop-dir-toggle"),
  stopLists:      document.getElementById("stop-lists"),
  result:         document.getElementById("result"),
  resultBadge:    document.getElementById("result-badge"),
  resultTerminal: document.getElementById("result-terminal"),
  resultStop:     document.getElementById("result-stop"),
  resultRoad:     document.getElementById("result-road"),
  resultCode:     document.getElementById("result-code"),
  timesBody:      document.getElementById("times-body"),
  message:        document.getElementById("message"),
  timestamp:      document.getElementById("data-timestamp"),
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

  // Footer freshness stamp, shown in Singapore time to match the "SGT" label.
  if (INDEX.generated) {
    const d = new Date(INDEX.generated);
    el.timestamp.textContent = isNaN(d)
      ? INDEX.generated
      : d.toLocaleString("en-SG", {
          timeZone: "Asia/Singapore",
          day: "numeric", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: false,
        });
  }

  startClock();
  wireEvents();
}

/** Live Singapore-time clock in the top bar (HH:MM), ticking each second. */
function startClock() {
  const tick = () => {
    el.clock.textContent = new Date().toLocaleTimeString("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  };
  tick();
  setInterval(tick, 1000);
}

function wireEvents() {
  el.serviceInput.addEventListener("input", onServiceInput);
  el.locateBtn.addEventListener("click", onLocate);
  el.serviceClear.addEventListener("click", onServiceClear);
  el.stopFilter.addEventListener("input", onStopFilter);
  el.stopFilterClear.addEventListener("click", onStopFilterClear);
  el.stopDirToggle.addEventListener("click", onStopDirToggle);
  el.stopDirToggle.addEventListener("keydown", onStopDirToggleKey);

  // Prevent the form from actually submitting/reloading.
  document.getElementById("search-form").addEventListener("submit", (e) => e.preventDefault());
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
    el.serviceHint.textContent = "Enter a service number to load its stops.";
    clearStopLists("Pick a service first.");
    return;
  }

  if (!INDEX.services.has(service)) {
    currentService = null;
    el.serviceHint.textContent = `No service "${service}" found.`;
    clearStopLists("Pick a service first.");
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

  // Fresh service — start its stop filter empty and reveal it, and let the
  // list default to the first direction.
  stopFilter = "";
  el.stopFilter.value = "";
  el.stopTools.hidden = false;
  updateClear(el.stopFilter, el.stopFilterClear);
  activeListDir = null;

  el.serviceHint.textContent = "";
  // The new list already honours a location fix from earlier this session.
  setLocateState(userLocation ? "active" : "idle");
  el.stopHint.textContent = "";
  renderStopLists();

  // If the user already granted location on a past visit, sort by distance
  // straight away (silently — no fresh permission prompt).
  maybeAutoLocate();
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
  el.stopTools.hidden = true;
  el.stopFilter.value = "";
  el.stopFilterClear.hidden = true;
  stopFilter = "";
  el.stopDirToggle.hidden = true;
  el.stopDirToggle.innerHTML = "";
  activeListDir = null;
  el.stopHint.textContent = hint;
}

/** Narrow the list as the user types a stop name. */
function onStopFilter() {
  stopFilter = el.stopFilter.value.trim().toLowerCase();
  updateClear(el.stopFilter, el.stopFilterClear);
  renderStopLists();
}

/** Clear the stop filter and restore the full list. */
function onStopFilterClear() {
  el.stopFilter.value = "";
  stopFilter = "";
  updateClear(el.stopFilter, el.stopFilterClear);
  renderStopLists();
  el.stopFilter.focus();
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

    let candidates = [...seen.values()].map(makeCandidate);
    if (stopFilter) candidates = candidates.filter(matchesFilter);
    if (userLocation) {
      candidates.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    } else {
      candidates.sort((a, b) => a.route[R.SEQ] - b.route[R.SEQ]);
    }

    // Keep every direction (even when a filter empties it) so the toggle is stable.
    groups.push({ dir, label: directionLabel(dir), candidates });
  }

  return groups;
}

/** Does a stop candidate match the current filter text (name / road / code)? */
function matchesFilter(c) {
  const hay = `${c.desc} ${c.road} ${c.code}`.toLowerCase();
  return hay.includes(stopFilter);
}

/**
 * Render one tappable list at a time, with a direction toggle above it. The
 * toggle's DOM is kept stable across renders so its active-segment "thumb" can
 * slide between directions; the list below shows the active direction's stops.
 */
function renderStopLists() {
  const groups = buildDirectionGroups();
  if (groups.length === 0) {
    hideDirToggle();
    el.stopLists.innerHTML = "";
    return;
  }

  // Keep the chosen direction if it's still around; otherwise default to first.
  if (activeListDir == null || !groups.some((g) => g.dir === activeListDir)) {
    activeListDir = groups[0].dir;
  }
  const active = groups.find((g) => g.dir === activeListDir);

  renderDirToggle(groups);       // (re)build only when the direction set changes
  updateDirToggleActive(groups); // slide the thumb + set aria-selected
  renderStopListBody(active);
}

function hideDirToggle() {
  el.stopDirToggle.hidden = true;
  el.stopDirToggle.innerHTML = "";
  el.stopDirToggle.dataset.sig = "";
  el.stopDirToggle.classList.remove("dir-toggle--static");
  el.stopDirToggle.removeAttribute("role");
  el.stopDirToggle.removeAttribute("tabindex");
  el.stopDirToggle.removeAttribute("aria-label");
}

/**
 * Build the toggle once per direction set (stable DOM = animatable). With two+
 * directions the whole control is one button (click flips direction); a single
 * direction (loop service) renders the same look but static — it doubles as the
 * list header.
 */
function renderDirToggle(groups) {
  if (groups.length === 0) { hideDirToggle(); return; }
  const sig = groups.map((g) => g.dir).join(",");
  if (el.stopDirToggle.dataset.sig === sig && !el.stopDirToggle.hidden) return;

  const interactive = groups.length > 1;
  el.stopDirToggle.dataset.sig = sig;
  el.stopDirToggle.style.setProperty("--n", groups.length);
  el.stopDirToggle.classList.toggle("dir-toggle--static", !interactive);
  if (interactive) {
    el.stopDirToggle.setAttribute("role", "button");
    el.stopDirToggle.setAttribute("tabindex", "0");
  } else {
    el.stopDirToggle.removeAttribute("role");
    el.stopDirToggle.removeAttribute("tabindex");
    el.stopDirToggle.removeAttribute("aria-label");
  }
  el.stopDirToggle.innerHTML = dirToggleMarkup(groups.map((g) => ({ dir: g.dir, label: g.label })));
  el.stopDirToggle.hidden = false;
}

/** Shared markup for a segmented toggle: sliding thumb + one label per segment. */
function dirToggleMarkup(segments) {
  return (
    `<span class="dir-toggle__thumb" aria-hidden="true"><span class="dir-toggle__fill"></span></span>` +
    segments
      .map((s) =>
        `<span class="dir-toggle__seg" data-dir="${s.dir}">` +
          `<span class="dir-toggle__seg-label">${escapeHtml(s.label)}</span>` +
        `</span>`
      )
      .join("")
  );
}

/** Slide the thumb to `idx` within a toggle and mark that segment selected. */
function moveThumb(toggle, idx) {
  toggle.querySelectorAll(".dir-toggle__seg").forEach((seg, i) => {
    seg.setAttribute("aria-selected", String(i === idx));
  });
  const thumb = toggle.querySelector(".dir-toggle__thumb");
  if (thumb && idx >= 0) thumb.style.transform = `translateX(${idx * 100}%)`;
}

/** Play the "flow" stretch as the thumb travels from oldIdx to newIdx. */
function flowThumb(toggle, oldIdx, newIdx) {
  const thumb = toggle.querySelector(".dir-toggle__thumb");
  const fill = thumb && thumb.querySelector(".dir-toggle__fill");
  if (!fill) return;
  fill.style.transformOrigin = newIdx > oldIdx ? "left center" : "right center";
  thumb.classList.remove("is-flowing");
  void thumb.offsetWidth; // restart the animation
  thumb.classList.add("is-flowing");
}

/** Point the thumb at the active direction and mark the selected segment. */
function updateDirToggleActive(groups) {
  if (groups.length === 0) return;
  const idx = groups.findIndex((g) => g.dir === activeListDir);
  moveThumb(el.stopDirToggle, idx);
  if (groups.length > 1 && groups[idx]) {
    el.stopDirToggle.setAttribute("aria-label", `Direction ${groups[idx].label} — tap to switch`);
  }
}

function renderStopListBody(active) {
  // The active direction's stops (or an empty-filter message).
  if (active.candidates.length === 0) {
    el.stopLists.innerHTML = stopFilter
      ? `<p class="stop-lists__empty">No stops match “${escapeHtml(stopFilter)}”.</p>`
      : "";
    return;
  }

  let items = "";
  for (const c of active.candidates) {
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
  el.stopLists.innerHTML =
    `<section class="stop-list"><ul class="stop-list__items">${items}</ul></section>`;

  // Tap or keyboard-activate a stop — carry the direction it was listed under.
  el.stopLists.querySelectorAll(".stop-list__item").forEach((li) => {
    const pick = () => selectStop(li.dataset.code, Number(li.dataset.dir));
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
  });

  // Re-apply the selection highlight (the list was just rebuilt).
  if (activeCode != null) markSelectedStop(activeCode);
}

/** The whole control is one button: flip to the next direction (with a flow). */
function onStopDirToggle() {
  const dirs = [...el.stopDirToggle.querySelectorAll(".dir-toggle__seg")]
    .map((seg) => Number(seg.dataset.dir));
  if (dirs.length < 2) return;

  const oldIdx = dirs.indexOf(activeListDir);
  const newIdx = (oldIdx + 1) % dirs.length;
  activeListDir = dirs[newIdx];
  resetResult(); // switching direction clears the current selection + result card
  renderStopLists();

  flowThumb(el.stopDirToggle, oldIdx, newIdx);
  const list = el.stopLists.querySelector(".stop-list, .stop-lists__empty");
  if (list) list.classList.add("stop-list--enter");
}

/** Keyboard activation for the toggle button (Enter / Space). */
function onStopDirToggleKey(e) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStopDirToggle(); }
}

/** Highlight the chosen stop in the list (if its direction is showing). */
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
  setLocateState("locating");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      saveJSON(LS.GEO, true); // remember consent so future visits auto-sort
      setLocateState("active");
      el.stopHint.textContent = "";
      renderStopLists();
    },
    (err) => {
      setLocateState("idle");
      el.stopHint.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — stops stay in route order."
          : "Couldn't get your location — stops stay in route order.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

/** Reflect the location button's state without disturbing its icon. */
function setLocateState(state) {
  el.locateBtn.classList.toggle("is-locating", state === "locating");
  el.locateBtn.classList.toggle("is-active", state === "active");
  // Once the list is sorted by location there's nothing more to do, so disable it.
  el.locateBtn.disabled = state === "locating" || state === "active";
  el.locateBtn.title =
    state === "active"  ? "List sorted by your location" :
    state === "locating" ? "Locating…" :
    "Use my location";
  el.locateBtn.setAttribute("aria-label", el.locateBtn.title);
}

/**
 * If the user granted location on a past visit and the browser still reports
 * that permission as granted, fetch it silently so the lists sort by distance
 * without another button tap. Never prompts on its own — that stays opt-in.
 */
function maybeAutoLocate() {
  if (userLocation) return;                          // already have it this session
  if (!navigator.geolocation) return;
  if (loadJSON(LS.GEO, false) !== true) return;      // never opted in before
  if (!(navigator.permissions && navigator.permissions.query)) return;

  navigator.permissions.query({ name: "geolocation" })
    .then((perm) => {
      if (perm.state !== "granted") return;
      setLocateState("locating");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setLocateState("active");
          renderStopLists();
        },
        () => {
          setLocateState("idle");
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
      );
    })
    .catch(() => {});
}

// ===========================================================================
// Step 3 — result table (per direction)
// ===========================================================================

function selectStop(code, preferredDir) {
  // Show the stop for the direction it was tapped under (the user already chose
  // a direction via the toggle). Terminals appear in both directions with
  // different times, so match the tapped direction; otherwise take whichever
  // direction serves this stop.
  let route = null;
  for (const r of currentRouteStops) {
    if (r[R.CODE] !== code) continue;
    if (r[R.DIRECTION] === preferredDir) { route = r; break; }
    if (!route) route = r;
  }
  if (!route) return;

  activeCode = code;
  const stop = currentService.stops[code];
  const stopName = stop ? (stop[S.DESC] || stop[S.ROAD]) : `Stop ${code}`;
  el.resultStop.textContent = stopName;
  el.resultRoad.textContent = stop ? stop[S.ROAD] : "";
  el.resultCode.textContent = code;
  markSelectedStop(code);

  const dir = route[R.DIRECTION];
  el.resultBadge.textContent = currentServiceId();
  const terminal = terminalByDir.get(dir);
  el.resultTerminal.textContent = terminal ? `→ ${terminal}` : directionLabel(dir);
  renderTimes(route);

  el.result.hidden = false;
  el.message.hidden = true;
  el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      const badge = row.key === today ? ` <span class="today-badge">Today</span>` : "";
      return (
        `<tr${cls}>` +
          `<td>${row.label}${badge}</td>` +
          `<td>${renderTime(row.first)}</td>` +
          `<td>${renderTime(row.last)}</td>` +
        `</tr>`
      );
    })
    .join("");
}

/** A schedule time with an amber colon and a "+1" tag for after-midnight runs. */
function renderTime(hhmm) {
  const t = formatHHmm(hhmm);
  if (t === "—") return t;
  const [h, m] = t.split(":");
  const next = isAfterMidnight(hhmm) ? `<span class="t-next">+1</span>` : "";
  return `${h}<span class="t-colon">:</span>${m}${next}`;
}

// ===========================================================================
// Persistence
// ===========================================================================

/** The service currently loaded (canonical casing from the shard). */
function currentServiceId() {
  return currentService ? currentService.service : el.serviceInput.value.trim().toUpperCase();
}

// --- Tiny localStorage wrappers (never throw; storage may be unavailable) ---

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* private mode / quota — non-fatal, the app still works this session. */
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function resetResult() {
  el.result.hidden = true;
  activeCode = null;
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
