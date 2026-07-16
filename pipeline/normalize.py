"""Normalize raw Ex Ordo day dumps into docs/data/sessions.json.

Fetching (July 2026 API behaviour — it has changed once already):
  - day filter is `date=YYYY-MM-DD`; `day=`/`starts_at=` are silently ignored
  - `page_size` is clamped to 15 server-side (it used to honour 999), so loop
    `page=1..page_count` and concatenate the `data` arrays into one dump per day
  - expansion is comma-separated dotted paths, NOT `expand[]=` (that 500s):

      expand=virtual_content.schedule_event.schedule_event_presentations.paper.paper_authors,virtual_venue

  e.g. per day:
      https://event.ac2026.exordo.com/api/virtual_published_contents?date=2026-09-02&page=N&page_size=15&expand=...

Input:  data/raw/day_YYYY-MM-DD.json  (public API: virtual_published_contents)
Output: docs/data/sessions.json — one record per session, HTML stripped,
        mode (in-person/online/hybrid) lifted out of the title prefix.

Times: the API's outer starts_at/ends_at are UTC instants for the London
schedule; we keep them as ISO UTC and let the frontend render Europe/London.
The nested schedule_event times are placeholder junk — never use them.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "docs" / "data" / "sessions.json"

DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]

MODE_PREFIX = re.compile(r"^(IN-PERSON|IN PERSON|ONLINE|HYBRID|NO SESSION)\s*[-–—]?\s*", re.I)
TAG = re.compile(r"<[^>]+>")
WS = re.compile(r"[ \t]+")

# Session codes are sponsor-group + number, e.g. GFGRG9 -> GFGRG.
CODE_GROUP = re.compile(r"^([A-Za-z]+)")


def strip_html(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"</(p|li|ul|ol|div|br|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<li[^>]*>", "- ", s, flags=re.I)
    s = TAG.sub(" ", s)
    s = html.unescape(s)
    s = WS.sub(" ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s)
    return s.strip()


def parse_mode(title: str) -> tuple[str, str]:
    m = MODE_PREFIX.match(title)
    if not m:
        return "unspecified", title.strip()
    mode = m.group(1).upper().replace(" ", "-")
    mode = {"IN-PERSON": "in-person", "ONLINE": "online", "HYBRID": "hybrid", "NO-SESSION": "none"}[mode]
    return mode, title[m.end():].strip()


def main() -> None:
    sessions = []
    for day in DAYS:
        raw = json.loads((RAW / f"day_{day}.json").read_text())
        for rec in raw["data"]:
            se = rec["virtual_content"]["schedule_event"]
            mode, title = parse_mode(se["title"] or "")
            if mode == "none" or not title:
                continue
            papers = []
            for sep in sorted(se.get("schedule_event_presentations") or [], key=lambda x: x["position"]):
                p = sep.get("paper") or {}
                if not p.get("title"):
                    continue
                affs = sorted({a.get("identity_string", "") for a in p.get("paper_authors") or [] if a.get("identity_string")})
                papers.append({"title": p["title"].strip(), "affiliations": affs})
            code = (se.get("code") or "").strip()
            group = (CODE_GROUP.match(code).group(1).upper() if code and CODE_GROUP.match(code) else "")
            sessions.append({
                "id": rec["id"],
                # schedule_event id — the one the public site routes on
                # (event.ac2026.exordo.com/session/<eid>/<slug>), distinct from
                # rec["id"] for most sessions.
                "eid": se.get("id"),
                "code": code,
                "group": group,
                "title": title,
                "mode": mode,
                "type": se.get("type") or "",
                "day": day,
                "start": rec["starts_at"],
                "end": rec["ends_at"],
                "venue": (rec.get("virtual_venue") or {}).get("name") or "",
                "description": strip_html(se.get("description")),
                "papers": papers,
            })
    sessions.sort(key=lambda s: (s["start"], s["venue"], s["id"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"conference": "RGS-IBG Annual International Conference 2026",
                               "generated_from": "event.ac2026.exordo.com public programme API",
                               "timezone": "Europe/London",
                               "sessions": sessions}, ensure_ascii=False))
    n_papers = sum(len(s["papers"]) for s in sessions)
    print(f"{len(sessions)} sessions, {n_papers} papers -> {OUT} ({OUT.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
