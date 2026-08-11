"""Fetch the Ex Ordo day dumps that normalize.py reads.

This used to be prose in normalize.py's header, which is fine until you need it
under time pressure and the API has moved again. The parameters here are the
ones that actually work (July/August 2026); the header of normalize.py explains
*why* each one is shaped the way it is:

  - `date=YYYY-MM-DD` is the only working day filter
  - `page_size` is clamped to 15 server-side, so page through `page_count`
  - expansion is a comma-separated list of dotted paths; `expand[]=` 500s

Output matches what the API would return for one giant page — the head fields
plus every day's rows concatenated into `data` — so normalize.py doesn't need to
know that paging happened.

    python3 pipeline/fetch.py [dest_dir]     # default: data/raw
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]
BASE = "https://event.ac2026.exordo.com/api/virtual_published_contents"
EXPAND = (
    "virtual_content.schedule_event.schedule_event_presentations.paper.paper_authors,"
    "virtual_venue"
)
PAGE_SIZE = 15  # server clamps to this anyway; asking for more just lies to you


def get_json(url: str, tries: int = 4) -> dict:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"Accept": "application/json", "User-Agent": "traverse-pipeline/1.0"}
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise SystemExit(f"giving up on {url}: {last}")


def fetch_day(day: str) -> dict:
    page, page_count, rows, head = 1, 1, [], None
    while page <= page_count:
        data = get_json(f"{BASE}?date={day}&page={page}&page_size={PAGE_SIZE}&expand={EXPAND}")
        if head is None:
            head = {k: v for k, v in data.items() if k != "data"}
        page_count = data["page_count"]
        rows.extend(data["data"])
        page += 1
    assert head is not None
    # A short read here is how a silently-truncated refresh gets committed.
    if head.get("count") is not None and len(rows) != head["count"]:
        raise SystemExit(f"{day}: got {len(rows)} rows, API said count={head['count']}")
    head["page"], head["page_size"], head["data"] = "1", len(rows), rows
    return head


def main() -> None:
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else RAW
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    for day in DAYS:
        dump = fetch_day(day)
        (dest / f"day_{day}.json").write_text(json.dumps(dump, ensure_ascii=False))
        total += len(dump["data"])
        print(f"{day}: {len(dump['data'])} records")
    print(f"{total} records -> {dest}")


if __name__ == "__main__":
    main()
