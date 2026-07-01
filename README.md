# Last Bus When Ah? 🚏

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
scripts/fetch_data.py        # LTA -> sharded data/ (paginated, compacted)
.github/workflows/           # weekly + manual refresh, commits the shards
  update-data.yml
data/services.json           # index: { generated, services: [...] }  (loaded at boot)
data/svc/<SERVICE>.json      # one shard per service (stops embedded), loaded on demand
data/holidays.json           # dates that use the Sun/PH schedule (hand-maintained)
logic.js                     # pure, unit-tested helpers (times, distance, status)
index.html / style.css / script.js   # the static site
tests/logic.test.js          # Node unit tests for logic.js
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

  This regenerates `data/svc/*.json` and `data/services.json` (it never
  touches `data/holidays.json`). Commit them if you want (CI will keep them
  fresh afterwards). The script uses only the Python standard library — no
  `pip install` needed.

### 4. Enable GitHub Pages

1. **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Select the `main` branch and the `/ (root)` folder, then **Save**.
4. Your site goes live at `https://<username>.github.io/<repo>/` within a minute.

That's it — the weekly Action keeps the schedule data current.

## Using the app

1. Enter a **bus service number** (e.g. `196`).
2. The route's stops appear as **two lists — one per travel direction** (each
   labelled by its terminal), so you can scan the side heading the way you
   want and **tap a stop** for its times. Tap **📍 Near me** to sort each list
   by distance from you.
3. Read the **first/last** times for Weekday / Saturday / Sun-PH (today's row
   is highlighted). If the stop is served in **both directions**, a switcher
   (labelled by each direction's terminal) lets you flip between them. There's
   also a live status line for the last bus:
   - *Plenty of time* — last bus is >45 min away
   - *Due soon* — within 45 min, with a rough countdown
   - *Past scheduled* — just past the time, may still be running late
   - *Service has ended for today*

## Local preview

Because the page fetches JSON from `data/`, open it via a local web server
(not `file://`):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Tests

The date/time and distance logic lives in `logic.js` as pure functions, unit
tested with Node's built-in runner (no dependencies to install):

```bash
npm test        # or: node --test
```

## Known limitations

- **Public holidays are a hand-maintained list.** On dates listed in
  `data/holidays.json` the app shows the *Sun / PH* schedule. Only the
  fixed-date 2026 holidays (New Year's Day, Labour Day, National Day,
  Christmas) are seeded, because they're the same every year. The
  variable-date holidays (Chinese New Year, Good Friday, Hari Raya Puasa,
  Vesak Day, Hari Raya Haji, Deepavali) change yearly and **must be added**
  from [MOM's official gazette](https://www.mom.gov.sg/employment-practices/public-holidays)
  — otherwise those days fall back to the normal weekday/Saturday split.
- **No live vehicle tracking.** LTA's real-time Bus Arrival endpoint also isn't
  reachable from a static page without a proxy, so this app is scheduled-only.
- **After-midnight edge cases.** Times like `0030` are treated as belonging to
  the small hours of the next day for the countdown; unusual schedules may not
  be perfectly represented.
- **Data is only as fresh as the last workflow run** (weekly by default).

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
