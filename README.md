# Traverse — a personalised route through RGS-IBG 2026

Paste your research interests and goals; get a suggested personal agenda for the
RGS-IBG Annual International Conference 2026 (1–4 September, London), with
reasons for each pick, alternatives per timeslot, and genuine clashes surfaced
rather than silently resolved.

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
  data/sessions.json     623 sessions, 2,077 paper titles (1.7 MB)
  data/embeddings.bin    3,204 facets x 384 dims, float16 (2.5 MB)
  data/facets.json       row -> session mapping + evidence labels
data/raw/            fetched Ex Ordo day dumps (gitignored candidates; kept for reproducibility)
```

### Matching engine

Lifted from [ucl-explorer](https://github.com/mikefsway/ucl-explorer):

- **Facet model** — each session is embedded as several rows (title+description
  chunks, plus one row per paper title). Session score =
  `0.75 * best_facet + 0.25 * mean(top 3)`, so one strongly matching paper can
  surface its session, and the matched facets are shown as **evidence**
  ("Matches paper X — from your '…'").
- The user's pasted text is chunked (~420 chars) and each chunk embedded with
  the bge query prefix; per facet we keep the best-matching chunk so evidence
  cites *which part* of the profile matched.

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

- [ ] **LLM layer** (optional, degrades gracefully): a small rate-limited
  endpoint that (a) distils a pasted profile into a tidy fraglet, and
  (b) writes narrative reasons over the evidence, LabCurate-style grouped
  output with strict candidate-ID validation. Site works fully without it.
- [ ] Opt-in "save to fraglet.com" via api.fraglet.org (private by default).
- [ ] MCP server exposing the same catalogue+scores so agents can plan
  agendas (serve data, not prose).
- [ ] ICS export of the chosen route.
- [ ] Refresh data when the final programme lands (rooms allocated July 2026).
- [ ] Generalise: any Ex Ordo-hosted conference is ingestible the same way.

Not affiliated with the RGS-IBG. Times shown in Europe/London; always check the
official programme.
