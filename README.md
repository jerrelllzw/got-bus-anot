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
   from LTA (server-side) and writes a compact `data/data.json`.
2. A scheduled **GitHub Action** runs that script weekly and commits the
   refreshed data back to the repo.
3. `index.html` / `style.css` / `script.js` just read that static JSON —
   instant loads, no exposed key, no server.

```
scripts/fetch_data.py        # LTA -> data/data.json (paginated, compacted)
.github/workflows/           # weekly + manual refresh, commits data.json
  update-data.yml
data/data.json               # the committed dataset (sample until you fetch real)
index.html / style.css / script.js   # the static site
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

The repo ships with a small **sample** `data/data.json` so the page works
immediately. To pull the real ~23,000-record dataset:

- **In CI:** go to the **Actions** tab → **Update bus data** → **Run workflow**.
  It fetches from LTA and commits the real `data/data.json`.
- **Locally** (optional), if you have Python 3.9+:

  ```bash
  # macOS / Linux
  export LTA_ACCOUNT_KEY="your_key_here"
  python scripts/fetch_data.py

  # Windows PowerShell
  $env:LTA_ACCOUNT_KEY = "your_key_here"
  python scripts/fetch_data.py
  ```

  This overwrites `data/data.json`. Commit it if you want (CI will keep it
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
2. Search for a **stop** along that route — by name, road, or 5-digit code —
   or tap **📍 Near me** to rank stops on the route by distance from you.
3. Read the **first/last** times for Weekday / Saturday / Sun-PH (today's row
   is highlighted), plus a live status line for the last bus:
   - *Plenty of time* — last bus is >45 min away
   - *Due soon* — within 45 min, with a rough countdown
   - *Past scheduled* — just past the time, may still be running late
   - *Service has ended for today*

## Local preview

Because the page fetches `data/data.json`, open it via a local web server
(not `file://`):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Known limitations

- **No public-holiday calendar.** The *Sun / PH* row is LTA's own combined
  Sunday/public-holiday schedule; the app simply shows Sunday times on Sundays.
  It does **not** detect public holidays that fall on weekdays.
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
