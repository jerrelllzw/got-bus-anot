# Got Bus Anot? 🚏

A tiny static web app that shows the **scheduled first & last bus time** for any
Singapore bus service at any stop. No backend, no build step — just HTML/CSS/JS
served from GitHub Pages, reading a pre-generated JSON file.

> **Scheduled times only.** This is a quick-glance utility, not a live tracker.
> See [Known limitations](#known-limitations).

## How it works

The [LTA DataMall](https://datamall.lta.gov.sg/) API isn't CORS-enabled and its
account key must stay secret, so the browser can't call it directly. Instead:

1. `scripts/fetch_data.py` pulls the **BusRoutes** and **BusStops** datasets
   from LTA (server-side) and writes **sharded** JSON: a tiny index plus one
   small file per bus service.
2. A scheduled **GitHub Action** runs that script weekly and commits the
   refreshed data back to the repo.
3. `index.html` / `style.css` / `script.js` read that static JSON —
   the page loads a few KB for the one service you ask about, not a big blob.

Because the data is split per service, a visitor downloads roughly **5 KB**
(one service shard) instead of a multi-megabyte combined file. Shards are
cache-busted by the dataset's `generated` timestamp, so browsers cache them
until the next weekly refresh.

```
scripts/fetch_data.py        # LTA -> sharded data/ (paginated, compacted) + holidays
.github/workflows/           # daily + manual refresh, commits the shards
  update-data.yml
data/services.json           # index: { generated, services: [...] }  (loaded at boot)
data/svc/<SERVICE>.json      # one shard per service (stops embedded), loaded on demand
data/holidays.json           # dates that use the Sun/PH schedule (auto-refreshed)
logic.js                     # pure helpers (times, distance)
index.html / style.css / script.js   # the static site
manifest.webmanifest / sw.js / icon.svg   # PWA: installable + offline
```

## Setup

### 1. Get a free LTA DataMall account key

1. Go to the
   [LTA DataMall API request page](https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html).
2. Fill in the form. The key is emailed to you (usually within a day).
3. Keep it secret — treat it like a password. **Do not** paste it into code,
   commit it, or share it publicly.

### 2. Add the key as a GitHub Actions secret

1. Push this repo to GitHub.
2. Go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it exactly `LTA_ACCOUNT_KEY`, paste your key as the value, and save.

The workflow reads it via `${{ secrets.LTA_ACCOUNT_KEY }}` — the key never
appears in the repo or the built site.

### 3. Generate real data (first run)

The repo ships with committed shards under `data/svc/` so the page works
immediately. To refresh from LTA (the ~23,000-record dataset):

- **In CI:** go to the **Actions** tab → **Update bus data** → **Run workflow**.
  It fetches from LTA and commits the refreshed shards + `data/services.json`.
- **Locally** (optional), if you have Python 3.9+:

  ```bash
  # macOS / Linux
  export LTA_ACCOUNT_KEY="your_key_here"
  python scripts/fetch_data.py

  # Windows PowerShell
  $env:LTA_ACCOUNT_KEY = "your_key_here"
  python scripts/fetch_data.py
  ```

  This regenerates `data/svc/*.json`, `data/services.json`, and
  `data/holidays.json` (holidays come from the key-less
  [Nager.Date](https://date.nager.at/) API; a failure there leaves the existing
  holiday file untouched). Commit them if you want (CI will keep them fresh
  afterwards). The script uses only the Python standard library — no
  `pip install` needed.

### 4. Enable GitHub Pages

1. **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Select the `main` branch and the `/ (root)` folder, then **Save**.
4. Your site goes live at `https://<username>.github.io/<repo>/` within a minute.

That's it — the weekly Action keeps the schedule data current.

## Using the app

1. Enter a **bus service number** (e.g. `196`). Services with letter suffixes
   (`196A`, `NR7`) work too.
2. The route's stops show **one direction at a time**; a **direction toggle**
   (labelled by each terminal) flips between the two travel directions. **Tap a
   stop** for its times. Use the **filter box** to narrow long routes by stop
   name, or tap the **location button** to sort the list by distance from you
   (granting location once makes later visits sort automatically).
3. Read the **first/last** times for Weekday / Saturday / Sun-PH (today's row
   is highlighted; after-midnight times are tagged **+1**), for the direction
   you picked in the toggle.

## Local preview

Because the page fetches JSON from `data/`, open it via a local web server
(not `file://`):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Known limitations

- **No live vehicle tracking.** LTA's real-time Bus Arrival endpoint isn't
  reachable from a static page without a proxy, so this app is scheduled-only.
  Adding live arrivals would mean introducing a small server-side proxy to hold
  the account key — a deliberate departure from this app's no-backend design.
- **Public-holiday dates for lunar/Islamic holidays are estimates.** The
  holiday list is refreshed automatically from the
  [Nager.Date](https://date.nager.at/) API (current + next year, including the
  in-lieu Monday when a holiday falls on a Sunday). Movable holidays such as
  Hari Raya can occasionally differ by a day from
  [MOM's gazette](https://www.mom.gov.sg/employment-practices/public-holidays);
  edit `data/holidays.json` by hand to override a specific date.
- **After-midnight edge cases.** Times like `0030` are treated as belonging to
  the small hours of the next day for the countdown; unusual schedules may not
  be perfectly represented.
- **Data is only as fresh as the last workflow run** (daily by default).

## Shareable links & offline use

- **Shareable links.** The loaded service, chosen direction, and selected stop
  are kept in the URL (`?svc=196&dir=1&code=84009`), so a view can be
  bookmarked, shared, or restored after a refresh.
- **Installable / offline (PWA).** A `manifest.webmanifest` and `sw.js` service
  worker cache the app shell and each service you view, so the page installs to
  a home screen and works with no signal (e.g. on the bus). The index and
  holiday data are fetched network-first so they stay fresh when you're online.
  Bump `CACHE_VERSION` in `sw.js` when the shell files change.

## Data licence & attribution

This app contains information from
[LTA DataMall](https://datamall.lta.gov.sg/), accessed under the
[Singapore Open Data Licence v1.0](https://datamall.lta.gov.sg/content/dam/datamall/datasets/Legal/Singapore%20Open%20Data%20Licence.pdf).

It is **not affiliated with or endorsed by** the Land Transport Authority.
The licence permits commercial and non-commercial reuse and redistribution
provided the attribution above is displayed and LTA endorsement is not implied —
which is why the footer carries the notice.

## Licence

The application code in this repo is released under the MIT License. The bus
data itself remains subject to the Singapore Open Data Licence above.
