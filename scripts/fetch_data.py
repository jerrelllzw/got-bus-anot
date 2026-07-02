#!/usr/bin/env python3
"""Fetch Singapore bus schedule data from LTA DataMall and write compact
static per-service JSON shards for the Got Bus Anot? web app.

The LTA DataMall API is *not* CORS-enabled and the account key must stay
secret, so we pull the data server-side (in CI) and commit a plain JSON file
that the static page can read directly.

Two endpoints are used:

* **BusRoutes** — one record per (ServiceNo, Direction, StopSequence,
  BusStopCode) with first/last bus times for weekday / Saturday / Sunday+PH.
* **BusStops** — descriptive + geographic info for each bus stop code.

Both endpoints paginate 500 records per call via the ``$skip`` query param.

Requires the environment variable ``LTA_ACCOUNT_KEY``.

Output is **sharded** so the browser only ever downloads the one service the
user asked about, instead of a single multi-megabyte blob:

    data/services.json                  # tiny index the page loads at boot
      { "generated": "...", "services": ["10", "196", "NR7", ...] }

    data/svc/<SERVICE>.json             # one file per service (uppercased name)
      {
        "service": "196",
        "generated": "...",
        "stops":  { "BusStopCode": [RoadName, Description, Latitude, Longitude] },
        "routes": [ [Direction, StopSequence, BusStopCode,
                     WD_First, WD_Last, SAT_First, SAT_Last,
                     SUN_First, SUN_Last], ... ]
      }

Each shard embeds only the stops on that service's route, so no global stop
map has to be downloaded. Both indices and shards are minified.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# --- Configuration -----------------------------------------------------------

BASE_URL = "https://datamall2.mytransport.sg/ltaodataservice"
BUS_ROUTES_URL = f"{BASE_URL}/BusRoutes"
BUS_STOPS_URL = f"{BASE_URL}/BusStops"

PAGE_SIZE = 500          # LTA returns at most 500 records per call.
REQUEST_TIMEOUT = 30     # seconds
MAX_RETRIES = 4          # per page, with exponential backoff
RETRY_BACKOFF = 2.0      # seconds (doubles each retry)

# Write to <repo>/data/ regardless of the working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
SVC_DIR = DATA_DIR / "svc"
INDEX_PATH = DATA_DIR / "services.json"


def load_dotenv() -> None:
    """Load KEY=VALUE pairs from a local .env file into os.environ.

    Minimal stdlib-only loader (no python-dotenv dependency). Existing
    environment variables take precedence, so CI secrets are never overridden.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Strip optional surrounding quotes from the value.
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get_account_key() -> str:
    """Return the LTA account key, or exit with a helpful message."""
    load_dotenv()
    key = os.environ.get("LTA_ACCOUNT_KEY", "").strip()
    if not key:
        sys.exit(
            "ERROR: LTA_ACCOUNT_KEY is not set.\n"
            "Get a free key at https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html\n"
            "then run:  LTA_ACCOUNT_KEY=your_key python scripts/fetch_data.py"
        )
    return key


def fetch_page(url: str, account_key: str, skip: int) -> list[dict]:
    """Fetch a single 500-record page, retrying transient failures."""
    full_url = f"{url}?$skip={skip}"
    request = Request(
        full_url,
        headers={"AccountKey": account_key, "accept": "application/json"},
    )

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                payload = json.loads(response.read().decode("utf-8"))
                # LTA wraps results in a "value" array (OData convention).
                return payload.get("value", [])
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as err:
            last_error = err
            wait = RETRY_BACKOFF * (2 ** attempt)
            print(f"  ! {full_url} failed ({err}); retrying in {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)

    raise RuntimeError(f"Giving up on {full_url} after {MAX_RETRIES} attempts: {last_error}")


def fetch_all(url: str, account_key: str, label: str) -> list[dict]:
    """Page through an endpoint until an empty page is returned."""
    records: list[dict] = []
    skip = 0
    print(f"Fetching {label} ...")
    while True:
        page = fetch_page(url, account_key, skip)
        if not page:
            break
        records.extend(page)
        skip += PAGE_SIZE
        print(f"  {label}: {len(records)} records", end="\r", flush=True)
        # LTA has no documented rate limit but be a good citizen.
        time.sleep(0.1)
    print(f"  {label}: {len(records)} records (done)")
    return records


def compact_routes(raw_routes: list[dict]) -> list[list]:
    """Convert verbose BusRoutes records into positional arrays."""
    compact: list[list] = []
    for r in raw_routes:
        compact.append([
            r.get("ServiceNo", ""),
            # Direction comes back as an int (1 or 2); keep it as-is.
            r.get("Direction", 0),
            r.get("StopSequence", 0),
            r.get("BusStopCode", ""),
            r.get("WD_FirstBus", ""),
            r.get("WD_LastBus", ""),
            r.get("SAT_FirstBus", ""),
            r.get("SAT_LastBus", ""),
            r.get("SUN_FirstBus", ""),
            r.get("SUN_LastBus", ""),
        ])
    return compact


def compact_stops(raw_stops: list[dict]) -> dict[str, list]:
    """Convert BusStops records into a code -> [road, desc, lat, lng] map."""
    stops: dict[str, list] = {}
    for s in raw_stops:
        code = s.get("BusStopCode", "")
        if not code:
            continue
        stops[code] = [
            s.get("RoadName", ""),
            s.get("Description", ""),
            s.get("Latitude", 0.0),
            s.get("Longitude", 0.0),
        ]
    return stops


def _write_json(path: Path, obj) -> None:
    """Write ``obj`` as minified UTF-8 JSON."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def write_shards(generated: str, routes: list[list], stops: dict[str, list]) -> None:
    """Group compact route records by service and write one shard per service
    plus a small ``services.json`` index.

    ``routes`` are the 10-element compact records produced by
    :func:`compact_routes` (service number in position 0). Each shard drops the
    service number (it's implied by the filename) and embeds only the stops that
    appear on that service's route.
    """
    # Group by uppercased service name so client lookups are case-insensitive.
    by_service: dict[str, dict] = {}
    for r in routes:
        service = str(r[0]).strip()
        if not service:
            continue
        key = service.upper()
        entry = by_service.setdefault(key, {"service": service, "routes": [], "codes": set()})
        entry["routes"].append(r[1:])       # [Direction, Seq, Code, WD_First, ...]
        code = r[3]
        if code:
            entry["codes"].add(code)

    # Start each run from a clean slate so services that disappear upstream are
    # not left behind as stale shards.
    if SVC_DIR.exists():
        for old in SVC_DIR.glob("*.json"):
            old.unlink()
    SVC_DIR.mkdir(parents=True, exist_ok=True)

    for key, entry in by_service.items():
        sub_stops = {c: stops[c] for c in entry["codes"] if c in stops}
        _write_json(SVC_DIR / f"{key}.json", {
            "service": entry["service"],
            "generated": generated,
            "stops": sub_stops,
            "routes": entry["routes"],
        })

    _write_json(INDEX_PATH, {
        "generated": generated,
        "services": sorted(by_service.keys()),
    })

    total_kb = sum(p.stat().st_size for p in SVC_DIR.glob("*.json")) / 1024
    print(
        f"Wrote {len(by_service)} service shards to {SVC_DIR.relative_to(REPO_ROOT)}/ "
        f"and {INDEX_PATH.relative_to(REPO_ROOT)} — {total_kb:.0f} KB total"
    )


def main() -> None:
    account_key = get_account_key()

    raw_routes = fetch_all(BUS_ROUTES_URL, account_key, "BusRoutes")
    raw_stops = fetch_all(BUS_STOPS_URL, account_key, "BusStops")

    if not raw_routes or not raw_stops:
        sys.exit("ERROR: got an empty response from LTA — aborting so we don't overwrite good data.")

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_shards(generated, compact_routes(raw_routes), compact_stops(raw_stops))


if __name__ == "__main__":
    main()
