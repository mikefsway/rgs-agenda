# Traverse — working notes

Client-side personalised agenda for RGS-IBG 2026. See README.md for what it is
and how the matching engine works; this file is the stuff that bites.

## Shape

- `docs/` is the whole site, served by **GitHub Pages**. There is **no server, no
  build step, no bundler** — plain ES modules loaded by `<script type="module">`.
  If you reach for a dependency, it has to work from a CDN or ship as a file.
- `pipeline/` is build-time Python, run by hand, output committed into
  `docs/data/`. It never runs in production.
- Nothing here is deployed on Render. If someone says "the Render service", they
  mean a different repo.

## Invariants — break these and the project loses its point

**Everything stays in the browser.** The pitch on the landing page is that what
you paste never leaves the device. No analytics, no accounts, no sending the
profile anywhere. Any feature that needs a network call for the *user's text* is
a change to the privacy promise, not just an implementation detail — say so out
loud rather than shipping it quietly.

**Don't merge the two profile pools.** `scoreSessions` takes the max over chunks
per facet, so chunk count is an implicit weight. Concatenating the works box (40
titles) and the goals box (~2 chunks) into one pool lets volume silently outvote
intent, and the goals box stops doing anything — while still *looking* like it
works, because the agenda still shifts a little when you edit it. Keep the pools
separate and blend per-source bests.

**One title per chunk.** `chunkText`'s 420-char packing assumes prose, where
adjacent sentences share a topic. A title list is N independent topics; packing
them embeds the centroid of a dozen unrelated directions and points nowhere. It
also makes the evidence quote unreadable (it slices mid-title).

**Thresholds over bge scores must be relative, not absolute.** Cosine
similarities sit in a narrow, corpus-dependent band — nearly every session clears
0.35 against nearly any profile. `EV_MIN` gets away with being absolute because
it only gates whether to *cite* a facet. Anything that's meant to be selective
(like `DUAL_PCTL`) has to be a percentile of the observed distribution, or it
fires on everything or nothing.

## The Scholar parser (`docs/scholar.js`)

Heuristics over a format nobody specified. It is the most fragile thing here and
the most likely to rot silently.

```
node test/parse.test.mjs      # no deps, no runner
```

`test/fixtures/scholar-profile.txt` is a **real** 68-article profile. Keep it
real — a synthetic fixture that looked convincing hid two genuine bugs:

- Cited-by and year arrive as **one whitespace-separated line** (`366    2017`,
  sometimes `36*    2015`), not a cell each. `Number(line)` returns NaN, drops
  the line, and takes the year with it — which silently kills the newest-first
  ordering, and ordering *is* the recency prioritisation under a cap.
- Everything above the `Title / Cited by / Year` header is profile furniture, and
  several lines of it are indistinguishable from titles by shape ("Based on
  funding mandates", "University of Exeter"). `sliceToTable` cuts structurally;
  don't try to name them all with regexes.

Two rules that look like they could be tightened but can't:

- `isAuthorLine` requires initials-first (`M Fell`) and ≥2 names. Loosening it to
  catch `Michael Fell` starts eating title-cased titles. A missed author line
  costs one noise chunk; a false positive costs a real paper.
- The line after an author line is dropped as the venue **positionally**, because
  venue names don't reliably contain volume numbers. That's the only thing that
  catches `Environment and Planning B: Urban Analytics and City Science`.

## Performance — and why it's deliberately not optimised

Measured on the real 67-title profile: **embedding ~10s, scoring+render ~0.3s.**
The cost is ~97% transformers.js and linear in chunk count (~150ms/title). The
matching loop is free by comparison.

The call was made that a ~10s wait is fine **provided the user can see it
working**, so the profile is effectively uncapped (`WORKS_MAX_TITLES = 120` is a
backstop against a 500-paper paste, not an editorial choice) and the effort went
into progress instead. `embedBatched` exists for that: batches of 8 with a
`setTimeout(0)` yield between them. **The yield is load-bearing** — ONNX runs
synchronously on the main thread, so without it the status text never repaints
and the batching buys nothing. Longest silence is ~1.3s; before batching it was
the whole 6.5s, which reads as a hang.

Two things that look like optimisations and aren't:

- **Clustering titles to reduce vectors cannot pay for itself.** You have to
  embed all N to cluster them by vector similarity, so you've already spent the
  10s before clustering starts; it only shrinks the input to the 0.3s scoring
  loop. It also costs specificity — a centroid is a blurrier target than a title,
  so a niche paper that would have surfaced one session gets averaged away.
- **Near-duplicate titles are already harmless.** Scoring takes the *max* over
  chunks per facet, and max is idempotent over near-parallel vectors: eight
  papers on the same topic contribute exactly what one does. Redundancy costs
  embedding time, not match quality. (This is the opposite of the packed-chunk
  problem, where noise genuinely displaces signal.)

If the wait ever does matter, the lever is caching vectors by title hash in
`localStorage` — embeddings are deterministic, so a re-plan becomes free.

## Data

Programme comes from the public Ex Ordo API (no auth). Rooms are allocated
July 2026, so `docs/data/` needs a refresh before the conference — see README.
`pipeline/embed.py` needs a venv with sentence-transformers.
