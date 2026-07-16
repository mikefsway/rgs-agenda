# Traverse — a personalised route through RGS-IBG 2026

Tell it what you've worked on and what you want from the week; get a suggested
personal agenda for the RGS-IBG Annual International Conference 2026
(1–4 September, London), with reasons for each pick, alternatives per timeslot,
and genuine clashes surfaced rather than silently resolved.

**Privacy model: everything runs in the browser.** The programme ships as
precomputed embeddings; the user's text is embedded locally with
[transformers.js](https://huggingface.co/docs/transformers.js) (bge-small,
~30 MB, cached after first visit) and never leaves the device. No account, no
tracking, no server. The profile is stored in `localStorage` as a
fraglet-shaped JSON (`{title, brief, detail, category, domain, tags,
visibility: "private"}`) and can be downloaded; see [fraglet.org](https://fraglet.org).

## Architecture

```
pipeline/            build-time, runs on any machine with Python
  normalize.py       raw Ex Ordo JSON -> docs/data/sessions.json
  embed.py           sessions -> facet embeddings (bge-small, float16)
docs/                the static site (GitHub Pages serves this directory)
  index.html/app.js/style.css
  scholar.js             deterministic cleanup for pasted publication lists
  data/sessions.json     623 sessions, 2,077 paper titles (1.7 MB)
  data/embeddings.bin    3,204 facets x 384 dims, float16 (2.5 MB)
  data/facets.json       row -> session mapping + evidence labels
test/                node test/parse.test.mjs — no deps, no runner
  fixtures/            a real Scholar profile; keep it real (see CLAUDE.md)
data/raw/            fetched Ex Ordo day dumps (gitignored candidates; kept for reproducibility)
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
  a dozen topics and points nowhere. Titles are sorted newest-first, because
  under a hard cap ordering *is* recency prioritisation. Anything that isn't a
  publication list falls back to prose chunking.

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

- Sessions grouped into parallel timeslots (4 main blocks/day, ~45–53 options each).
- Top pick per slot with evidence + match bar; next 3 as collapsible alternatives.
- **Clash rule** (from gridflex-sim `household_flex`): if the top two scores are
  within 0.03 and the match is strong, render a forked "genuine clash — your
  call, not ours" with both options. Never auto-resolve.
- Slots with no strong match are honestly labelled ("a good slot for coffee and corridors").

## Data provenance

Programme fetched July 2026 from the **public** Ex Ordo draft programme API
(`event.ac2026.exordo.com/api/virtual_published_contents`, no auth). Paper
abstracts are blanked in the public API; matching uses session descriptions and
paper titles. Author names are not published there either — only presenting
affiliations. Re-run before the conference:

```
# fetch (see pipeline/normalize.py header for the curl loop)
python3 pipeline/normalize.py
<venv-with-sentence-transformers>/bin/python pipeline/embed.py
```

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
- [ ] ICS export of the chosen route.
- [ ] Refresh data when the final programme lands (rooms allocated July 2026).
- [ ] Generalise: any Ex Ordo-hosted conference is ingestible the same way.

Not affiliated with the RGS-IBG. Times shown in Europe/London; always check the
official programme.
