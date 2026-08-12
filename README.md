# Agenda Navigator — a personalised route through RGS-IBG 2026

Tell it what you've worked on and what you want from the week; get a suggested
personal agenda for the RGS-IBG Annual International Conference 2026
(1–4 September, London), with reasons for each pick, alternatives per timeslot,
and genuine clashes surfaced rather than silently resolved.

**Privacy model: everything runs in the browser.** The programme ships as
precomputed embeddings; the user's text is embedded locally with
[transformers.js](https://huggingface.co/docs/transformers.js) (bge-small,
~30 MB, cached after first visit; wasm-q8, the only backend — the WebGPU fast
path was removed in July 2026 after it returned finite garbage on the one real
GPU it met) and never leaves the device. No account, no tracking, no server. The profile is
stored in `localStorage` as a fraglet-shaped JSON (`{title, brief, detail,
category, domain, tags, visibility: "private"}`) and can be downloaded; see
[fraglet.org](https://fraglet.org). The computed route and the profile's
embeddings persist locally too, and a service worker caches the shell and
data — so on conference wifi (or none) the page opens straight to your route.

Two off-origin requests remain and neither carries your text: the library from
jsDelivr and the model from Hugging Face, both on first visit only. Fonts are
served from this repo rather than from Google, because a webfont link would put
every visitor's IP address in front of a third party on a page that promises the
opposite. A `Content-Security-Policy` meta tag caps what a compromised CDN could
do with a page that is holding your whole publication list — worth having,
because `import()` of an ES module can't carry an integrity hash, so jsDelivr is
trusted rather than verified. One caveat the tool can't fix from inside: on a
GitHub Pages user site every repo under the account shares an origin, so
`localStorage` here is readable by other pages on the same account.

## Architecture

```
pipeline/            build-time, runs on any machine with Python
  fetch.py           public Ex Ordo API -> data/raw/day_*.json
  normalize.py       raw Ex Ordo JSON -> docs/data/sessions.json
  embed.py           sessions -> facet embeddings (bge-small, float16)
docs/                the static site (GitHub Pages serves this directory)
  index.html/app.js/style.css
  build.html/build.js    "build one for your conference" — writes a porting prompt
  scholar.js             deterministic cleanup for pasted publication lists
  sw.js                  service worker: shell + data cached for offline use
  data/sessions.json     593 sessions, 2,217 paper titles (1.7 MB)
  data/embeddings.bin    3,309 facets x 384 dims, float16 (2.5 MB)
  data/facets.json       row -> session mapping + evidence labels
  fonts/                 IBM Plex, self-hosted (320 kB) — no Google Fonts call
test/                no deps, no runner — plain node scripts
  parse.test.mjs       the Scholar parser against a real 68-article profile
  data.test.mjs        the shipped data files against each other
  monitor.mjs          the deployed site and what it depends on
  fixtures/            a real Scholar profile; keep it real (see CLAUDE.md)
.github/workflows/   tests on push; monitor daily
data/raw/            fetched Ex Ordo day dumps — gitignored: a build input, and
                     the API response verbatim, contact addresses and all
PORTING.md           how to point all of the above at a different conference
.claude/skills/      port-navigator — the same, as a Claude Code skill
```

No build step: `docs/` is plain ES modules, served as-is.

### Matching engine

Lifted from [ucl-explorer](https://github.com/mikefsway/ucl-explorer):

- **Facet model** — each session is embedded as several rows (title+description
  chunks, plus one row per paper title). Session score =
  `0.75 * best_facet + 0.25 * mean(top 3)`, so one strongly matching paper can
  surface its session, and the matched facets are shown as **evidence**
  ("Matches paper X — from your '…'").
- The profile is embedded with the bge query prefix; per facet we keep the
  best-matching chunk so evidence cites *which part* of the profile matched.

### Two boxes, two pools

The profile is asked for in two parts, and they are **scored as separate pools**
and blended: `facet = w_works * best_works + w_goals * best_goals`.

- **What you've worked on** — retrospective, high-volume. A Google Scholar paste
  is cleaned deterministically to titles (authors, venues, citation counts and
  page furniture stripped; see `parseWorks` in `docs/app.js`), **one title per
  chunk**: packing unrelated titles into a 420-char chunk embeds the centroid of
  a dozen topics and points nowhere. A normal profile goes in whole (the 120-title
  cap is a backstop, not an editorial choice); titles are sorted newest-first so
  that if the cap ever does bite, ordering *is* the recency prioritisation.
  Anything that isn't a publication list falls back to prose chunking.

  Two rules there are structural rather than cosmetic, and both were found by
  running a real 68-article profile through it. `sliceToTable` drops everything
  above the `Title / Cited by / Year` header — the stats block and co-author
  cards contain lines no shape test can separate from titles ("Based on funding
  mandates", "University of Exeter"). And cited-by/year arrive as **one
  whitespace-separated line** (`366    2017`, sometimes `36*    2015`), not a
  cell each, so the row's trailing numbers are parsed as a group with the last
  year-shaped one winning. Testing `Number(line)` instead silently loses nearly
  every year, and with it the recency ordering.
- **What you're working on now** — prospective, short, and absent from any
  publication list. Its weight scales with how much was actually written, so one
  vague line can't carry half the score.

The pools must stay separate: scoring takes the max over chunks per facet, so a
single pool would let 40 title chunks outvote 1 goals chunk purely on volume and
the second box would do nothing. Blending per-source bests instead rewards
**agreement** — a session both boxes reach outranks one either reaches alone,
which is the point of asking twice. Sessions in the top slice of *both*
distributions are badged; the cut-off is a percentile, not an absolute
similarity, because bge scores sit in a narrow corpus-dependent band where any
fixed threshold badges everything or nothing.

### Agenda assembly

- Sessions grouped into parallel timeslots (4 main blocks/day, ~43–49 options each).
- Top pick per slot with evidence, match bar, and the session's contents
  (description + paper list + link to the official Ex Ordo page, which routes
  on `eid`); next 3 as collapsible alternatives. Rooms come from `virtual_venue`
  or, for the 164 sessions inside the RGS-IBG building, `virtual_stage`.
- **Clash rule** (from gridflex-sim `household_flex`): if the gap between the
  top two is in the closest fifth of the slots you're actually deciding
  (a percentile, not a distance), render a fork with both options. Never
  auto-resolve.
- **Pins and dismissals**: "not this one" re-ranks the slot, "make this my
  pick" resolves it; both persist and re-rank instantly from scores in memory.
- Slots with no strong match are honestly labelled.
- Results are tabbed: the **route**, the **closest papers** (paper-granular,
  under the session aggregate), **institutions & groups** (institutions by
  presenting affiliation + RGS-IBG research groups), and a **look-up** ("where
  did session X rank for me, and why"). That tab was called "People" until it
  was pointed out that it shows neither authors nor names; the label now
  matches what the public data actually supports.
- **ICS export** of the chosen route; unresolved clashes export as two
  overlapping events, which is what they are.
- **A brief for your own LLM** — the route, your profile, and the top 14 of
  every timeslot rather than the four the page draws, as markdown on the
  clipboard. It asks the model to question you before answering and to use what
  it already knows about you, which is the one input this tool can't have. A
  second opinion on the route rather than a second route: the embedding pass
  ranks 593 sessions without getting bored, and cannot do "no more of that,
  I've had a decade of it". This is the only feature here that sends your text
  off your device, by your choice, and the page says so next to the button.
- During 1–4 September the route marks the current/next slot and opens there.

## Data provenance

Programme fetched 11 August 2026 from the **public** Ex Ordo programme API
(`event.ac2026.exordo.com/api/virtual_published_contents`, no auth) — the final
programme, which replaced the July draft's placeholder rooms ("In-person 10")
with real ones and settled the running order: 103 draft sessions went,
75 arrived, 518 stayed, and the paper count rose 2,074 → 2,217. Paper abstracts are
blanked in the public API; matching uses session descriptions and paper titles.
**Paper author names are withheld** — `paper_authors` carries only a presenting
affiliation, and asking the API to expand the user behind it makes it drop the
author rows altogether. Email addresses that convenors put in their session
descriptions are redacted to `[email removed]` by `normalize.py`, and stripped
from affiliations entirely: they are public on the programme site in context,
but `sessions.json` is one file served to every visitor, which would turn them
into a scrapeable list. `data.test.mjs` fails if any get through. Convenor and chair names *are* public (747 people across
539 sessions, via `session_organisers`), so naming convenors remains possible
if the tab ever wants people in it; see CLAUDE.md.
Re-run all three steps after any further programme change:

```
python3 pipeline/fetch.py       # -> data/raw/day_YYYY-MM-DD.json (paged; see its header)
python3 pipeline/normalize.py   # -> docs/data/sessions.json
<venv-with-sentence-transformers>/bin/python pipeline/embed.py
```

`embed.py` is not optional after a `normalize.py` change, even a display-only
one: `facets.json` indexes sessions by row, so anything that reorders
`sessions.json` invalidates the matrix. The browser refuses a mismatched pair
via `order_sig` rather than quietly scoring against the wrong sessions.

Then bump `CACHE` in `docs/sw.js`: the data files only make sense as a set, and
stale-while-revalidate will otherwise refresh them on separate schedules.

## Checks

```
node test/parse.test.mjs    # the Scholar parser
node test/data.test.mjs     # the shipped data files against each other
node test/monitor.mjs       # the live site + jsDelivr + Hugging Face + Ex Ordo
```

`data.test.mjs` is the gate on a pipeline run. It catches the failures that have
no symptom: a `sessions.json` reordered out of step with the matrix, a session
with no room, a real workshop caught by the socials filter. It reads the filter
regexes out of `docs/app.js` rather than restating them, so tightening the
filter is tested rather than shadowed by a stale copy. Both regressions it
guards against are real ones from this repo's history, and it has been checked
to fail on them.

`monitor.mjs` looks outward instead: a half-deployed Pages build, jsDelivr or
Hugging Face going away (the ~30 MB model is fetched at first visit and nothing
works without it), or the Ex Ordo programme moving under the shipped copy. It
runs daily in Actions, where a failing scheduled workflow is the notification.

## Porting it to another conference

Almost none of this is about RGS-IBG. The matching, the agenda assembly, the
clash rule, the Scholar parser and the offline caching are conference-agnostic;
what is specific is one data adapter and about a dozen constants.
[`PORTING.md`](PORTING.md) is the list, written for a coding agent and readable
by a person, and `.claude/skills/port-navigator/` makes it a skill in a clone.

`docs/build.html` is the front door: paste a programme URL and it writes the
prompt, filled in with the conference details and what's known about getting a
programme out of that platform. It makes no network call — the URL is
pattern-matched in the browser and the prompt tells the agent to probe rather
than trust the guess.

The real content of `PORTING.md` is the failure list. The scoring rules that
must not be relaxed, the sort key that must not contain a display field, the
socials filter that has to be re-checked against every new programme — each one
is something that broke here first, and all of them break silently. That is
what a port is actually inheriting.

MIT licensed. Credit in the footer of a deployed copy is asked for rather than
required; improvements back as a pull request are worth more.

## Editing the copy

```
node tools/copyedit.mjs                       # on the machine holding the repo
ssh -L 7000:localhost:7000 <that machine>     # from anywhere else
```

Then open `http://localhost:7000`: one box per piece of copy — 47 of them in
`docs/index.html` and 29 in `docs/build.html`, including page titles, meta
descriptions, placeholders and aria-labels. Save writes the file back with everything else untouched, keeping
the hand-wrapping. Publish runs the tests, commits and pushes.

It won't let you delete an element `app.js` looks up by id, or leave a tag
unclosed; a failed check writes nothing. Markup is allowed in every field
(`<em>`, a link), so the guards are what make that safe. It binds to 127.0.0.1
only — the SSH tunnel is the access control, which is why there's no login.

Nothing in it is specific to this site: `node tools/copyedit.mjs some/page.html`
works on any static HTML. It deliberately does *not* bump `CACHE` in `sw.js` —
that would re-download 2.5 MB of embeddings to fix a typo, and
stale-while-revalidate picks new text up on the visit after next anyway.

Copy that lives in `docs/app.js` (status messages, "If you only make five
sessions", the empty and error states) isn't in there, and still needs an edit
to the source.

## Design

One rule holds the interface together: **yellow means "this is the one"** — the
pick you're going to, the tab you're on. A pinned pick gets the full
highlighter, the tool's own suggestion a paler one, and an undecided clash gets
neither, because nothing has been decided in it yet. Times run down a gutter on
the left, because a route through a conference is a timetable and a timetable is
read by running your eye down the clock. Everything else is ink on paper: IBM
Plex Sans and Mono, hairline rules, no other colour.

## Roadmap

- [x] **Profile cleanup** — done deterministically, in-browser, for Google
  Scholar and publication-list pastes. No server, no cost, privacy model intact.
- [ ] **LLM layer** (optional, degrades gracefully): a small rate-limited
  endpoint that writes narrative reasons over the evidence, LabCurate-style
  grouped output with strict candidate-ID validation. Note it improves the
  *prose*, not the picks — the embedding does the matching either way — and it
  is the only planned feature that would put the profile on a network, so the
  privacy note above would need to change. Site works fully without it.
- [ ] **ORCID import** — `pub.orcid.org/v3.0/{id}/works` is CORS-open and needs
  no OAuth for public records, and `expanded-search` resolves a name to an iD, so
  this stays entirely client-side. Coverage is the catch, not plumbing: ORCID is
  patchily curated in human geography, so it's an extra path, never the only one.
- [ ] Opt-in "save to fraglet.com" via api.fraglet.org (private by default).
- [ ] MCP server exposing the same catalogue+scores so agents can plan
  agendas (serve data, not prose).
- [x] ICS export of the chosen route.
- [x] Refresh data (final programme, 11 August 2026 — real rooms, 593 sessions).
  Worth one more pass if the RGS publishes late changes before 1 September.
- [x] **Generalise** — `PORTING.md` and `docs/build.html`. Ex Ordo is a
  hostname change; other platforms need a new adapter and nothing else, because
  `docs/data/sessions.json` is the only contract.

Not affiliated with the RGS-IBG. Times shown in Europe/London; always check the
official programme.
