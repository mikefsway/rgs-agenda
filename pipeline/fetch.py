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

Refuses to write an empty or sharply shrunken programme over a working one; see
SHRINK_FLOOR and `--force`.
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
    "virtual_venue,"
    # Sessions in the RGS-IBG building itself carry no virtual_venue at all —
    # their room is on virtual_stage ("Ondaatje Theatre, RGS-IBG"). That is 164
    # of 593 sessions, i.e. every one that would otherwise read "venue tbc".
    "virtual_stage"
)
PAGE_SIZE = 15  # server clamps to this anyway; asking for more just lies to you
# A refresh replaces the whole programme, so a fetch that comes back short is
# the one failure mode that quietly destroys data rather than making noise.
SHRINK_FLOOR = 0.9  # of what the site already ships; below this, refuse


def get_json(url: str, tries: int = 4) -> dict:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"Accept": "application/json", "User-Agent": "agenda-navigator-pipeline/1.0"}
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


def shipped_n_sessions() -> int | None:
    """How many sessions the deployed site currently carries, if it says."""
    try:
        return json.loads((ROOT / "docs" / "data" / "meta.json").read_text())["n_sessions"]
    except (OSError, KeyError, json.JSONDecodeError):
        return None


def main() -> None:
    args = sys.argv[1:]
    force = "--force" in args
    positional = [a for a in args if not a.startswith("-")]
    dest = Path(positional[0]) if positional else RAW

    # Fetch everything before writing anything. A run that refuses halfway
    # through would otherwise leave two new day files beside two old ones, and
    # normalize.py cannot tell that apart from a real programme.
    dumps = {}
    for day in DAYS:
        dumps[day] = fetch_day(day)
        print(f"{day}: {len(dumps[day]['data'])} records")
    total = sum(len(d["data"]) for d in dumps.values())

    empty = [day for day, d in dumps.items() if not d["data"]]
    if empty and not force:
        raise SystemExit(
            f"refusing to write: no sessions for {', '.join(empty)}.\n"
            "The API answers 200 with count=0 rather than 401 when it does not want to\n"
            "show you the programme, so an empty fetch looks exactly like a successful\n"
            "one. Since 19 Aug 2026 the programme is delegates-only and this is what an\n"
            "unauthenticated fetch gets. Writing it out would replace the shipped\n"
            "programme with nothing. --force if you really mean it."
        )

    shipped = shipped_n_sessions()
    if shipped and total < shipped * SHRINK_FLOOR and not force:
        raise SystemExit(
            f"refusing to write: {total} sessions against {shipped} shipped.\n"
            "A real programme edit moves a handful of sessions; a drop this size is the\n"
            "API showing you less than it has. --force if you really mean it."
        )

    dest.mkdir(parents=True, exist_ok=True)
    for day, dump in dumps.items():
        (dest / f"day_{day}.json").write_text(json.dumps(dump, ensure_ascii=False))
    print(f"{total} records -> {dest}")


if __name__ == "__main__":
    main()
