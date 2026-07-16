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

Separate pools are necessary and not sufficient, and the failure looks identical
from the outside. The pools were separate and the goals box still did nothing: a
linear length ramp gave one real sentence 16% of the weight, so the agenda came
back wall-to-wall energy justice for someone who had just said they now work on AI
agents. When the goals box "isn't working", measure its weight and its rank spread
before touching the pooling — see the three invariants below.

**One title per chunk.** `chunkText`'s 420-char packing assumes prose, where
adjacent sentences share a topic. A title list is N independent topics; packing
them embeds the centroid of a dozen unrelated directions and points nowhere. It
also makes the evidence quote unreadable (it slices mid-title).

**Thresholds over bge scores must be relative, not absolute — no exceptions.**
Cosine similarities sit in a narrow, corpus-dependent band. This file used to
grant `EV_MIN` an exception, on the grounds that it "only gates whether to *cite*
a facet". That was wrong: measured on the real fixture, every goals best cleared
0.35, so it gated nothing, the aims were quoted identically under all 623
sessions, and the second evidence line filled with whatever ranked next — a real
example being *"Investigating Decision-Making in Maryland Blue Crab Industry"*.
`CLASH_EPS = 0.03` was the same mistake and fired in 50–74% of slots, which is a
tool declining to choose rather than flagging a close call. Both are percentiles
now. If you are writing a float literal to compare a cosine against, you are
about to do this again.

**Rank each box before blending them.** The two pools live in different absolute
bands: on the real fixture the works best (max over 67 titles) averages 0.614 and
the goals best (max over one sentence) 0.499. That ~0.11 is a pool-size artifact —
a max over 67 draws beats a max over one — and says nothing about which box
matches better. Blend raw cosines and the bigger pool gets a free head start on
every facet, which is also why the works box used to be credited first on
virtually every evidence line. Their *spreads* are near-identical (sd 0.048 vs
0.050), and that's the useful half: once both are ranks, a box's share of the
weight is its share of the ranking, so `sourceWeights` means what it says. It
follows that the length ramp *is* the blend — a linear one handed one sharp
sentence 16% and let 67 papers outvote the only statement of intent.

**The blend must be non-compensatory.** "Sessions that match *both*" is the
promise on the landing page, and a weighted arithmetic mean does not keep it: it
rewards a high total, so a session the works box barely reaches (p59) can ride a
strong aims rank (p100) into the agenda. A weighted geometric mean can't be bought
that way. The same trap, subtler, sank the dual badge: `worksHit >= p97 &&
goalsHit >= p97` reads like "top 3%", but the two ranks are only loosely
correlated, so the joint event is nearer 0.1% and it fired on 0 of 623 sessions.
Threshold the *min* of the two ranks, not each independently.

## Sessions vs papers — the aggregate is lossy on purpose

A session scores `0.75 * best facet + 0.25 * mean(top 3)`, so depth beats a lone
bullseye: 100 minutes where everything lands is worth more than 100 minutes for
one paper and two duds. That's the right call for an agenda, and it throws away
real signal by design — the single closest paper in the programme can sit in a
session that deserves to lose its slot. On the real fixture the second-best
matching facet of 3204 (`works p98, aims p99`) was buried five deep in a collapsed
`<details>`, because its two neighbours were weak.

Don't fix that in the aggregate; it isn't broken, and no reweighting reaches it
anyway (the winning session led on the best-facet term too). `topPapers` reports
underneath the aggregate instead, and the "worth catching" flag is exactly the
case where the paper is close but its session isn't.

## Verifying a scoring change

Proxies lie, so run the real model over the real profile:

```
python3 -m http.server 8765 --directory docs
```

Then drive it with Playwright — paste `test/fixtures/scholar-profile.txt` into
`#works` (copy it under `docs/` first; `fetch` is same-origin), a sentence into
`#goals`, click `#plan-btn`, wait ~40s for the CDN model plus embedding. For the
numbers that only exist mid-run (per-facet ranks, `worksHit`, `goalsHit`), a
temporary `window.__dbg = ...` at the end of `scoreSessions` is the fast way in.

Standing in facet vectors for profile vectors is a decent shortcut for *shape*
(gap distributions, correlations, sd ratios) and useless for absolutes, since a
facet used as its own query scores 1.0 — exclude self-matches or you'll measure
your own fixture. And weighted quantities can't answer questions about the
unweighted ones: comparing `w * sd` across two sources just restates the weights.

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

**No embedding backend is trusted until it passes the self-check.** The
webgpu-fp16 path shipped unverified — no machine here has a GPU adapter, so
every test of it silently fell back to wasm-q8 and looked perfect, and the old
comment claiming the backends "agree to ~2dp" had only ever measured wasm
against wasm. On the first real GPU it met, it returned finite garbage: the UI
looked normal, evidence lines quoted real papers, and one generic title won
the works-best on 12 of 16 slots (the argmax over titles collapses to
whatever sits nearest the corpus centroid when profile vectors are noise).
`embedderSelfCheck` closes this: every `kind: "paper"` facet was embedded from
exactly its label (see `pipeline/embed.py`), so the shipped matrix is ground
truth for those strings — embed three of them and require each probe's own row
to rank in the top 1% of all rows. Rank-based, per the no-absolute-cosines
rule; a healthy backend self-matches at ~0.92 with nothing close, a broken one
lands at a uniformly random rank. GPU failing → fall back to wasm; wasm
failing → throw, because that means the model and the shipped matrix disagree
(torn cache, model bump without re-embedding) and a loud error beats silently
ranking noise. Session facets can't be probes — their embedded text has a
description chunk appended, so label ≠ text. And when hunting a bug that only
appears on the user's machine, ask *which backend* first: this Pi can't take
the GPU path at all (headless Chromium's GPU process dies without a display;
forced Vulkan hangs), so "works here" says nothing about webgpu.

## Persistence and caching — three layers, three invalidation rules

- **The route** (`traverse.rgs2026.route.v1`) stores ids + display strings,
  never session objects; sessions are re-joined to fresh data on load. It
  carries a `dataSig` (`n_facets|n_sessions`) and is silently discarded on
  mismatch — a route pointing at merged-away sessions is worse than no route.
- **Profile embeddings** (`traverse.embcache.*`) are keyed by raw chunk text
  and namespaced by model **and device**: webgpu-fp16 and wasm-q8 vectors agree
  to ~2dp, not exactly, and mixing them shifts scores that everything
  downstream reads as ranks. This cache is why a goals edit re-plans in <1s.
- **The service worker** (`docs/sw.js`) serves same-origin stale-while-
  revalidate: a deploy lands on the visit *after* next. When testing locally,
  remember the browser's plain HTTP cache sits in front of everything —
  python's http.server sends Last-Modified and Chromium heuristically caches
  data files, which once served a 623-session sessions.json against a
  621-session facets.json. `fetch(url, {cache: "reload"})` before measuring.

## Data

Programme comes from the public Ex Ordo API (no auth). Refreshed 16 July 2026;
rooms were still "In-person N" placeholders then, so another refresh is due
when real rooms land — see README. `pipeline/embed.py` needs a venv with
sentence-transformers (`.venv-pipeline/` if it survived).

The API has changed shape once already (page_size now clamped to 15, `date=`
is the only working day filter, `expand[]=` 500s — dotted comma-separated
paths work). The working fetch loop is documented in `pipeline/normalize.py`'s
header; trust it over memory.

Two id systems: `sessions[].id` is the virtual_published_content id (stable
row identity, used for localStorage joins); `sessions[].eid` is the
schedule_event id, which is what the public site routes on
(`/session/<eid>/<slug>`). They differ for 606 of 621 sessions — linking on
`id` gives you someone else's session. The public API publishes **no author
names**, only presenting affiliations — hence the People tab is institutions
and research groups, and says so.
