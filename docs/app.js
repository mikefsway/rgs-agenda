/* Agenda Navigator — client-side agenda builder for RGS-IBG 2026.
 *
 * All matching runs in the browser: the programme ships as precomputed
 * bge-small embeddings (float16 matrix); the user's text is embedded locally
 * with transformers.js and scored with the facet model from ucl-explorer
 * (session score = 0.75 * best facet + 0.25 * mean of top 3, facets kept as
 * evidence). Parallel-session clashes are surfaced with alternatives, never
 * auto-resolved (household_flex Conflict pattern).
 *
 * Everything the user builds survives a reload: the profile, the computed
 * route, their pins and dismissals, and the embeddings of text they've
 * already embedded all live in localStorage. A service worker caches the
 * app shell and data, so on conference wifi the page opens to yesterday's
 * route without touching the network.
 */

import { parseWorks } from "./scholar.js";

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const EXORDO_BASE = "https://event.ac2026.exordo.com";
/* A genuine clash is one of your closest calls — a rank, not a distance.
 *
 * This was `runner-up within 0.03 of the pick`, an absolute gap over bge scores,
 * and on a real profile it fired in 50–74% of slots. "Two sessions match you almost
 * equally — your call, not ours" is honest once; three times in four it is the tool
 * declining to choose. Session scores sit in a narrow band, so any fixed distance
 * catches nearly every slot or none — the trap DUAL_PCTL already documents. Flag
 * the closest fifth of the decisions you actually face and the badge stays rare and
 * true whatever the spread turns out to be. */
const CLASH_PCTL = 0.2;
// Under this many real decisions, "the closest fifth" is one arbitrary slot. Don't.
const CLASH_MIN_SLOTS = 4;
const WEAK_REL = 0.55;           // below this normalized score, a slot is "no strong match"
const FRAGLET_KEY = "traverse.rgs2026.fraglet";
// v2: v1 routes carried no record of the profile that produced them, so a
// route charted from anyone's (or a broken backend's) input restored as yours.
const ROUTE_KEY = "traverse.rgs2026.route.v2";

/* Sessions the user has said they are presenting in, and the institution they
 * want flagged. Both are their own keys rather than fields on the route,
 * because both must outlive a re-chart: a route is discarded whenever the
 * profile changes, and "I am speaking at 14:40 on Thursday" is not something
 * that should evaporate because someone edited their goals box. Neither feeds
 * profileSig for the same reason — they change what the page says, never what
 * it scored, and folding them in would throw away a perfectly good route. */
const MINE_KEY = "traverse.rgs2026.mine.v1";
const INST_KEY = "traverse.rgs2026.inst.v1";

// RGS-IBG research group codes (session-code prefixes) to official names.
// POPGRGE is PopGRG's evening social, not a separate group.
const GROUP_NAMES = {
  AGWG: "Animal Geography Working Group",
  CCRG: "Climate Change Research Group",
  CGWG: "Carceral Geography Working Group",
  CMRG: "Coastal and Marine Research Group",
  DEVGRG: "Development Geographies Research Group",
  DGRG: "Digital Geographies Research Group",
  EGRG: "Economic Geography Research Group",
  ENGRG: "Energy Geographies Research Group",
  FGRG: "Food Geographies Research Group",
  GCYFRG: "Geographies of Children, Youth and Families Research Group",
  GEOGED: "Geography and Education Research Group",
  GFGRG: "Gender and Feminist Geographies Research Group",
  GHWRG: "Geographies of Health and Wellbeing Research Group",
  GISCRG: "Geographical Information Science Research Group",
  GLTRG: "Geographies of Leisure and Tourism Research Group",
  HGRG: "Historical Geography Research Group",
  HPGRG: "History and Philosophy of Geography Research Group",
  LAGRG: "Latin American Geographies Research Group",
  LGWG: "Landscape Geography Working Group",
  MENA: "Geographies of the Middle East and North Africa Research Group",
  POLGRG: "Political Geography Research Group",
  POPGRG: "Population Geography Research Group",
  POPGRGE: "Population Geography Research Group",
  PYGYRG: "Participatory Geographies Research Group",
  QMRG: "Quantitative Methods Research Group",
  RACE: "Race, Culture and Equality Working Group",
  RADGEO: "Radical Geography Research Group",
  RGRG: "Rural Geography Research Group",
  SCGRG: "Social and Cultural Geography Research Group",
  SSQRG: "Space, Sexualities and Queer Research Group",
  TGRG: "Transport Geography Research Group",
  UGRG: "Urban Geography Research Group",
};

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

let DATA = null;          // { sessions, facets, matrix (Float32Array), dim, meta, byId }
let dataPromise = null;
let embedderPromise = null;  // resolves to async (texts, kind) => Float32Array[]

/* Everything the rendered views need, kept so pins/dismissals re-rank without
 * re-embedding and the whole thing can be revived from localStorage. `results`
 * and `papers` hold live session refs; `people` holds session ids (one shape
 * for fresh and restored renders). */
let STATE = null;         // { results, papers, people, weights, filters, choices, dismissed, chartedAt }

// ---------- data loading ----------

function f16ToF32(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) out[i] = s * m * 2 ** -24;
    else if (e === 31) out[i] = m ? NaN : s * Infinity;
    else out[i] = s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

function loadData() {
  if (!dataPromise) {
    dataPromise = fetchData().catch((e) => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

/* A 404 here means one specific thing and it is worth saying so. `docs/data/`
 * is a pipeline output, not a source file, so a fresh clone of the kit has none
 * of it — and so does a port between `normalize.py` and `embed.py`. Left to
 * itself that arrives as "Unexpected token < in JSON", which sends a porter
 * looking at the parser rather than at the three commands they haven't run. */
class NoProgrammeData extends Error {}

/* sessions.json and the embedding matrix loaded fine and are each internally
 * valid, but they disagree on row order (see assertOrder). This is not a bad
 * download, so "refresh and try again" is exactly the wrong advice — refreshing
 * re-fetches the same mismatched pair. It carries its own operator-facing
 * message naming both signatures and the fix, and failureMessage passes it
 * through verbatim rather than flattening it to the generic data error. */
class DataInconsistent extends Error {}

async function fetchOne(path, as) {
  const r = await fetch(path);
  if (r.status === 404) throw new NoProgrammeData(path);
  return as === "bin" ? r.arrayBuffer() : r.json();
}

async function fetchData() {
  setStatus("loading programme…");
  const [meta, sessionsDoc, facets, binBuf] = await Promise.all([
    fetchOne("data/meta.json"),
    fetchOne("data/sessions.json"),
    fetchOne("data/facets.json"),
    fetchOne("data/embeddings.bin", "bin"),
  ]);
  const matrix = f16ToF32(new Uint16Array(binBuf));
  assertOrder(meta, sessionsDoc.sessions);
  const byId = new Map(sessionsDoc.sessions.map((s) => [s.id, s]));
  // `conference` is part of the sessions.json contract (PORTING.md §2) and is
  // the one place the conference names itself, so a port gets it right without
  // touching app.js. Only the LLM brief reads it; the page says RGS-IBG in copy.
  DATA = {
    sessions: sessionsDoc.sessions, facets, matrix, dim: meta.dim, meta, byId,
    conference: sessionsDoc.conference || "the conference",
  };
  const n = $("#n-sessions");
  if (n) n.textContent = DATA.sessions.length;
  return DATA;
}

/* facets.json addresses sessions by index, so the matrix is only meaningful
 * against the ordering of sessions.json that built it. That pairing broke once,
 * from a data-only edit: filling in 164 missing rooms reordered sessions.json,
 * because the sort key included venue. Counts can't see it — n_facets and
 * n_sessions are identical either side of a permutation — and the symptom is
 * not an error but a plausible agenda citing the wrong sessions. So embed.py
 * ships a hash of the id order and we refuse the pair outright if it moved.
 * Old data with no order_sig is let through; there is nothing to check it
 * against, and the counts guard still applies. */
function assertOrder(meta, sessions) {
  if (!meta.order_sig) return;
  const s = sessions.map((x) => x.id).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const got = h.toString(36);
  if (got !== meta.order_sig) {
    throw new DataInconsistent(
      `programme data is inconsistent: sessions.json is ordered ${got}, but the ` +
      `embeddings were built for ${meta.order_sig}. Re-run pipeline/embed.py.`
    );
  }
}

// Route and embedding caches are only valid against the data they were built
// from; a data refresh silently invalidates both.
function dataSig() {
  return `${DATA.meta.n_facets}|${DATA.sessions.length}`;
}

function loadEmbedder() {
  if (!embedderPromise) {
    embedderPromise = buildEmbedder().catch((e) => { embedderPromise = null; throw e; });
  }
  return embedderPromise;
}

// Which backend built the vectors. Only wasm-q8 exists now (see
// buildEmbedder for the webgpu obituary), but the device stays in the cache
// key: different backends do not agree exactly, so if one ever returns,
// cached vectors must not cross over.
const EMB_DEVICE = "wasm-q8";

/* Trust no backend until it can find its own text.
 *
 * Every `kind: "paper"` facet was embedded from exactly its label (see
 * pipeline/embed.py), so the shipped matrix holds ground truth for those
 * strings. Embed a few of them as passages (no query prefix) and require each
 * probe's own row to rank in the top slice of all rows. A healthy backend
 * self-matches at ~0.92 cosine with nothing else close; a broken one returns
 * vectors whose self-row lands at a uniformly random rank, so three probes
 * passing by chance is ~1e-6. Rank-based on purpose: absolute cosine
 * thresholds over bge scores are banned in this codebase, and NaN must fail,
 * hence the explicit finiteness check (NaN compares false against everything,
 * which would otherwise count as "nothing ranked above me").
 *
 * The check must exercise the path the app actually uses, not a convenient
 * proxy. Profile text is embedded with the bge query prefix, in batches padded
 * to their longest member — a backend can embed short bare titles correctly
 * and still garble prefixed or long-padded input, and fp16 numeric trouble is
 * more likely on longer sequences. So each probe runs twice — bare (exact
 * ground truth) and prefixed (the real path; measured self-rank #1 of 3309 at
 * ~0.90 cosine on wasm-q8) — and both batches carry a long filler text so the
 * padding matches what profile embedding produces. */
const SELF_CHECK_FILLER =
  "I am broadly interested in the social dimensions of energy systems and technology adoption, " +
  "and this year I am particularly keen to understand how researchers across human geography are " +
  "using artificial intelligence and machine learning in their methods, as well as sessions about " +
  "research careers, publishing, impact, and building collaborations across disciplines and institutions.";

async function embedderSelfCheck(embed) {
  await loadData();
  const { facets, matrix, dim } = DATA;
  const papers = [];
  for (let i = 0; i < facets.length; i++) if (facets[i].kind === "paper") papers.push(i);
  if (!papers.length) return true;
  const probes = [...new Set([papers[0], papers[Math.floor(papers.length / 2)], papers[papers.length - 1]])];
  const texts = [...probes.map((i) => facets[i].label), SELF_CHECK_FILLER];
  const allowed = Math.max(3, Math.floor(facets.length * 0.01));
  for (const kind of ["passage", "query"]) {
    const vecs = await embed(texts, kind);
    for (let p = 0; p < probes.length; p++) {
      const v = vecs[p];
      let self = 0;
      const off = probes[p] * dim;
      for (let k = 0; k < dim; k++) self += matrix[off + k] * v[k];
      if (!Number.isFinite(self)) return false;
      let above = 0;
      for (let f = 0; f < facets.length; f++) {
        let dot = 0;
        const o = f * dim;
        for (let k = 0; k < dim; k++) dot += matrix[o + k] * v[k];
        if (dot > self && ++above >= allowed) return false;
      }
    }
  }
  return true;
}

async function buildEmbedder() {
  setStatus("loading language model (~30 MB, first visit only)…");
  const { pipeline } = await import(TRANSFORMERS_CDN);
  const progress_callback = (p) => {
    if (p.status === "progress" && p.file?.endsWith(".onnx")) {
      setStatus(`loading language model… ${Math.round(p.progress || 0)}%`);
    }
  };
  const wrap = (fe) => async (texts, kind) => {
    const prefix = kind === "query" ? DATA.meta.query_prefix : "";
    const out = await fe(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    const [n, d] = out.dims;
    const flat = out.data;
    return Array.from({ length: n }, (_, i) => new Float32Array(flat.slice(i * d, (i + 1) * d)));
  };
  // wasm-q8 is the only backend. There used to be a webgpu-fp16 fast path
  // here (~1s instead of ~10s); it was removed on 16 Jul 2026 after it kept
  // producing topically-arbitrary routes on the one real GPU it ever met,
  // through two rounds of self-check hardening — and no machine in this
  // house can even take the GPU path, so it is unverifiable by construction.
  // Do not bring it back without a way to test it on real adapters.
  const fe = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", progress_callback });
  const embed = wrap(fe);
  // Failing here almost certainly means the model and the shipped matrix
  // disagree (torn cache, model bump without re-embedding) — a loud error
  // beats silently ranking noise.
  if (!(await embedderSelfCheck(embed))) {
    throw new Error("embedding self-check failed: model output does not match shipped embeddings");
  }
  return embed;
}

// ---------- embedding cache ----------

/* Embeddings are deterministic, so a title only ever needs embedding once per
 * model+device. Keyed by the raw text (titles are short; collisions impossible),
 * vectors stored as base64 float32 (~2 KB each). This is what makes editing the
 * goals box cheap: a re-plan re-embeds one sentence, not 67 titles. */
const EMB_CACHE_MAX = 400;

/* v2: v1 caches predate the backend self-check, so they can hold vectors
 * written by a broken backend — on at least one machine an entire profile was
 * cached as garbage under webgpu-fp16, and a cache hit bypasses the (now
 * verified) live embedder entirely. A cache namespace is only trustworthy if
 * everything ever written to it came from a verified backend, so pre-check
 * namespaces are dead, not migratable. */
function embCacheKey() { return `traverse.embcache.v2.${EMBED_MODEL}.${EMB_DEVICE}.${dataSig()}`; }

// One-time sweep of the untrusted pre-check caches (and the v1 route below).
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("traverse.embcache.") && !k.startsWith("traverse.embcache.v2.")) {
      localStorage.removeItem(k);
    }
  }
  localStorage.removeItem("traverse.rgs2026.route.v1");
} catch { /* storage disabled — nothing to sweep */ }

function b64FromVec(v) {
  const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* Decode a cached vector, or null if the stored string is anything other than a
 * clean base64 encoding of a whole float array. Never throws: a truncated or
 * corrupt entry (a torn localStorage write, a vector left by a different model)
 * otherwise reaches `new Float32Array` as a RangeError, which plan() swallows
 * into "something went wrong" while leaving the poison in place — permanently
 * broken until the user clears storage by hand. The caller additionally checks
 * the decoded length against DATA.dim: a wrong-but-4-aligned length would read
 * past the vector as NaN in bestPerFacet and silently rank noise, which is the
 * exact symptomless failure embedderSelfCheck exists to stop, on the one path
 * that bypasses it (cached vectors never touch the self-check). */
function vecFromB64(b) {
  let s;
  try { s = atob(b); } catch { return null; }
  if (s.length % 4 !== 0) return null;
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

function dropEmbCache() {
  try { localStorage.removeItem(embCacheKey()); } catch { /* storage disabled — nothing to drop */ }
}

function loadEmbCache() {
  try { return JSON.parse(localStorage.getItem(embCacheKey())) || {}; } catch { return {}; }
}

function saveEmbCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > EMB_CACHE_MAX) {
    keys.sort((a, b) => cache[a].t - cache[b].t)
      .slice(0, keys.length - EMB_CACHE_MAX)
      .forEach((k) => delete cache[k]);
  }
  try { localStorage.setItem(embCacheKey(), JSON.stringify(cache)); }
  catch { try { localStorage.removeItem(embCacheKey()); } catch { /* full is full */ } }
}

// ---------- profile ----------

// Prose chunking: adjacent sentences are usually about the same thing, so packing
// them concentrates meaning. This assumption fails badly for title lists — see
// parseWorks, which emits one title per chunk instead.
function chunkText(text, maxLen = 420, maxChunks = 16) {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim().length > 2);
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length + 1 > maxLen) { chunks.push(buf.trim()); buf = s; }
    else buf = buf ? `${buf} ${s}` : s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.slice(0, maxChunks);
}

/* Generous enough that a normal academic's whole profile goes in — the cap is a
 * backstop against a 500-paper paste, not an editorial choice. Embedding runs at
 * ~150ms/title and is the only real cost (scoring the lot takes ~300ms), so this
 * bounds the worst case at ~20s while leaving almost everyone uncapped. Anything
 * dropped is the oldest, and the preview says so. */
const WORKS_MAX_TITLES = 120;
const WORKS_MAX_PROSE = 12;
const GOALS_MAX_CHUNKS = 6;
// Small batches so progress ticks visibly, and so one long title doesn't pad the
// whole run — transformers.js pads each batch to its longest member.
const EMBED_BATCH = 8;
const GOALS_MAX_WEIGHT = 0.5;
// Calibrated to the goals placeholder (~180 chars) — the app's own worked example,
// and what the hint asks for ("a couple of real sentences"). At 300 even that model
// answer earned only 30%, so the box could never do the job the copy promises.
const GOALS_FULL_WEIGHT_CHARS = 180;

/* Split the score between the two boxes.
 *
 * The pools must stay separate: scoring takes the max over chunks per facet, so
 * pooling 40 titles with 1 goals chunk would let volume silently become weight
 * and the goals box would never win a facet. Blending per-source bests instead
 * rewards *agreement* — a session both boxes reach outranks one either reaches
 * alone, which is the whole point of asking twice. */
function sourceWeights(worksChunks, goalsChunks, goalsRaw) {
  if (!goalsChunks.length) return { works: 1, goals: 0 };
  if (!worksChunks.length) return { works: 0, goals: 1 };
  /* Scale with what they actually wrote — but concavely, because the ramp *is* the
   * blend. Both pools have near-identical spread over the facets (sd ~0.05 each, the
   * max over 67 titles being no wider than a single sentence's), so a source's share
   * of the weight is its share of the ranking, near enough. Linear-in-characters
   * therefore said the 300th character informs as much as the 10th: one sharp
   * sentence of intent scored 16% and 67 papers outvoted it. Real prose saturates —
   * the first sentence carries most of the signal — so sqrt pays a single sentence
   * its due while still collapsing a two-word stub to near nothing. */
  const goals = GOALS_MAX_WEIGHT * Math.min(Math.sqrt(goalsRaw.trim().length / GOALS_FULL_WEIGHT_CHARS), 1);
  return { works: 1 - goals, goals };
}

/* Embed in batches so the status line can tick, checking the vector cache first.
 *
 * Embedding is ~95% of the wall clock and a single fe() call over 67 titles is
 * opaque — the user watches a frozen page for ten seconds and assumes it hung.
 * The yield after each batch is load-bearing: ONNX runs sync on the main thread
 * (wasm path), so without it the status text never repaints and this buys nothing. */
async function embedBatched(embed, texts, onBatch) {
  const cache = loadEmbCache();
  const vecs = new Array(texts.length);
  const missing = [];
  let torn = false;
  texts.forEach((t, i) => {
    const hit = cache[t] ? vecFromB64(cache[t].v) : null;
    if (hit && hit.length === DATA.dim) {
      vecs[i] = hit;
    } else {
      // A present-but-unusable entry means the store is torn or stale (a
      // truncated write, or vectors from a different model/dim than this key
      // claims). Don't trust it piecemeal.
      if (cache[t]) { torn = true; delete cache[t]; }
      missing.push(i);
    }
  });
  // Drop the whole namespace so nothing invalid survives to a later run; entries
  // that decoded to exactly DATA.dim floats are kept in `vecs` (provably
  // well-formed) and the missing ones are re-embedded from the checked embedder
  // below, then written back fresh by saveEmbCache.
  if (torn) dropEmbCache();
  let done = texts.length - missing.length;
  if (done) onBatch(done);
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const idxs = missing.slice(i, i + EMBED_BATCH);
    const out = await embed(idxs.map((j) => texts[j]), "query");
    out.forEach((v, k) => {
      vecs[idxs[k]] = v;
      cache[texts[idxs[k]]] = { v: b64FromVec(v), t: Date.now() };
    });
    done += idxs.length;
    onBatch(done);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (missing.length) saveEmbCache(cache);
  return vecs;
}

/* The two controls under the works box are one mechanism: they choose which
 * parsed titles go into the pool. Nothing downstream moves — no weights, no
 * thresholds, no new constants.
 *
 * That is not timidity, it is the only version available. A *weight* on a bge
 * cosine can't be tuned to a useful strength: similarities here sit in a band
 * roughly 0.45–0.70 and `bestPerFacet` takes the max over titles, so a
 * multiplier big enough to matter (×0.9) drops a title below every other title
 * in the pool and silently deletes it, while one gentle enough to be a nudge
 * (×0.98) does nothing at all. There is no middle. Since the honest operation
 * is in-or-out, it is the user's call and it is on screen, rather than a decay
 * constant someone here invented. A real soft weight would have to live in rank
 * space and would move every route for everyone — see CLAUDE.md. */
const WORKS_FILTER_NONE = { since: null, firstOnly: false, excluded: [] };
let worksFilter = { ...WORKS_FILTER_NONE, excluded: [] };

/* Excluded titles are held by title text, not by index: the list is re-sorted
 * and re-filtered constantly, and an index would silently come to mean a
 * different paper. Titles are unique by construction — parseWorks dedupes on a
 * normalised form of them. */
function filterWorks(items, filter) {
  const out = filter.excluded?.length ? new Set(filter.excluded) : null;
  return items.filter((it) => {
    // None of the three treats "unknown" as "no". An unread year or a missed
    // author line is not evidence against a paper, and dropping someone's own
    // work on a heuristic miss is invisible from the outside — which is the
    // failure mode this whole file is written to avoid.
    if (filter.since && it.year && it.year < filter.since) return false;
    if (filter.firstOnly && it.authorFirst === false) return false;
    if (out?.has(it.title)) return false;
    return true;
  });
}

// Identity of the works box alone. The per-paper shares below are measured
// against a particular paste, and they have to survive the user unticking
// papers — that is the entire workflow they exist for — so they are keyed to
// the text rather than to the full profileSig, which the filters are part of.
function worksSig(works) {
  let h = 5381;
  for (let i = 0; i < works.length; i++) h = ((h * 33) ^ works.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ---------- two flags that don't touch the scoring ----------
 *
 * Both answer the same question, which is the one the ranking can't: I go to
 * talks because of the topic *or* because of the person. Neither changes a
 * score. `mine` promotes a session within its slot, because a talk you are
 * presenting in has to appear whatever it scored — that is the entire point of
 * marking it — and the institution flag is pure annotation.
 */
let mine = new Set();
let instRaw = "";
let INST = [];      // instNeedles(instRaw), rebuilt on edit rather than per session

// Words that identify nobody. Everything here is a descriptor that dozens of
// institutions share; "university" alone is in 59% of the programme's 1,168
// affiliation strings, so matching on it would flag the whole conference.
const INST_STOP = new Set(["university", "universite", "universitat", "universidad", "universita",
  "of", "the", "and", "for", "de", "der", "des", "du", "la", "le", "el",
  "college", "institute", "institut", "school", "department", "dept", "faculty",
  "centre", "center", "research", "group", "unit", "laboratory", "lab", "studies"]);

const instNorm = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/* Does one programme affiliation belong to the user's institution?
 *
 * Deliberately conservative, because the two errors are not symmetrical: a false
 * positive tells someone a stranger is a colleague, which is worse than useless,
 * while a false negative just leaves a session unflagged. So this matches on
 * whole phrases and on acronyms, never on a shared ordinary word — "University
 * College London" and "King's College London" have two tokens in common and are
 * different places. It is why the field takes a list: no single string catches
 * both "University College London (UCL)" and "UCL Institute for Innovation",
 * and the user can see the count and add another.
 *
 * Consequence worth knowing: "The Bartlett, University College London" is caught
 * by the long form and not by the acronym, and "UCL Institute…" the other way
 * round. Hence the count next to the box — a wrong or thin value is visible
 * immediately, the same reason detectOwner prints the name it inferred. */
function instMatches(aff, needles) {
  if (!needles.length || !aff) return false;
  const a = instNorm(aff);
  return needles.some((n) => {
    if (n.acronyms.some((k) => a.includes(` ${k} `))) return true;
    // Phrase containment either way: a paste may be longer than the programme's
    // string ("Bartlett School …, University College London") or shorter.
    if (!n.phrase) return false;
    return a.includes(n.phrase) || (a.trim().split(" ").length >= 2 && n.full.includes(a));
  });
}

/* Parse the "flag talks from" box into matchable needles.
 *
 * An acronym is any token that survives the stoplist and is either written in
 * capitals ("UCL", "LSE", "MIT") or is the distinctive label of the verified
 * email domain — which is the one part of a Scholar profile that is an
 * identifier rather than free text. A one-word entry ("Exeter") is treated as an
 * acronym too, since a single word is exactly how you name a place informally. */
function instNeedles(raw) {
  return raw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const words = s.split(/\s+/);
    const acronyms = words
      .filter((w) => /^[A-Za-z][A-Za-z0-9.&-]*$/.test(w))
      .filter((w) => w === w.toUpperCase() || words.length === 1)
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ""))
      .filter((w) => w.length >= 2 && !INST_STOP.has(w));
    /* The phrase is the whole normalised string, not its distinctive words:
     * "University College London" has exactly one word that identifies anyone
     * ("london", and that one is shared with three other institutions here), but
     * the full phrase is unambiguous and does not appear inside "King's College
     * London". What the stoplist is for is refusing a needle with no content at
     * all — "University of" would otherwise phrase-match half the programme. */
    const sig = instNorm(s).trim().split(" ").filter((w) => w && !INST_STOP.has(w));
    const phrase = words.length >= 2 && sig.length >= 1 ? instNorm(s) : "";
    return { acronyms, full: instNorm(s), phrase };
  });
}

/* How much of a session is from the user's institution. `n` counts papers and
 * `affs` the distinct strings they arrived under, because the programme spells
 * one place several ways ("University College London", "The Bartlett, University
 * College London") and the flag reads better naming one than listing four.
 * Empty when the box is empty, which is the default and costs nothing. */
function instHits(sess) {
  if (!INST.length) return { n: 0, affs: [] };
  const affs = new Set();
  let n = 0;
  for (const p of sess.papers || []) {
    const hit = (p.affiliations || []).filter((a) => instMatches(a, INST));
    if (hit.length) { n++; hit.forEach((a) => affs.add(a)); }
  }
  return { n, affs: [...affs] };
}

function buildProfile(worksRaw, goalsRaw, filter = WORKS_FILTER_NONE) {
  const parsed = parseWorks(worksRaw);
  const worksChunks = parsed.kind === "works"
    ? filterWorks(parsed.items, filter).slice(0, WORKS_MAX_TITLES).map((it) => it.title)
    : chunkText(worksRaw, 420, WORKS_MAX_PROSE);
  const goalsChunks = chunkText(goalsRaw, 420, GOALS_MAX_CHUNKS);
  return {
    parsed,
    works: { chunks: worksChunks, quoteLabel: parsed.kind === "works" ? "your paper" : "your profile" },
    goals: { chunks: goalsChunks, quoteLabel: "your aims" },
    weights: sourceWeights(worksChunks, goalsChunks, goalsRaw),
  };
}

// `worksFilter` rides along because the boxes are refilled from here on load
// and restoreRoute checks the profile signature against them: drop the filter
// and yesterday's route is discarded every morning as a mismatch.
function buildFraglet(worksRaw, goalsRaw, days, mode, filter) {
  const brief = (goalsRaw || worksRaw).replace(/\s+/g, " ").slice(0, 160);
  return {
    title: "RGS-IBG 2026 conference interests",
    brief,
    detail: [worksRaw, goalsRaw].filter(Boolean).join("\n\n"),
    works: worksRaw,
    goals: goalsRaw,
    worksFilter: { ...filter },
    category: "interests",
    domain: "conference",
    tags: ["rgs-ibg-2026", `mode:${mode}`, ...days.map((d) => `day:${d}`)],
    visibility: "private",
    created_at: new Date().toISOString(),
    source: "agenda-navigator",
  };
}

// ---------- scoring (ucl-explorer facet aggregate) ----------

/* Below this a facet isn't worth citing as evidence.
 *
 * A rank within a box's own distribution, not an absolute similarity — the same
 * relative-not-absolute rule DUAL_PCTL follows, and for the same reason. As a raw
 * cosine 0.35 gated nothing whatever: on a real 67-title profile every goals best
 * landed at 0.35+, so the aims were cited as supporting evidence on all 623
 * sessions and the line stopped carrying any information. As a rank it means what
 * it was always meant to — the bottom third of what a box reaches is not evidence. */
const EV_MIN = 0.35;

/* Dual-match cut-off.
 *
 * Not an absolute similarity: bge scores sit in a narrow, corpus-dependent band
 * (almost every session clears 0.35 against almost any profile), so a fixed
 * threshold flags either everything or nothing. Both boxes must instead land in
 * the top slice of *their own* distribution over the candidate set, which keeps
 * the badge rare and meaningful whatever the person pasted.
 *
 * Set high on purpose. The blend already floats dual matches to the top of each
 * slot, so a looser cut-off badges nearly every pick and the eye stops seeing it.
 * This marks only the standouts.
 *
 * Applied to the *weaker* of the two ranks, not to each independently — see the
 * second pass in scoreSessions for why that distinction is the whole ballgame. */
const DUAL_PCTL = 0.97;

/* Below this margin, the evidence line may not name one paper.
 *
 * `Matches paper "X" — from your paper "Y"` reads as a claim that X and Y are
 * about the same thing. The model made a far weaker claim than that. Measured on
 * the real 67-title fixture against the shipped matrix: an arbitrary pair of
 * titles in this corpus scores 0.571 ± 0.058 and a *winning* pair scores 0.666,
 * so a match is about 1.6 sd above two papers with nothing in common — and on the
 * facets we actually quote (the profile's top 1%), the winner is within 0.02 of
 * the runner-up **53% of the time** and the top three are within 0.03 on 56%. So
 * more often than not the paper we name is ahead by a coin toss, and a reader who
 * asks "why that one?" is asking a question the number cannot answer.
 *
 * A percentile of the box's own gap distribution, not a float — the gaps are
 * differences of cosines and sit in the same narrow corpus-dependent band the
 * cosines do. At the median it means "this winner is no more clearly ahead than
 * this profile's typical winner", which is exactly when it should not be singled
 * out. Naming two is the honest output; it is also more information, not less. */
const MARGIN_PCTL = 0.5;

/* The gap this box needs before its winning chunk is worth naming on its own.
 * -Infinity (nothing is too close) when the pool has no runners-up to measure —
 * a single-chunk box is already handled by `sole`. */
function marginFloor(best) {
  const gaps = [];
  for (let f = 0; f < best.sim.length; f++) {
    if (best.which2[f] >= 0) gaps.push(best.sim[f] - best.second[f]);
  }
  return gaps.length ? percentile(gaps, MARGIN_PCTL) : -Infinity;
}

function percentile(values, p) {
  if (!values.length) return Infinity;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/* Rank one box's per-facet similarities within its own distribution.
 *
 * The two pools sit in different absolute bands, and the gap is an artifact rather
 * than a signal: measured on a real profile the works best averages 0.61 and the
 * goals best 0.50, because a max over 67 titles is drawn from 67 chances and a max
 * over one sentence from one. That ~0.11 says nothing about which box matches
 * better, so raw cosines from the two boxes are not comparable and any blend of
 * them quietly hands the bigger pool a head start on every facet. Ranking first
 * makes them commensurable. Spread survives the transform — the two boxes already
 * have near-identical sd (0.048 vs 0.050), so this changes the zero point, not the
 * relative influence, which stays where sourceWeights put it. */
function toRanks(sim) {
  const order = Array.from(sim.keys()).sort((a, b) => sim[a] - sim[b]);
  const rank = new Float32Array(sim.length);
  const last = Math.max(1, order.length - 1);
  for (let i = 0; i < order.length; i++) rank[order[i]] = i / last;
  return rank;
}

/* Which box (or both) to credit for a facet, strongest first.
 *
 * By rank, not raw cosine. The works band simply sits higher than the goals band,
 * so on raw scores the works box is cited on virtually every facet and always cited
 * first — which is how the aims came to be quoted, identically, under all 623
 * sessions. Ranks make "which box is really behind this" answerable. */
function creditFor(f, sources) {
  const from = [];
  for (const src of sources) {
    if (src.rank[f] >= EV_MIN && src.best.which[f] >= 0) {
      // Only worth naming one chunk when one is clearly ahead — see MARGIN_PCTL.
      const runnerUp = src.best.which2[f];
      const close = runnerUp >= 0 && (src.best.sim[f] - src.best.second[f]) < src.margin;
      from.push({
        label: src.quoteLabel,
        chunk: src.chunks[src.best.which[f]],
        chunk2: close ? src.chunks[runnerUp] : null,
        sim: src.rank[f],
        // A quote is there to say *which* of your lines matched. A box holding a
        // single chunk has no which — quoting it just reprints the same sentence
        // under every session, truncated at the same word, saying nothing.
        sole: src.chunks.length === 1,
      });
    }
  }
  return from.sort((a, b) => b.sim - a.sim);
}

// "your paper “X”" when the quote identifies something, plain "your aims" when the
// box only holds one line and the quote would be noise. Two quotes when neither
// is clearly the match — naming one of them would be inventing a precision the
// cosine doesn't have.
function creditHtml(c) {
  if (c.sole) return esc(c.label);
  const q = (s) => `<span class="q">“${esc(trunc(s, 80))}”</span>`;
  return c.chunk2
    ? `${esc(c.label)} ${q(c.chunk)} or ${q(c.chunk2)} <span class="q-close">(too close to separate)</span>`
    : `${esc(c.label)} ${q(c.chunk)}`;
}

/* The papers closest to you, whatever session they happened to land in.
 *
 * The agenda is session-granular but the matching is paper-granular, and the
 * aggregate deliberately throws the difference away: a session scores 0.75 of its
 * best facet plus 0.25 of its top three, so depth beats a lone bullseye. That is
 * usually right — 100 minutes in a session where everything lands beats 100 minutes
 * for one paper and two duds — but it means the single closest paper in the
 * programme can be invisible. On a real profile the second-best-matching paper of
 * 3204 sat five deep inside a collapsed <details>, in a session that genuinely
 * deserved to lose its slot. So don't fight the aggregation: report underneath it.
 *
 * No threshold anywhere here — it is a sort. Ranking N things needs no cut-off, and
 * every absolute cut-off over bge scores in this file has had to be walked back to a
 * percentile eventually. */
/* Deliberately deeper than the eye needs. This list is the only route a strong
 * paper has to the screen when its session loses, and 10 of 2,217 was too tight
 * to be that route: on a real profile "The Enshittification of the Smart City"
 * — one paper of five in a session about urban placemaking — missed the cut and
 * had to be found in the LLM brief instead. The cost of a longer list is
 * scrolling; the cost of a short one is a paper nobody ever sees. */
const TOP_PAPERS = 25;
// One session's papers shouldn't eat the list: if five of your ten live in the same
// room, that says one thing ("go there"), which the route already said. Capping at
// two spends the rest of the list on sessions you'd otherwise never hear about.
const TOP_PAPERS_PER_SESSION = 2;

function topPapers(facets, facetScore, sessions, allowed, sources) {
  const cand = [];
  for (let f = 0; f < facets.length; f++) {
    if (facets[f].kind === "paper" && allowed.has(facets[f].s)) cand.push(f);
  }
  cand.sort((a, b) => facetScore[b] - facetScore[a]);
  const perSession = new Map();
  const seen = new Set();
  const out = [];
  for (const f of cand) {
    if (out.length >= TOP_PAPERS) break;
    const si = facets[f].s;
    const used = perSession.get(si) || 0;
    if (used >= TOP_PAPERS_PER_SESSION) continue;
    // The programme lists some papers twice (same title, two sessions); dedupe on
    // the title the same way the Scholar parser does.
    const key = facets[f].label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    perSession.set(si, used + 1);
    out.push({ label: facets[f].label, session: sessions[si], score: facetScore[f], from: creditFor(f, sources) });
  }
  return out;
}

/* Who is doing the work nearest yours — as near as the public data allows.
 *
 * Ex Ordo withholds paper author names and publishes only presenting
 * affiliations, so this is institutions and research groups. The tab was called
 * "People" and spent its first paragraph explaining that it wasn't; it is now
 * labelled "Institutions & groups" and the explanation is one plain sentence.
 * The internal name stays `people` — it keys the saved route. Institutions
 * are ranked by how many of their papers land in the top decile of the paper-facet
 * distribution (a percentile, not an absolute cosine — same rule as everywhere),
 * tiebroken by their best paper. Groups are ranked like sessions are: mean of the
 * top 3 session scores, so a group with three good sessions beats one great
 * outlier plus filler. Session references are ids, not objects, so this survives
 * a localStorage round-trip unchanged. */
const TOP_INSTITUTIONS = 12;
const TOP_GROUPS = 8;

/* Affiliations are free text typed by 2,217 separate submitters, so the same
 * institution arrives spelled several ways: "University of Cape Town" and
 * "University of Cape town" listed as two entries, "Royal Holloway University
 * of London" ranked below "Royal Holloway, University of London" because its
 * papers were split across both. Group on a punctuation- and case-free key and
 * show whichever spelling was used most. 11 collisions in the final programme. */
const affKey = (a) => a.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();
const commonest = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

function buildPeople(results, facets, facetScore, sessions, allowed) {
  const paperF = [];
  for (let f = 0; f < facets.length; f++) {
    if (facets[f].kind === "paper" && allowed.has(facets[f].s)) {
      paperF.push({ label: facets[f].label, si: facets[f].s, score: facetScore[f] });
    }
  }
  paperF.sort((a, b) => b.score - a.score);
  const strong = percentile(paperF.map((p) => p.score), 0.9);

  const inst = new Map();
  const seenPaper = new Set();
  for (const pf of paperF) {
    const key = pf.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seenPaper.has(key)) continue;
    seenPaper.add(key);
    const paper = sessions[pf.si].papers.find((p) => p.title === pf.label);
    for (const aff of paper?.affiliations || []) {
      const akey = affKey(aff);
      let rec = inst.get(akey);
      if (!rec) inst.set(akey, rec = { names: new Map(), strong: 0, best: pf.score, papers: [] });
      rec.names.set(aff, (rec.names.get(aff) || 0) + 1);
      if (pf.score >= strong) rec.strong++;
      if (rec.papers.length < 3) rec.papers.push({ label: pf.label, id: sessions[pf.si].id });
    }
  }
  const institutions = [...inst.values()]
    .filter((r) => r.strong > 0)
    .sort((a, b) => b.strong - a.strong || b.best - a.best)
    .slice(0, TOP_INSTITUTIONS)
    .map(({ names, strong, papers }) => ({ name: commonest(names), strong, papers }));

  const groups = new Map();
  for (const r of results) {
    const code = r.session.group;
    if (!code || !GROUP_NAMES[code] || isAdminSession(r.session)) continue;
    const name = GROUP_NAMES[code];
    let rec = groups.get(name);
    if (!rec) groups.set(name, rec = { name, code, count: 0, top: [], ids: [] });
    rec.count++;
    if (rec.top.length < 3) rec.top.push(r.score);
    if (rec.ids.length < 2) rec.ids.push(r.session.id);
  }
  const ranked = [...groups.values()]
    .map((g) => ({ ...g, score: g.top.reduce((a, b) => a + b, 0) / g.top.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_GROUPS)
    .map(({ name, code, count, ids }) => ({ name, code, count, ids }));

  return { institutions, groups: ranked };
}

/* Best similarity + winning chunk per facet, for one source pool.
 *
 * Also carries the runner-up, because the winner alone is a misleading thing to
 * report. Eight papers on the same topic all land within a hair of each other,
 * so one of them takes the argmax on every facet in that area and *looks* like
 * it is driving the agenda, while removing it changes nothing — its neighbour
 * steps up. `gap` (best minus second-best) is what separates a paper that is
 * merely credited from one that is actually carrying the match. Measured: this
 * is not a hypothetical, see the concentration line's numbers in CLAUDE.md.
 *
 * `which2` is the runner-up's index, kept for the same reason the score is: when
 * the gap is small the evidence line has no business naming one paper, and to
 * name two you need to know which two. */
function bestPerFacet(vecs) {
  const { facets, matrix, dim } = DATA;
  const sim = new Float32Array(facets.length);
  const second = new Float32Array(facets.length);
  const which = new Int16Array(facets.length).fill(-1);
  const which2 = new Int16Array(facets.length).fill(-1);
  for (let q = 0; q < vecs.length; q++) {
    const qv = vecs[q];
    for (let f = 0; f < facets.length; f++) {
      let dot = 0;
      const off = f * dim;
      for (let k = 0; k < dim; k++) dot += matrix[off + k] * qv[k];
      if (dot > sim[f]) { second[f] = sim[f]; which2[f] = which[f]; sim[f] = dot; which[f] = q; }
      else if (dot > second[f]) { second[f] = dot; which2[f] = q; }
    }
  }
  return { sim, second, which, which2 };
}

function scoreSessions(profile, filters) {
  const { sessions, facets } = DATA;
  const nFacets = facets.length;
  const w = profile.weights;
  const W = { ...profile.works, best: bestPerFacet(profile.works.vecs) };
  const G = { ...profile.goals, best: bestPerFacet(profile.goals.vecs) };
  W.rank = toRanks(W.best.sim);
  G.rank = toRanks(G.best.sim);
  W.margin = marginFloor(W.best);
  G.margin = marginFloor(G.best);

  /* Blend as a weighted *geometric* mean of the two ranks, because the point of
   * asking twice is agreement.
   *
   * A weighted arithmetic mean is compensatory: it rewards a high total, so a
   * session the works box barely reaches (rank p59) can ride a strong aims rank
   * (p100) straight into the agenda, and one did. A product cannot be bought that
   * way — a weak rank on either side drags the result down, and only a session both
   * boxes reach scores well, which is what the two boxes promise on the landing
   * page. Weights are exponents rather than coefficients, so they still divide the
   * influence, and a box that is empty (weight 0) contributes a factor of exactly 1
   * and lets the other pass through untouched.
   *
   * Result is a joint rank in 0–1, not a similarity. EV_MIN and the weak-slot
   * threshold read it as such; norm() min-maxes it, so the match bar is unaffected. */
  const facetScore = new Float32Array(nFacets);
  for (let f = 0; f < nFacets; f++) {
    facetScore[f] = Math.pow(W.rank[f], w.works) * Math.pow(G.rank[f], w.goals);
  }

  // aggregate per session
  const perSession = new Map();
  for (let f = 0; f < nFacets; f++) {
    const s = facets[f].s;
    if (!perSession.has(s)) perSession.set(s, []);
    perSession.get(s).push(f);
  }
  const results = [];
  const allowed = new Set();
  for (const [si, fIdxs] of perSession) {
    const sess = sessions[si];
    if (!filters.days.has(sess.day)) continue;
    if (!modeAllowed(sess.mode, filters.mode)) continue;
    allowed.add(si);
    fIdxs.sort((a, b) => facetScore[b] - facetScore[a]);
    const top = fIdxs.slice(0, 3).map((f) => facetScore[f]);
    const score = 0.75 * top[0] + 0.25 * (top.reduce((a, b) => a + b, 0) / top.length);

    // How hard each box lands on this session — not necessarily on the same facet
    // (your paper may hit paper 3 while your aims hit the theme). Thresholded
    // below, once the whole distribution is known.
    let worksHit = 0, goalsHit = 0;
    for (const f of fIdxs) {
      if (W.best.sim[f] > worksHit) worksHit = W.best.sim[f];
      if (G.best.sim[f] > goalsHit) goalsHit = G.best.sim[f];
    }

    const evidence = [];
    for (const f of fIdxs) {
      if (evidence.length >= 2 || facetScore[f] <= EV_MIN) break;
      const kind = facets[f].kind;
      // at most one "session theme" line; papers are individually informative
      if (kind === "session" && evidence.some((e) => e.kind === "session")) continue;
      evidence.push({ kind, label: facets[f].label, score: facetScore[f], from: creditFor(f, [W, G]) });
    }
    results.push({ session: sess, score, evidence, worksHit, goalsHit, dual: false });
  }

  /* Second pass: the badge only means something once we know the spread.
   *
   * Badge on the *weaker* of the two ranks. "Both point here" is a claim about the
   * side that agrees least, so that is the side to threshold. Asking instead for the
   * top 3% of each box independently sounds equivalent and is not: the two ranks are
   * only loosely correlated, so the joint event is nearer 0.1% than 3% and the badge
   * fired on 0 of 623 sessions — including the best dual match in the agenda (works
   * p89, aims p100), which missed on a works rank that was merely very good. Taking
   * a percentile of the min is self-calibrating: the top slice by agreement exists
   * whatever the correlation turns out to be. */
  if (w.works > 0 && w.goals > 0) {
    const rankIn = (vals) => {
      const sorted = Float64Array.from(vals).sort();
      return (v) => {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
        return lo / Math.max(1, sorted.length - 1);
      };
    };
    const rw = rankIn(results.map((r) => r.worksHit));
    const rg = rankIn(results.map((r) => r.goalsHit));
    const agree = results.map((r) => Math.min(rw(r.worksHit), rg(r.goalsHit)));
    const t = percentile(agree, DUAL_PCTL);
    results.forEach((r, i) => { r.dual = agree[i] >= t; });
  }

  /* How much of the programme each of your papers is speaking for.
   *
   * `bestPerFacet` takes the max over titles, so every facet is won by exactly
   * one of them, and that distribution is nothing like uniform: measured on the
   * real 67-title fixture, one paper wins 20.2% of all 3,309 facets and the top
   * three take 36.4%. Two or three papers write the agenda and, until this
   * existed, nothing on screen said so — which is the failure behind "a couple
   * of papers are hitting against everything". It is free to compute (the argmax
   * is already in W.best.which) and it is the only thing here that makes the max
   * visible, so it is reported whether or not it looks bad.
   *
   * Counted over allowed sessions only, so the denominator is the programme the
   * user actually asked about rather than the days they aren't coming. */
  const worksWins = {};
  let winFacets = 0;
  let winGap = 0;
  if (W.chunks.length) {
    for (const [si, fIdxs] of perSession) {
      if (!allowed.has(si)) continue;
      for (const f of fIdxs) {
        const q = W.best.which[f];
        if (q < 0) continue;
        const t = W.chunks[q];
        // What would be lost if this paper weren't in the box: nearly nothing
        // when a near-twin sits behind it, the whole similarity when it is the
        // only title in the pool (`second` is 0 there). Summed, never
        // thresholded — comparing a float literal against a cosine is the
        // mistake this file is full of.
        const gap = W.best.sim[f] - W.best.second[f];
        const w = worksWins[t] ?? (worksWins[t] = { n: 0, gap: 0 });
        w.n++;
        w.gap += gap;
        winFacets++;
        winGap += gap;
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  // Papers and people respect the day/mode filters for the same reason the route
  // does: there is no point being shown the perfect paper on a day you aren't here.
  return {
    results,
    worksWins,
    winFacets,
    winGap,
    papers: topPapers(facets, facetScore, sessions, allowed, [W, G]),
    people: buildPeople(results, facets, facetScore, sessions, allowed),
  };
}

function modeAllowed(mode, filter) {
  if (filter === "any") return true;
  if (filter === "inperson") return mode !== "online";
  if (filter === "online") return mode === "online" || mode === "hybrid" || mode === "unspecified";
  return true;
}

// ---------- agenda assembly ----------

// Socials, receptions, placeholders and admin slots aren't content — any
// semantic match against them is noise, so never present one as a
// recommendation (they still appear as "closest is …" in weak slots).
const ADMIN_TITLE = /\b(reception|drinks|welcome|placeholder|place ?holder|business meeting|agm|prize|awards)\b/i;
/* "Social" can't go in the list above: in this programme it is far more often a
 * topic than an event ("Social Infrastructure and the Making of Just Places",
 * "Social Movements, Protests and Anti-tourism Activism"). Papers usually save
 * those, but a paperless session doesn't get that protection — the final
 * programme's "Social and Cultural Geographies in Policy and Practice: A
 * Practical Workshop" is a real workshop with a 1,767-char description that the
 * bare word filtered out. It only reads as admin when it *names* the event:
 * "…Evening Social", "…Lunchtime Social", "…Social Hour". */
const SOCIAL_EVENT = /\bsocial\s*$|\bsocial\s+(hour|event|evening|night)\b/i;
function isAdminSession(s) {
  if (s.papers.length > 0) return false;
  return s.description.length < 200 || ADMIN_TITLE.test(s.title) || SOCIAL_EVENT.test(s.title);
}

const slotKey = (s) => `${s.day}|${s.start}`;

function buildAgenda(results, prefs) {
  const choices = prefs?.choices || new Map();
  const dismissed = prefs?.dismissed || new Set();
  const min = Math.min(...results.map((r) => r.score));
  const max = Math.max(...results.map((r) => r.score));
  const norm = (s) => (max > min ? (s - min) / (max - min) : 0.5);

  const slots = new Map(); // "day|start" -> [result]
  for (const r of results) {
    const key = slotKey(r.session);
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(r);
  }
  // First pass: rank each slot and find the ones too weak to be worth a decision.
  // Sort by the "day|start" key explicitly. A bare .sort() would order the
  // [key, list] pairs by Array-to-string coercion — right only by accident of
  // ISO keys sorting lexicographically, and a trap for whoever changes the key.
  const prepared = [...slots.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([key, list]) => {
    const [day] = key.split("|");
    list.sort((a, b) => b.score - a.score);
    const live = list.filter((r) => !dismissed.has(r.session.id));
    const substantive = live.filter((r) => !isAdminSession(r.session));
    const ranked = substantive.length ? substantive : (live.length ? live : list);
    // A pin is the user overruling the ranking; it also overrules "weak".
    const pinnedId = choices.get(key);
    const pinned = pinnedId != null ? list.find((r) => r.session.id === pinnedId) : null;
    /* A session the user is presenting in outranks the scoring, and overrules
     * "weak" exactly as a pin does. "Tell me when my own talk is" is not a
     * recommendation, and a poor match is precisely when it needs saying — the
     * whole failure being guarded against is walking into someone else's session
     * at the hour you were meant to be in the room. An explicit pin still wins:
     * that is a later and louder instruction from the same person. */
    const own = pinned ? null : list.find((r) => mine.has(r.session.id)) || null;
    const weak = !pinned && !own && (norm(ranked[0].score) < WEAK_REL || !substantive.length);
    // Infinity, not 0, for a one-session slot: no runner-up means no contest, and it
    // must not count as the closest call of the day.
    const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : Infinity;
    return { key, day, list, ranked, pinned, own, weak, gap, hidden: list.length - live.length };
  });

  // Second pass: "closest" only means something once every gap is known. Measure
  // over the real decisions — weak slots aren't ones you're choosing in, and a
  // pinned slot has already been decided.
  const gaps = prepared.filter((p) => !p.weak && !p.pinned && !p.own && p.gap < Infinity).map((p) => p.gap);
  const clashMax = gaps.length >= CLASH_MIN_SLOTS ? percentile(gaps, CLASH_PCTL) : -Infinity;

  const days = new Map();
  for (const p of prepared) {
    // No clash card over a decided slot: your own talk is not a close call.
    const clash = !p.pinned && !p.own && !p.weak && p.gap <= clashMax;
    const top = p.pinned || p.own || p.ranked[0];
    const rest = p.ranked.filter((r) => r !== top);
    const slot = {
      key: p.key,
      start: top.session.start,
      end: top.session.end,
      parallel: p.list.length,
      pick: top,
      pinned: !!p.pinned,
      own: !!p.own,
      clashWith: clash ? rest[0] : null,
      alternatives: rest.slice(clash ? 1 : 0, clash ? 4 : 3),
      weak: p.weak,
      hidden: p.hidden,
      relStrength: norm(top.score),
      // The whole slot in rank order. The page only ever draws the top four, but
      // the LLM brief wants a deeper shortlist and this is already computed —
      // it holds references, not copies, and saveRoute serialises STATE.results
      // rather than the agenda, so nothing here reaches localStorage.
      ranked: p.ranked,
    };
    if (!days.has(p.day)) days.set(p.day, []);
    days.get(p.day).push(slot);
  }
  return { days, norm };
}

// ---------- route persistence ----------

/* The route survives a reload so that on a conference morning the page opens
 * to yesterday's plan straight from localStorage — no model download, no
 * re-embed, no network. Only ids and display strings are stored; sessions are
 * re-joined to the freshly loaded programme, and a changed dataSig discards
 * the lot rather than showing a route built from data that no longer exists. */
const slimCredit = ({ label, chunk, chunk2, sole }) => ({ label, chunk, chunk2, sole });

/* Identity of the input that produced a route. djb2 over both boxes — not for
 * security, just so a saved route can prove it belongs to the profile on screen
 * before it renders as "Your route".
 *
 * The works filters decide which papers were matched on, so they belong to that
 * identity: the same paste with "only papers I led" ticked is a different
 * profile, and must not restore yesterday's route as if it weren't. Folded in
 * only when a filter is actually set, so an unfiltered profile hashes exactly
 * as it did before this existed and no route already in localStorage is
 * discarded by the upgrade. */
function profileSig(works, goals, filter = WORKS_FILTER_NONE) {
  const s = `${works}\u0000${goals}`;
  const set = filter.since || filter.firstOnly || filter.excluded?.length;
  const sig = set
    ? `${s}|${filter.since ?? ""}|${filter.firstOnly ? 1 : 0}|${[...(filter.excluded ?? [])].sort().join("")}`
    : s;
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function saveRoute() {
  if (!STATE) return;
  const slim = {
    dataSig: dataSig(),
    profileSig: STATE.profileSig,
    device: STATE.device,
    chartedAt: STATE.chartedAt,
    filters: { days: [...STATE.filters.days], mode: STATE.filters.mode },
    worksPick: STATE.worksPick,
    weights: STATE.weights,
    choices: Object.fromEntries(STATE.choices),
    dismissed: [...STATE.dismissed],
    results: STATE.results.map((r) => ({
      id: r.session.id, score: r.score, dual: r.dual,
      evidence: r.evidence.map((e) => ({ kind: e.kind, label: e.label, from: e.from.map(slimCredit) })),
    })),
    papers: STATE.papers.map((p) => ({ label: p.label, id: p.session.id, from: p.from.map(slimCredit) })),
    people: STATE.people,
  };
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(slim)); } catch { /* fraglet still saves */ }
}

function restoreRoute() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ROUTE_KEY) || "null"); } catch { return false; }
  if (!saved || saved.dataSig !== dataSig() || !saved.results?.length) return false;
  // A route may only render as "Your route" for the profile that produced it.
  // The boxes are refilled from the fraglet before this runs, so a mismatch
  // means the input changed since charting — discard rather than masquerade.
  const sig = profileSig($("#works").value.trim(), $("#goals").value.trim(), worksFilter);
  if (saved.profileSig !== sig) {
    try { localStorage.removeItem(ROUTE_KEY); } catch { /* fine */ }
    return false;
  }
  const results = saved.results
    .map((r) => (DATA.byId.has(r.id) ? { ...r, session: DATA.byId.get(r.id) } : null))
    .filter(Boolean);
  if (!results.length) return false;
  STATE = {
    results,
    papers: (saved.papers || [])
      .map((p) => (DATA.byId.has(p.id) ? { ...p, session: DATA.byId.get(p.id) } : null))
      .filter(Boolean),
    people: saved.people || { institutions: [], groups: [] },
    weights: saved.weights,
    filters: { days: new Set(saved.filters.days), mode: saved.filters.mode },
    worksPick: saved.worksPick || null,
    choices: new Map(Object.entries(saved.choices || {}).map(([k, v]) => [k, Number(v)])),
    dismissed: new Set(saved.dismissed || []),
    chartedAt: saved.chartedAt,
    profileSig: saved.profileSig,
    device: saved.device,
  };
  renderAll({ restored: true });
  refreshWorksNote();   // a restored route carries its shares with it
  return true;
}

// ---------- rendering ----------

const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
const fmtStamp = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const t = (iso) => fmtTime.format(new Date(iso));
const dayName = (d) => fmtDay.format(new Date(d + "T12:00:00Z"));
// Inside a running line — a paper's "where", a day tab — the long form eats
// the line: "Thursday 3 September 11:10" says nothing "Thu 3 Sept 11:10" doesn't.
const fmtDayShort = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
const dayShort = (d) => fmtDayShort.format(new Date(d + "T12:00:00Z"));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function evidenceHtml(ev) {
  if (!ev.length) return "";
  const seen = new Set();
  const items = ev.map((e) => {
    const what = e.kind === "paper" ? `paper “${esc(trunc(e.label, 90))}”` : "the session theme";
    const parts = [];
    for (const f of e.from) {
      const key = `${f.label}|${f.chunk}|${f.chunk2 ?? ""}`;
      if (seen.has(key)) continue;   // don't quote the same line of input twice
      seen.add(key);
      parts.push(creditHtml(f));
    }
    const from = parts.length ? ` — from ${parts.join(" and ")}` : "";
    return `<li><span class="why">Matches ${what}</span>${from}</li>`;
  });
  return `<ul class="evidence">${items.join("")}</ul>`;
}

function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

// Ex Ordo's public session pages route on the schedule_event id (`eid`), which
// data before the July 2026 refresh doesn't carry — hence the guard.
function exordoUrl(s) {
  if (!s.eid) return null;
  const slug = s.title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${EXORDO_BASE}/session/${s.eid}/${slug}`;
}

/* Rooms were placeholders until the final programme: Ex Ordo named 456 of the
 * 623 rooms "In-person 10" and the like, so printing the room and then the mode
 * gave you "In-person 10 · in person". Real rooms landed on 11 Aug 2026 and the
 * problem inverted — they're long, and 500+ of 593 end in the same six words
 * ("… Room 407A, Imperial College London"), which is noise on a line that
 * already carries the code, the mode and the paper count. Drop the host
 * institution for display only; ICS keeps the full string, because a calendar
 * entry is the one place you actually want the address. The mode guard stays:
 * it costs a line and the placeholders could return for a future conference. */
const VENUE_HOST = /,\s*Imperial College London\s*$/i;
const VENUE_OFFSITE = /^(Offsite \d+)\s*-\s*SEE SESSION DETAILS.*$/i;
function venueLabel(s) {
  if (!s.venue) return "";
  return s.venue.replace(VENUE_HOST, "").replace(VENUE_OFFSITE, "$1 — see session details").trim();
}

function metaBits(s) {
  const modeLabel = { "in-person": "in person", hybrid: "hybrid", online: "online", unspecified: "" }[s.mode];
  const venue = venueLabel(s) || "venue tbc";
  const venueSaysMode = modeLabel && venue.toLowerCase().replace(/-/g, " ").startsWith(modeLabel);
  const papers = s.papers.length
    ? `${s.papers.length} paper${s.papers.length === 1 ? "" : "s"}`
    : "panel/plenary";
  return [s.code, venue, venueSaysMode ? "" : modeLabel, papers].filter(Boolean);
}

// The clash card says "read both and pick" — that needs the contents on hand,
// not just a title. Kept collapsed so the route stays scannable.
function contentsHtml(s) {
  const desc = s.description ? `<p class="sess-desc">${esc(trunc(s.description, 700))}</p>` : "";
  const papers = s.papers.length
    ? `<ol class="sess-papers">${s.papers.map((p) =>
        `<li>${esc(p.title)}${p.affiliations?.length ? ` <span class="aff mono">${esc(p.affiliations.join(" · "))}</span>` : ""}</li>`).join("")}</ol>`
    : "";
  const url = exordoUrl(s);
  const link = url ? `<p class="sess-link"><a href="${url}" rel="noopener" target="_blank">Open in the official programme</a></p>` : "";
  if (!desc && !papers) return "";
  return `<details class="contents"><summary>What's in this session</summary>${desc}${papers}${link}</details>`;
}

/* Red is the second colour on this page, and it took an argument to add.
 *
 * The rule is that yellow means "this is the one" and nothing else is coloured,
 * which is why yellow is scannable. Red here means something yellow cannot:
 * *you have an obligation at this time*. It is not a stronger recommendation,
 * it is a different kind of statement, it fires once or twice in a whole week,
 * and it is the one line on the page whose cost of being missed is real. A
 * second colour survives only while it keeps a single meaning — the moment
 * anything else on this page turns red, both colours stop working. */
function flagsHtml(s) {
  const out = [];
  if (mine.has(s.id)) {
    out.push(`<span class="flag flag-own">You said you're presenting in this one</span>`);
  }
  const { n, affs } = instHits(s);
  if (n) {
    const who = affs.length > 1 ? `${esc(affs[0])} and ${affs.length - 1} more` : esc(affs[0]);
    out.push(`<span class="flag flag-inst">${n} paper${n === 1 ? "" : "s"} from ${who}</span>`);
  }
  return out.length ? `<div class="flags">${out.join("")}</div>` : "";
}

// Available on every session the route draws, not just the pick: the talk you
// are in may well be the one the tool ranked fourth.
function mineBtn(id) {
  return mine.has(id)
    ? `<button type="button" class="mini" data-act="unmine" data-id="${id}">Not mine after all</button>`
    : `<button type="button" class="mini" data-act="mine" data-id="${id}">I'm presenting in this</button>`;
}

function controlsHtml(r, slot, role) {
  const id = r.session.id;
  const own = mineBtn(id);
  /* Nothing else to offer on your own talk. "Not this one" in particular would
   * be a lie: dismissing hides a session from the ranking, but the promotion
   * reads the unfiltered slot list, so the button would appear to do nothing.
   * The way out of this slot is to say it isn't yours. */
  if (mine.has(id)) return own;
  if (role === "alt") {
    return `<button type="button" class="mini" data-act="pin" data-id="${id}" data-slot="${esc(slot.key)}">Make this my pick</button> ${own}`;
  }
  if (role === "clash") {
    return `<button type="button" class="mini" data-act="pin" data-id="${id}" data-slot="${esc(slot.key)}">Go with this one</button> ${own}`;
  }
  if (slot.pinned) {
    return `<span class="pin-chip mono">your pick</span>
      <button type="button" class="mini" data-act="unpin" data-id="${id}" data-slot="${esc(slot.key)}">Unpin</button> ${own}`;
  }
  return `<button type="button" class="mini" data-act="dismiss" data-id="${id}" data-slot="${esc(slot.key)}">Not this one</button> ${own}`;
}

/* The highlighter says "this is the one you're going to". A pinned pick gets the
 * full mark, the tool's own suggestion a thin stroke — the difference between a
 * decision and a recommendation. Alternatives and both halves of an undecided
 * clash get nothing, because nothing has been decided in them yet. */
function markClass({ clash, slot, role }) {
  if (clash || role !== "pick" || !slot) return "";
  // A session you are presenting in is a decision, not a suggestion, so it takes
  // the full highlighter a pin does. The thin stroke would say "we reckon".
  return slot.pinned || slot.own ? "mark" : "mark-soft";
}

function pickHtml(r, norm, { clash = false, slot = null, role = "pick" } = {}) {
  const s = r.session;
  const controls = slot ? `<div class="pick-controls">${controlsHtml(r, slot, role)}</div>` : "";
  const cls = markClass({ clash, slot, role });
  return `<article class="pick">
    ${r.dual ? `<span class="tagline">matches your work and your aims</span>` : ""}
    <h4><span class="${cls}">${esc(s.title)}</span></h4>
    <span class="meta mono">${metaBits(s).map(esc).join(" · ")}</span>
    ${flagsHtml(s)}
    <div class="match-bar" role="img" aria-label="match strength ${Math.round(norm(r.score) * 100)} of 100"><span style="width:${Math.round(norm(r.score) * 100)}%"></span></div>
    ${evidenceHtml(r.evidence)}
    ${contentsHtml(s)}
    ${controls}
  </article>`;
}

/* Times sit in a gutter down the left, so the route reads the way a timetable
 * does — eye down the clock, not down a list of cards. */
function slotHtml(slot, norm) {
  const when = `<div class="slot-when"><b>${t(slot.start)}</b>${t(slot.end)}
    <span class="parallel">${slot.parallel} parallel</span></div>`;
  const restore = slot.hidden
    ? `<div class="hidden-note">${slot.hidden} hidden
        <button type="button" class="mini" data-act="restore" data-slot="${esc(slot.key)}">restore</button></div>`
    : "";
  const wrap = (inner) =>
    `<div class="slot" data-start="${slot.start}" data-end="${slot.end}">${when}<div class="slot-body">${inner}</div></div>`;

  if (slot.weak) {
    return wrap(`<div class="weak-slot">Nothing here matches you well — nearest is
      <span class="pick-inline">${esc(slot.pick.session.title)}</span>
      (${esc(venueLabel(slot.pick.session) || "venue tbc")}). Take the break.</div>${restore}`);
  }
  let body;
  if (slot.clashWith) {
    body = `<p class="clash-note">Close call — these two are effectively tied for you. Read both, pick one:</p>
      <div class="fork">
        ${pickHtml(slot.pick, norm, { clash: true, slot, role: "clash" })}
        ${pickHtml(slot.clashWith, norm, { clash: true, slot, role: "clash" })}
      </div>`;
  } else {
    body = pickHtml(slot.pick, norm, { slot });
  }
  const alts = slot.alternatives.length
    ? `<details class="alts"><summary>Also in this slot (${slot.alternatives.length})</summary>
        ${slot.alternatives.map((a) => pickHtml(a, norm, { slot, role: "alt" })).join("")}</details>`
    : "";
  return wrap(`${body}${alts}${restore}`);
}

/* Which sessions the route is actually sending you to — picks and both halves of a
 * clash, but not the alternatives, which are already presented as roads not taken. */
function routedSessionIds(days) {
  const ids = new Set();
  for (const slots of days.values()) {
    for (const s of slots) {
      if (s.weak) continue;
      ids.add(s.pick.session.id);
      if (s.clashWith) ids.add(s.clashWith.session.id);
    }
  }
  return ids;
}

function papersHtml(papers, routed) {
  if (!papers.length) return "<p class='hint'>No papers to show yet.</p>";
  const rows = papers.map((p) => {
    const inRoute = routed.has(p.session.id);
    const quote = p.from.length ? `<div class="paper-why">Matches ${creditHtml(p.from[0])}</div>` : "";
    const flag = inRoute
      ? `<span class="paper-flag in-route">already in your route</span>`
      : `<span class="paper-flag catch">worth catching</span>`;
    return `<li>
      <div class="paper-title">${esc(p.label)}</div>
      <div class="paper-where"><span class="mono">${dayShort(p.session.day)} ${t(p.session.start)}</span> ·
        ${esc(p.session.title)}${p.session.venue ? ` · ${esc(venueLabel(p.session))}` : ""}</div>
      ${quote}${flag}
    </li>`;
  }).join("");
  return `<div class="papers-card">
    <h3>The ${papers.length} papers closest to you</h3>
    <p class="hint">The route above picks whole sessions, so a paper that matches you well can
    sit inside a session that didn't make the cut. These are the papers themselves, wherever
    they landed.</p>
    <ol class="paper-list">${rows}</ol>
  </div>`;
}

function sessionLine(id) {
  const s = DATA.byId.get(id);
  if (!s) return "";
  return `<div class="mini-session">
    <span class="mini-title">${esc(s.title)}</span>
    <span class="mono">${dayShort(s.day)} ${t(s.start)}${s.venue ? ` · ${esc(venueLabel(s))}` : ""}</span>
  </div>`;
}

function peopleHtml(people) {
  const inst = people.institutions.length
    ? `<div class="people-card">
        <h3>Institutions doing work near yours</h3>
        <p class="hint">The programme publishes presenting affiliations but no author names,
        so this ranks institutions rather than researchers. Ordered by how many of their
        papers land in the top tenth of your matches.</p>
        <ol class="inst-list">${people.institutions.map((r) => `
          <li>
            <div class="inst-head"><strong>${esc(r.name)}</strong>
              <span class="mono">${r.strong} close paper${r.strong === 1 ? "" : "s"}</span></div>
            <ul class="inst-papers">${r.papers.map((p) => {
              const s = DATA.byId.get(p.id);
              return `<li>${esc(p.label)}${s ? ` <span class="mono">${dayShort(s.day)} ${t(s.start)}</span>` : ""}</li>`;
            }).join("")}</ul>
          </li>`).join("")}</ol>
      </div>`
    : "";
  const groups = people.groups.length
    ? `<div class="people-card">
        <h3>Research groups convening your kind of sessions</h3>
        <p class="hint">RGS-IBG research groups sponsoring the sessions that score highest for
        you. Their sessions and socials are a good bet for meeting the same people twice.</p>
        <ol class="group-list">${people.groups.map((g) => `
          <li>
            <div class="inst-head"><strong>${esc(g.name)}</strong>
              <span class="mono">${g.code} · ${g.count} session${g.count === 1 ? "" : "s"}</span></div>
            ${g.ids.map(sessionLine).join("")}
          </li>`).join("")}</ol>
      </div>`
    : "";
  return (inst + groups) || "<p class='hint'>Nothing to show yet — chart a route first.</p>";
}

// ---------- lookup ----------

function lookupHtml(q) {
  const ql = q.trim().toLowerCase();
  if (ql.length < 2) return "";
  const rankOf = new Map(STATE.results.map((r, i) => [r.session.id, i + 1]));
  const norm = STATE.agenda.norm;
  const hits = DATA.sessions
    .filter((s) => s.title.toLowerCase().includes(ql) || s.code.toLowerCase().includes(ql))
    .slice(0, 20);
  if (!hits.length) return `<p class="hint">No session title or code contains “${esc(q)}”.</p>`;
  const total = STATE.results.length;
  return hits.map((s) => {
    const rank = rankOf.get(s.id);
    const r = rank ? STATE.results[rank - 1] : null;
    const where = `<span class="mono">${dayShort(s.day)} ${t(s.start)}${s.venue ? ` · ${esc(venueLabel(s))}` : ""}</span>`;
    if (!r) {
      return `<div class="lookup-hit"><h4>${esc(s.title)}</h4>${where}${flagsHtml(s)}
        <p class="hint">Outside your current day or attendance filters, so it wasn't ranked.</p>
        <div class="pick-controls">${mineBtn(s.id)}</div></div>`;
    }
    const note = isAdminSession(s) ? `<p class="hint">Social/admin session — never recommended, whatever it scores.</p>` : "";
    return `<div class="lookup-hit">
      <h4>${esc(s.title)}</h4>${where}
      ${flagsHtml(s)}
      <div class="lookup-rank">Ranked <strong>#${rank}</strong> of ${total} for you</div>
      <div class="match-bar"><span style="width:${Math.round(norm(r.score) * 100)}%"></span></div>
      ${evidenceHtml(r.evidence)}${note}
      <div class="pick-controls">${mineBtn(s.id)}</div>
    </div>`;
  }).join("");
}

// ---------- ICS export ----------

function icsEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
const icsDate = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// RFC 5545 wants lines ≤ 75 octets, folded with CRLF + space. Some parsers
// (Google) genuinely reject unfolded long lines, so this isn't optional.
function icsFold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = " " + line.slice(74); }
  out.push(line);
  return out;
}

function evidenceText(r) {
  return r.evidence.map((e) => {
    const what = e.kind === "paper" ? `paper "${e.label}"` : "the session theme";
    const from = e.from.map((f) => {
      if (f.sole) return f.label;
      return f.chunk2
        ? `${f.label} "${trunc(f.chunk, 60)}" or "${trunc(f.chunk2, 60)}" (too close to separate)`
        : `${f.label} "${trunc(f.chunk, 60)}"`;
    }).join(" and ");
    return `Matches ${what}${from ? ` — from ${from}` : ""}`;
  }).join("\n");
}

function buildIcs(days) {
  const stamp = icsDate(new Date().toISOString());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Agenda Navigator//RGS-IBG 2026//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const slots of days.values()) {
    for (const slot of slots) {
      if (slot.weak) continue;
      // An unresolved clash exports as two overlapping events — that's what an
      // unresolved clash is. Pinning one first removes the other.
      const picks = slot.clashWith ? [slot.pick, slot.clashWith] : [slot.pick];
      for (const r of picks) {
        const s = r.session;
        const url = exordoUrl(s);
        const desc = [evidenceText(r), s.code ? `Session ${s.code}` : "", url || ""]
          .filter(Boolean).join("\n");
        lines.push("BEGIN:VEVENT",
          `UID:traverse-${s.id}@rgs2026`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${icsDate(s.start)}`,
          `DTEND:${icsDate(s.end)}`,
          `SUMMARY:${icsEscape(s.title)}`,
          `LOCATION:${icsEscape(s.venue || "venue tbc")}`,
          `DESCRIPTION:${icsEscape(desc)}`,
          "END:VEVENT");
      }
    }
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(icsFold).join("\r\n") + "\r\n";
}

function downloadIcs() {
  if (!STATE?.agenda) return;
  const blob = new Blob([buildIcs(STATE.agenda.days)], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "agenda-navigator-rgs2026-route.ics";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- the brief for your own LLM ----------
 *
 * A second opinion on the route, not a second route. The split of labour is the
 * point: the embedding pass ranks all 593 sessions without getting bored or
 * anchoring on what it read first, and is completely unable to handle "no more
 * energy justice, I've done a decade of it", "nothing before 10", or "that's
 * the same four people I saw yesterday". An LLM is good at exactly those and
 * would be bad at the ranking — 593 items in one pass is where anchoring and
 * skimming the middle live.
 *
 * So this hands over the ranking as a result and asks for the judgement. It
 * carries a deep shortlist rather than the four picks the page draws, because
 * the LLM's whole job is to reach for something the cosine put fifth.
 *
 * SHORTLIST_PER_SLOT is set from measurement, not taste: at 14 the brief is
 * ~120 kB / ~30k tokens on the real fixture, which every current model takes
 * comfortably and which claude.ai converts to an attachment on paste. Raising
 * it is cheap in tokens and gets steadily less useful — by rank 14 the sessions
 * are ones the profile barely touches.
 *
 * This is the one feature here that sends the user's text off the device, and
 * the copy next to the button says so in those words. It is their LLM and their
 * choice; it is not a thing to be quiet about on a page whose pitch is the
 * opposite. */
const SHORTLIST_PER_SLOT = 14;

/* Three tiers, because the deep end of the shortlist is there to be *noticed*,
 * not read. A session at rank 12 of a 45-way slot is a weak match by
 * construction; carrying its full abstract costs about a kilobyte and buys
 * nothing, while its title and its paper titles are what let the model spot
 * that it is the one thing all week about the subject I actually asked for.
 * Measured on the real fixture: flat payload gave 266 kB, tiered gives ~150 kB
 * for the same 185 sessions, and the part that got cut is the part no reader
 * would have reached. */
const TIERS = {
  pick:  { desc: Infinity, papers: Infinity, evidence: true },
  near:  { desc: 340, papers: 12, evidence: true },    // ranks 2–6
  tail:  { desc: 0, papers: 6, evidence: false },      // 7 and down
};
const NEAR_DEPTH = 6;

function briefSession(r, tier) {
  const s = r.session;
  const bits = [`### ${s.title}`];
  const meta = [`${dayShort(s.day)} ${t(s.start)}–${t(s.end)}`, venueLabel(s) || "venue tbc"];
  if (s.code) meta.push(s.code);
  bits.push(meta.join(" · "));
  const desc = tier.desc === Infinity ? s.description : trunc(s.description || "", tier.desc);
  if (tier.desc && desc) bits.push(desc.replace(/\n+/g, " "));
  if (s.papers.length) {
    const shown = tier.papers === Infinity ? s.papers : s.papers.slice(0, tier.papers);
    bits.push(shown.map((p) => `- ${p.title}`).join("\n"));
    if (shown.length < s.papers.length) bits.push(`- …and ${s.papers.length - shown.length} more papers`);
  }
  const ev = tier.evidence && r.evidence?.length ? evidenceText(r) : "";
  if (ev) bits.push(`Matched because: ${ev}`);
  return bits.join("\n");
}

/* The works box, with the papers the tool actually matched on marked as such.
 *
 * The paste is everything the user has ever written; the route may rest on a
 * quarter of it. A one-line disclosure said so and was not enough — the reader
 * still has the full publication list in front of them and no way to tell which
 * half produced the shortlist, which is precisely the question they need to
 * answer to catch a bad pick. The unused titles stay in, marked and reasoned,
 * because "I have a paper on this and the tool ignored it" is a finding.
 *
 * Falls back to the raw paste whenever the parse no longer describes the run —
 * a prose profile, or a box edited since the chart. The stale note is already
 * saying so on screen; the brief must not quietly invent a breakdown for a route
 * that didn't come from these words. */
function briefWorks(works, wp) {
  const head = ["### What I've worked on", ""];
  if (!works) return [...head, "_(left blank)_", ""];
  if (!wp) return [...head, works, ""];
  const items = parseWorks(works).items;
  if (items.length !== wp.total) return [...head, works, ""];

  // Mirrors buildProfile exactly — filter, then the cap — so `used` is the set
  // that was embedded rather than an approximation of it.
  const used = new Set(filterWorks(items, wp).slice(0, WORKS_MAX_TITLES).map((it) => it.title));
  // Same order as filterWorks, so the reason given is the one that did the cut.
  // The fallback is the cap, which is the only other way out of the pool.
  const whyCut = (it) => {
    if (wp.since && it.year && it.year < wp.since) return `before ${wp.since}`;
    if (wp.firstOnly && it.authorFirst === false) return "not first-authored";
    if (wp.excluded?.includes(it.title)) return "I took this one out by hand";
    return `past the tool's ${WORKS_MAX_TITLES}-title cap`;
  };
  const line = (it, why) => `- ${it.title}${it.year ? ` (${it.year})` : ""}${why ? ` — ${why}` : ""}`;
  const cut = items.filter((it) => !used.has(it.title));

  const out = [...head];
  out.push(`_Parsed out of my profile: ${wp.total} papers. The tool matched on `
    + `${used.size} of them${wp.owner ? `, reading me as ${wp.owner}` : ""}. Both lists are here `
    + `because the ones it skipped are still context for you — they just aren't what `
    + `produced the route below._`, "");
  out.push(`**Matched on (${used.size}):**`, "");
  out.push(...items.filter((it) => used.has(it.title)).map((it) => line(it, "")), "");
  if (cut.length) {
    out.push(`**In my profile but not matched on (${cut.length}):**`, "");
    out.push(...cut.map((it) => line(it, whyCut(it))), "");
  }
  return out;
}

// Papers under this carry too little of the route to be worth a line.
const BRIEF_SHARE_MIN = 0.02;

/* Which of those papers the route actually rested on.
 *
 * The panel on the page reports this and the brief did not, which was the wrong
 * way round: the page's reader can see their own agenda and guess, while the
 * model is being asked to audit a route with no idea that one paper out of
 * sixty-seven produced a third of it. Share of the *gap* (best minus runner-up),
 * never share of the argmax — see the works panel for why the two disagree. */
function briefShares(works, wp) {
  if (!wp?.winGap || wp.worksSig !== worksSig(works)) return [];
  const ranked = Object.entries(wp.wins)
    .map(([title, v]) => [title, v.gap / wp.winGap])
    .filter(([, s]) => s >= BRIEF_SHARE_MIN)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [];

  const out = ["### Which of my papers the route rested on", ""];
  out.push(
`The tool scores every session against each of my papers separately and keeps the
best one, so a few papers can end up doing most of the work. These did — roughly,
the share of the route that would change if the paper weren't in the box:`, "");
  out.push(...ranked.map(([t, s]) => `- **${Math.round(100 * s)}%** — ${t}`), "");
  out.push(
`Two things about that list. A large share is not proof a paper is steering me:
several papers on one topic sit within a hair of each other, so one of them takes
the credit while removing it changes nothing, because its neighbour steps up.
And the matching cannot do "not" — if something up there is work I have moved on
from, it will go on pulling those sessions towards me however I word the box
below. Saying so is one of the things you can do and it cannot.`, "");
  return out;
}

function buildBrief() {
  if (!STATE?.agenda) return "";
  const { days, norm } = STATE.agenda;
  const rank = new Map(STATE.results.map((r, i) => [r.session.id, i + 1]));
  const total = STATE.results.length;
  const works = $("#works").value.trim();
  const goals = $("#goals").value.trim();
  const out = [];

  out.push(`# Help me finish my ${DATA.conference} agenda`, "");
  out.push(
`I've run the programme through a matching tool. It embedded all ${DATA.sessions.length} sessions
and everything in them, scored them against the two descriptions of my work
below, and produced the route in part 2. Part 3 is the deeper shortlist: for
every timeslot, the sessions it ranked highest, most of which never made it onto
my screen.

What I want from you is the judgement the tool can't do. It compares text to
text. It doesn't know that I've already spent years on something and want to
move on, that I promised to be somewhere at four, or that two sessions are the
same people twice. You do — or you can ask.

Before you give me a route:

1. Ask me two or three questions, whichever ones would actually change your
   answer. Things worth asking about are usually what I'm trying to get out of
   the week (ideas? collaborators? a job? a break?), what I want to avoid
   despite it matching my past work, and anything fixed in my diary already.
2. Use what you already know about me from our previous conversations — my
   actual research, who I work with, what I've been complaining about, what I
   said I wanted to learn. That is the thing you have and the matching tool
   doesn't. Say when you're using it, so I can correct you.

Then give me one pick per timeslot, in time order, each with a sentence on why
that one. Rules:

- Only use sessions listed below. Don't invent one, and don't reach for a
  session you think ought to exist — if the right thing isn't here, say so.
- Where you disagree with the tool's pick, say so explicitly and say why. Those
  are the interesting ones and I want to see them flagged, not smoothed over.
- The tool's rank is real information — it read every abstract and every paper
  title, which neither of us is going to do — but it is cosine similarity from a
  small model. It cannot do "not this", it cannot do "enough of that already",
  and it has a measured bias towards sessions with many papers: a best-of-nine
  beats a best-of-one before the topic is considered at all, so a short session
  starts low whatever it is about. Treat a high rank as a strong hint and a low
  rank as weak evidence of nothing much — particularly for a session with only
  one or two papers in it.
- The "matches X — from your paper Y" lines are weaker claims than they look.
  Measured on a real profile against this programme: two papers with nothing in
  common score about 0.57, and a *winning* pair scores about 0.67, so a match is
  roughly 1.6 standard deviations above unrelated. It means "nearest thing of
  mine", never "about the same subject". Where a line says **too close to
  separate**, the tool is admitting it could not tell which of my papers matched —
  the top two were within a whisker — so read those as pointing at a region of my
  work rather than at a specific paper.
- That gap is the main thing you can do and it cannot: spotting a match made on a
  framing word rather than a subject. It has no idea that "space" means something
  different in "activity spaces" and "sense of place", or that a paper about
  futures and a paper about sustainability share vocabulary and nothing else. If
  a pick looks like it was matched on a word, say so and replace it.
- Any slot marked **I am presenting in this** is fixed. Don't move me, don't
  suggest an alternative for that hour, and do factor in that I'll be in the room
  before and after.
- If a slot is better spent on a corridor conversation or a sit down, say that
  instead of picking something. A route with a deliberate gap in it is a better
  answer than four mediocre picks in a row.
- Tell me the two or three sessions across the whole week you'd least want me to
  miss, and why those.`, "");

  out.push("---", "", "## 1. Me", "");
  const wp = STATE.worksPick;
  out.push(...briefWorks(works, wp));
  out.push(...briefShares(works, wp));
  out.push("### What I'm working on now, and what I want from the week", "", goals || "_(left blank)_", "");
  const f = STATE.filters;
  out.push(`_Filters I set: days ${[...f.days].sort().join(", ") || "all"}; attendance ${f.mode}._`, "");
  if (instRaw.trim()) {
    out.push(`_I've asked the tool to flag papers from ${instRaw.trim()} — that's where I am, so those`
      + ` are colleagues rather than strangers. A reason to go, not a reason to stay away._`, "");
  }
  const own = DATA.sessions.filter((sx) => mine.has(sx.id));
  if (own.length) {
    out.push(`_I'm presenting in ${own.length === 1 ? "one session" : `${own.length} sessions`}: `
      + `${own.map((sx) => `${sx.title} (${dayShort(sx.day)} ${t(sx.start)})`).join("; ")}.`
      + ` Those hours are spoken for._`, "");
  }

  out.push("---", "", "## 2. The route the tool produced", "");
  for (const [day, slots] of days) {
    out.push(`### ${dayName(day)}`, "");
    for (const slot of slots) {
      const head = `**${t(slot.start)}–${t(slot.end)}** (${slot.parallel} sessions run against each other)`;
      if (slot.weak) {
        out.push(`${head} — nothing scored well here. Tool's best guess: ${slot.pick.session.title}`, "");
        continue;
      }
      if (slot.clashWith) {
        out.push(`${head} — **too close to call**, the tool refused to choose:`);
        out.push(`- ${slot.pick.session.title}`);
        out.push(`- ${slot.clashWith.session.title}`, "");
        continue;
      }
      const why = slot.own ? " — **I am presenting in this**"
        : (slot.pinned ? " — I pinned this one myself" : "");
      out.push(`${head}${why}`);
      out.push(`${slot.pick.session.title} — ranked #${rank.get(slot.pick.session.id)} of ${total} for me`);
      const ev = evidenceText(slot.pick);
      if (ev) out.push(`_${ev}_`);
      out.push("");
    }
  }

  out.push("---", "", "## 3. Everything I could go to instead", "");
  out.push(
`For each timeslot, in the tool's rank order — the top ${SHORTLIST_PER_SLOT} of however many
were running. Deeper down the list you get the title and the papers but not the
abstract: those are there so you can spot one, not so you can read them all. Ask
me and I'll paste the full text of any of them. Socials, receptions and AGMs are
filtered out and aren't here at all.`, "");
  for (const [day, slots] of days) {
    out.push(`### ${dayName(day)}`, "");
    for (const slot of slots) {
      out.push(`#### ${t(slot.start)}–${t(slot.end)}`, "");
      const shortlist = (slot.ranked || []).slice(0, SHORTLIST_PER_SLOT);
      shortlist.forEach((r, i) => {
        const isPick = r === slot.pick;
        const tier = isPick ? TIERS.pick : (i < NEAR_DEPTH ? TIERS.near : TIERS.tail);
        const tag = isPick ? "[TOOL'S PICK] " : (r === slot.clashWith ? "[TOO CLOSE TO CALL] " : "");
        out.push(briefSession(r, tier).replace(/^### /, `### ${tag}`), "");
      });
      if ((slot.ranked || []).length > shortlist.length) {
        out.push(`_(${slot.ranked.length - shortlist.length} lower-ranked sessions in this slot are not listed.)_`, "");
      }
    }
  }
  return out.join("\n");
}

async function copyBrief(btn) {
  const text = buildBrief();
  if (!text) return;
  const hint = $("#llm-hint");
  try {
    await navigator.clipboard.writeText(text);
    hint.textContent = `Copied — ${Math.round(text.length / 1024)} kB. Paste it into Claude, ChatGPT or whatever you use.`;
  } catch {
    // Clipboard needs a secure context and a permission; falling back to a
    // download beats a button that silently does nothing.
    const blob = new Blob([text], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agenda-navigator-brief.md";
    a.click();
    URL.revokeObjectURL(a.href);
    hint.textContent = "Couldn't reach the clipboard, so it downloaded instead — attach the file to your chat.";
  }
  hint.hidden = false;
}

// ---------- now / next ----------

// Only meaningful during the conference itself; the rest of the year the route
// renders without time chips and without stealing the scroll.
function conferenceWindow() {
  const days = DATA.sessions.map((s) => s.day);
  return { first: days.reduce((a, b) => (a < b ? a : b)), last: days.reduce((a, b) => (a > b ? a : b)) };
}

function markNowNext() {
  const { first, last } = conferenceWindow();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  if (today < first || today > last) return null;
  const now = Date.now();
  let target = null;
  for (const el of document.querySelectorAll("#route .slot")) {
    const start = Date.parse(el.dataset.start), end = Date.parse(el.dataset.end);
    // into .slot-body, not .slot — .slot is the time-gutter grid, and a chip
    // dropped straight into it becomes a third column.
    const chip = (cls, text) => {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      (el.querySelector(".slot-body") || el).prepend(span);
    };
    if (start <= now && now < end) {
      el.classList.add("slot-now");
      chip("now-chip", "happening now");
      target = target || el;
    } else if (!target && start > now && el.dataset.start.startsWith(today)) {
      el.classList.add("slot-next");
      chip("now-chip next", "up next");
      target = el;
    }
  }
  return target;
}

// ---------- render ----------

function renderOverview() {
  const top5 = STATE.results.filter((r) => !isAdminSession(r.session)).slice(0, 5);
  const nudge = STATE.weights.goals === 0
    ? `<p class="goals-nudge">This route only looks at your past work. A sentence or two in the
       second box about what you're doing <em>now</em> will usually change it.</p>`
    : "";
  $("#overview").innerHTML = `<div class="overview-card">
    <h3>If you only make five sessions</h3>
    <ol>${top5.map((r) => `<li>${esc(r.session.title)}
      <span class="mono">${dayShort(r.session.day)} ${t(r.session.start)}</span></li>`).join("")}</ol>
    ${nudge}
  </div>`;
}

function renderRoute() {
  const agenda = buildAgenda(STATE.results, STATE);
  STATE.agenda = agenda;
  const { days, norm } = agenda;

  $("#day-tabs").innerHTML = [...days.keys()].map((d) =>
    `<button type="button" data-day="${d}" aria-selected="false">${dayShort(d)}</button>`).join("");
  $("#route").innerHTML = [...days.entries()].map(([day, slots]) => `
    <section class="day-block" id="day-${day}">
      <h3 class="day-heading">${dayName(day)}</h3>
      <div class="route">${slots.map((s) => slotHtml(s, norm)).join("")}</div>
    </section>`).join("");

  $("#day-tabs").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      document.getElementById(`day-${b.dataset.day}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#day-tabs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b));
    });
  });
  return markNowNext();
}

/* Does the route on screen still describe the controls above it?
 *
 * Nothing on this page re-charts on its own — the button is the one thing that
 * commits, and that is deliberate, because re-embedding a profile costs ten
 * seconds and nobody wants it to happen while they type. What was missing is the
 * other half of that bargain: until this existed, unticking a paper or changing
 * the year updated the panel, changed nothing else, and said nothing, so a route
 * could sit under controls it had never seen. The LLM brief made it worse rather
 * than visible — it is built from STATE.worksPick, so it went on faithfully
 * describing the previous run's filters while the boxes on screen said otherwise,
 * which reads as the brief ignoring the filters rather than the route being old.
 *
 * Days and mode count too: they are read at scoring time, so changing them after
 * a chart is the same silent no-op. */
function routeIsStale() {
  if (!STATE) return false;
  const sig = profileSig($("#works").value.trim(), $("#goals").value.trim(), worksFilter);
  if (sig !== STATE.profileSig) return true;
  if (document.querySelector('input[name="mode"]:checked').value !== STATE.filters.mode) return true;
  const days = [...document.querySelectorAll('input[name="day"]:checked')].map((i) => i.value);
  return days.length !== STATE.filters.days.size || days.some((d) => !STATE.filters.days.has(d));
}

function refreshStale() {
  const el = $("#stale-note");
  if (el) el.hidden = !routeIsStale();
}

function renderAll({ restored = false, scroll = false } = {}) {
  const nowSlot = renderRoute();
  renderOverview();
  $("#papers").innerHTML = papersHtml(STATE.papers, routedSessionIds(STATE.agenda.days));
  $("#people").innerHTML = peopleHtml(STATE.people);
  $("#lookup-out").innerHTML = lookupHtml($("#lookup-input").value || "");

  const note = $("#restored-note");
  if (restored && STATE.chartedAt) {
    note.textContent = `route from ${fmtStamp.format(new Date(STATE.chartedAt))} — edit your profile and re-chart any time`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  $("#results").hidden = false;
  refreshStale();
  refreshInstNote();   // needs DATA, which only exists once a route has been charted
  if (nowSlot) nowSlot.scrollIntoView({ behavior: "smooth", block: "center" });
  else if (scroll) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function saveMine() {
  try { localStorage.setItem(MINE_KEY, JSON.stringify([...mine])); } catch { /* flags are not worth failing over */ }
}

/* Marking a session touches the route (it gets promoted), the papers tab and the
 * lookup pane at once, and the toggle exists in two of those three — so both
 * call sites go through here rather than each re-rendering what it happens to
 * be looking at. */
function afterFlagChange() {
  if (!STATE) return;
  renderRoute();
  $("#papers").innerHTML = papersHtml(STATE.papers, routedSessionIds(STATE.agenda.days));
  $("#lookup-out").innerHTML = lookupHtml($("#lookup-input").value || "");
  saveRoute();
}

// pins, dismissals and restores re-rank instantly from the scores in memory —
// no re-embedding, so no waiting.
$("#route").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !STATE) return;
  const { act, id, slot } = btn.dataset;
  const sid = Number(id);
  if (act === "pin") { STATE.choices.set(slot, sid); STATE.dismissed.delete(sid); }
  else if (act === "unpin") STATE.choices.delete(slot);
  else if (act === "dismiss") {
    STATE.dismissed.add(sid);
    if (STATE.choices.get(slot) === sid) STATE.choices.delete(slot);
  } else if (act === "restore") {
    for (const r of STATE.results) {
      if (slotKey(r.session) === slot) STATE.dismissed.delete(r.session.id);
    }
  } else if (act === "mine" || act === "unmine") {
    if (act === "mine") mine.add(sid); else mine.delete(sid);
    saveMine();
  }
  afterFlagChange();
});

// The lookup pane is the only route to a session the day filters excluded, which
// is the one place "when is my own talk?" has to keep working.
$("#lookup-out").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !STATE) return;
  const { act } = btn.dataset;
  if (act !== "mine" && act !== "unmine") return;
  if (act === "mine") mine.add(Number(btn.dataset.id)); else mine.delete(Number(btn.dataset.id));
  saveMine();
  afterFlagChange();
});

// ---------- tabs ----------

$("#view-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  $("#view-tabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === btn));
  document.querySelectorAll("#results .view").forEach((v) => { v.hidden = v.id !== `view-${btn.dataset.view}`; });
  if (btn.dataset.view === "lookup") $("#lookup-input").focus();
});

let lookupTimer = null;
$("#lookup-input").addEventListener("input", () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(() => {
    if (STATE?.agenda) $("#lookup-out").innerHTML = lookupHtml($("#lookup-input").value);
  }, 150);
});

// ---------- main flow ----------

function setStatus(msg) { statusEl.textContent = msg; }

/* The year list is the profile's own years — no invented granularity — and the
 * count beside each one is the whole point of the control: you are choosing how
 * much of your back catalogue still counts as you, and you can see the price. */
function syncWorksFilters(items, owner) {
  // A new paste retires the old exclusions. They are matched by title, so a
  // stale one is inert rather than wrong — but it would still sit in the
  // profile signature and quietly stop a saved route restoring.
  if (worksFilter.excluded.length) {
    const live = new Set(items.map((it) => it.title));
    worksFilter.excluded = worksFilter.excluded.filter((t) => live.has(t));
  }
  const sel = $("#works-since");
  const years = [...new Set(items.map((i) => i.year).filter(Boolean))].sort((a, b) => b - a);
  if (worksFilter.since && !years.includes(worksFilter.since)) worksFilter.since = null;
  sel.innerHTML = ['<option value="">any year</option>'].concat(years.map((y) =>
    `<option value="${y}">${y} onwards (${filterWorks(items, { ...worksFilter, since: y }).length})</option>`
  )).join("");
  sel.value = worksFilter.since ?? "";

  const wrap = $("#works-first-wrap");
  // No owner means the paste doesn't look like one person's profile, so the
  // control would be marking papers against a name we guessed. Hide it rather
  // than offer a filter that can't be trusted.
  if (!owner) { worksFilter.firstOnly = false; wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#works-first").checked = worksFilter.firstOnly;
  // Naming who it decided you are is the check on the guess: a wrong name is
  // obvious to you and invisible to everything else here.
  $("#works-first-note").textContent =
    `(read as ${owner.name} — ${items.filter((i) => i.authorFirst === true).length} of ${items.length})`;
}

// Render state that has to survive the note being rebuilt in place.
let listedItems = [];
let lastParsed = null;
let detailsWasOpen = false;

/* The one part of the note that a tick changes. Ticking a box must not rebuild
 * the list: that detaches the row under the cursor, drops keyboard focus and
 * resets the scroll, and unticking four papers in a row is exactly the flow
 * this exists for. The concentration line is deliberately *not* updated either
 * — it describes the last route, which unticking a paper doesn't retroactively
 * change. It refreshes when you chart again, which is the point at which it
 * becomes true again. */
function worksCountHtml() {
  if (!lastParsed) return "";
  const kept = filterWorks(lastParsed.items, worksFilter);
  const used = kept.slice(0, WORKS_MAX_TITLES);
  const dropped = kept.length - used.length;
  return (kept.length !== lastParsed.items.length ? ` Matching on <strong>${kept.length}</strong> of them.` : "")
    + (dropped ? ` Newest ${WORKS_MAX_TITLES} used, ${dropped} older dropped.` : "")
    + (used.length ? "" : ` <strong>Nothing left to match on</strong> — widen the year, or tick some back in.`);
}

// Live feedback on the works box. Cleanup is heuristic, so show what was read
// rather than asking the user to trust it.
function refreshWorksNote() {
  const el = $("#works-note");
  const controls = $("#works-filters");
  const raw = $("#works").value;
  if (!raw.trim()) { el.hidden = true; controls.hidden = true; $("#works-list").innerHTML = ""; return; }
  const parsed = parseWorks(raw);
  const { kind, items, owner } = parsed;
  lastParsed = kind === "works" ? parsed : null;
  el.hidden = false;
  if (kind !== "works") {
    controls.hidden = true;
    $("#works-list").innerHTML = "";
    el.innerHTML = "Read as free text. Paste a Google Scholar profile and it'll be cleaned to titles automatically.";
    return;
  }
  controls.hidden = false;
  syncWorksFilters(items, owner);
  /* Prefill the institution box from the profile card, but only into an empty
   * box — it is the user's field the moment they touch it, and a paste that
   * re-parses must not overwrite what they corrected. */
  const inst = $("#works-inst");
  if (inst && !instRaw && parsed.institution) {
    instRaw = [parsed.institution.name, parsed.institution.domain].filter(Boolean).join(", ");
    inst.value = instRaw;
    INST = instNeedles(instRaw);
    try { localStorage.setItem(INST_KEY, instRaw); } catch { /* fine */ }
    refreshInstNote();
  }

  /* The list shows what the two controls left, with the exclusions as unticked
   * boxes rather than as absences — an excluded paper has to stay on screen or
   * there is no way to put it back. `kept` (exclusions applied) is what actually
   * gets matched, and is the number reported. */
  const byControls = filterWorks(items, { ...worksFilter, excluded: [] });
  listedItems = byControls.slice(0, WORKS_MAX_TITLES);
  const years = items.map((i) => i.year).filter(Boolean);
  const span = years.length ? ` spanning ${Math.min(...years)}–${Math.max(...years)}` : "";

  // Shares from the last chart, if it was this same paste. Keyed to the works
  // text so unticking a paper doesn't wipe the very numbers you're acting on.
  const wp = STATE?.worksPick;
  // .trim() to match plan(), which signs the trimmed box — a trailing newline
  // in the paste would otherwise hide the shares on every chart.
  const wins = wp && wp.worksSig === worksSig(raw.trim()) && wp.winGap ? wp : null;
  /* Share of the *gap*, not share of the argmax. A paper that wins a fifth of
   * the programme by a whisker over its own near-twin is not driving anything —
   * untick it and the twin takes over — and reporting the argmax count invites
   * exactly that wasted click. The gap share answers the question the user is
   * actually asking: how much of this agenda would go away if this paper
   * weren't in the box. */
  const share = (t) => (wins ? (100 * (wins.wins[t]?.gap ?? 0)) / wins.winGap : 0);
  const out = new Set(worksFilter.excluded);
  const list = listedItems.map((i, n) => {
    const pc = share(i.title);
    const gone = out.has(i.title);
    return `<li><label class="${gone ? "out" : ""}"><input type="checkbox" data-i="${n}"${gone ? "" : " checked"}> `
      + `${esc(i.title)}${i.year ? ` <span class="mono">${i.year}</span>` : ""}`
      + `${i.authorFirst === true ? ' <span class="mono">led</span>' : ""}`
      + `${pc >= 1 ? ` <span class="mono share">${Math.round(pc)}%</span>` : ""}</label></li>`;
  }).join("");

  /* The headline is the whole point of the panel: it makes the max-over-titles
   * visible. Ranked by share, three names, and the number they add up to. */
  let concentration = "";
  if (wins) {
    const top = Object.entries(wins.wins)
      .sort((a, b) => b[1].gap - a[1].gap).slice(0, 3);
    const sum = top.reduce((a, [, v]) => a + v.gap, 0);
    // Only worth saying when it is true: three of sixty-seven papers carrying a
    // sixth of the agenda is a finding, three carrying 4% is just arithmetic.
    if (top.length >= 3 && sum / wins.winGap >= 0.15) {
      concentration = `<span class="concentration">Your last route rested on a few of these: `
        + `<strong>${top.map(([t]) => `${esc(t.slice(0, 46))}${t.length > 46 ? "…" : ""}`).join("</strong>, <strong>")}</strong> `
        + `carried <strong>${Math.round(100 * sum / wins.winGap)}%</strong> of it between them. `
        + `Untick anything that isn't you any more.</span>`;
    }
  }

  el.innerHTML = `Cleaned to <strong>${items.length} title${items.length === 1 ? "" : "s"}</strong>${span} —
    authors, journals and citation counts stripped.<span id="works-count">${worksCountHtml()}</span>`
    + concentration;

  /* The list lives below the two controls rather than inside the note, so the
   * panel reads in the order you use it: what was read, how to narrow it, then
   * the titles themselves. Inside the note, an open list pushed the controls a
   * screen down from the sentence they belong to. */
  $("#works-list").innerHTML = listedItems.length
    ? `<details${detailsWasOpen ? " open" : ""}><summary>Check what was read, and untick anything that isn't you`
      + `</summary><ol class="parsed-list">${list}</ol></details>`
    : "";

  // The year and first-author controls do rebuild the list, so the open state
  // has to be carried across by hand.
  const det = $("#works-list").querySelector("details");
  if (det) det.addEventListener("toggle", () => { detailsWasOpen = det.open; });
}

// One message per way this actually fails. "Something went wrong" was covering
// for offline, a CDN outage and a scoring bug alike, which helps nobody.
function failureMessage(stage, err) {
  if (err instanceof NoProgrammeData) {
    return "no programme data in docs/data/ — this is the kit, not a conference. "
      + "Run pipeline/fetch.py, normalize.py and embed.py, or see PORTING.md.";
  }
  // Its own message names both order signatures and the fix; the generic
  // "couldn't load the programme data — refresh" would send a porter the wrong way.
  if (err instanceof DataInconsistent) return err.message;
  if (!navigator.onLine) return "you're offline — the model can't load until you're back on a network.";
  if (stage === "data") return "couldn't load the programme data — refresh and try again.";
  if (stage === "model") return "couldn't load the language model (CDN hiccup?) — refresh and try again.";
  return "something went wrong while matching — refresh and try again. If it repeats, file an issue.";
}

async function plan() {
  const worksRaw = $("#works").value.trim();
  const goalsRaw = $("#goals").value.trim();
  if (worksRaw.length + goalsRaw.length < 30) {
    setStatus("tell us a bit more — paste a profile, or a few sentences about your plans.");
    return;
  }
  const days = new Set([...document.querySelectorAll('input[name="day"]:checked')].map((i) => i.value));
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (!days.size) { setStatus("pick at least one day."); return; }

  /* Before the model, not after: parseWorks is string work and costs nothing,
   * and finding out that the filters left no papers is worth knowing before a
   * 10-second embed rather than after one. */
  const profile = buildProfile(worksRaw, goalsRaw, worksFilter);
  if (profile.parsed.kind === "works" && profile.parsed.items.length && !profile.works.chunks.length) {
    setStatus("no papers left to match on — widen the year, or tick some back in below the box.");
    return;
  }

  const btn = $("#plan-btn");
  btn.disabled = true;
  document.body.classList.add("working");
  let stage = "data";
  try {
    await loadData();
    stage = "model";
    const embed = await loadEmbedder();
    stage = "matching";
    const noun = profile.parsed.kind === "works" ? "papers" : "profile";
    const nWorks = profile.works.chunks.length;
    setStatus(`reading your ${noun}…`);
    // Sequential, not Promise.all: one transformers.js pipeline, one call at a time.
    profile.works.vecs = await embedBatched(embed, profile.works.chunks,
      (n) => setStatus(`reading your ${noun}… ${n} of ${nWorks}`));
    if (profile.goals.chunks.length) setStatus("reading your aims…");
    profile.goals.vecs = await embedBatched(embed, profile.goals.chunks, () => {});
    setStatus("charting the route…");
    await new Promise((r) => setTimeout(r, 30)); // let status paint
    const { results, papers, people, worksWins, winFacets, winGap } = scoreSessions(profile, { days, mode });
    if (!results.length) { setStatus("no sessions match those filters."); return; }
    STATE = {
      results, papers, people,
      weights: profile.weights,
      filters: { days, mode },
      choices: new Map(),
      dismissed: new Set(),
      chartedAt: new Date().toISOString(),
      // What the works box actually contributed, kept so the brief can say so
      // even on a route restored tomorrow morning.
      worksPick: profile.parsed.kind === "works"
        ? {
          ...worksFilter,
          used: profile.works.chunks.length,
          total: profile.parsed.items.length,
          owner: profile.parsed.owner?.name ?? null,
          // For the concentration line, which has to outlive this chart —
          // you read it, untick a paper, and chart again.
          wins: worksWins,
          winFacets,
          winGap,
          worksSig: worksSig(worksRaw),
        }
        : null,
      profileSig: profileSig(worksRaw, goalsRaw, worksFilter),
      device: EMB_DEVICE,
    };
    renderAll({ scroll: true });
    saveRoute();
    // The per-paper shares only exist once a route does, so the panel that
    // reports them is a step behind the button unless it's told.
    refreshWorksNote();
    const fraglet = buildFraglet(worksRaw, goalsRaw, [...days], mode, worksFilter);
    localStorage.setItem(FRAGLET_KEY, JSON.stringify(fraglet));
    $("#save-fraglet").hidden = false;
    $("#fraglet-hint").hidden = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(failureMessage(stage, err));
  } finally {
    btn.disabled = false;
    document.body.classList.remove("working");
  }
}

function downloadFraglet() {
  const raw = localStorage.getItem(FRAGLET_KEY);
  if (!raw) return;
  const blob = new Blob([JSON.stringify(JSON.parse(raw), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rgs2026-interests.fraglet.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#plan-btn").addEventListener("click", plan);
$("#save-fraglet").addEventListener("click", downloadFraglet);
$("#ics-btn").addEventListener("click", downloadIcs);
$("#llm-btn").addEventListener("click", (e) => copyBrief(e.currentTarget));

/* The count is the whole safety mechanism, the same way detectOwner prints the
 * name it inferred: "UCL" and "University College London" catch different halves
 * of this programme's spellings (90 papers against 113), and a value that catches
 * nothing is indistinguishable from a value that works until you are told. It can
 * only count once a chart has loaded the programme, so before that it says
 * nothing rather than something wrong. */
function refreshInstNote() {
  const el = $("#works-inst-note");
  if (!el) return;
  if (!INST.length || !DATA?.sessions) { el.textContent = ""; return; }
  let sess = 0, papers = 0;
  for (const sx of DATA.sessions) {
    const h = instHits(sx);
    if (h.n) { sess++; papers += h.n; }
  }
  el.textContent = sess
    ? `(${papers} paper${papers === 1 ? "" : "s"} in ${sess} session${sess === 1 ? "" : "s"})`
    : "(nothing in the programme matches that)";
}

let instTimer = null;
$("#works-inst").addEventListener("input", (e) => {
  instRaw = e.target.value;
  INST = instNeedles(instRaw);
  try { localStorage.setItem(INST_KEY, instRaw); } catch { /* fine */ }
  clearTimeout(instTimer);
  // Debounced: every keystroke otherwise redraws nineteen slots mid-word.
  instTimer = setTimeout(() => { refreshInstNote(); afterFlagChange(); }, 300);
});

let noteTimer = null;
$("#works").addEventListener("input", () => {
  clearTimeout(noteTimer);
  // refreshWorksNote prunes exclusions whose title no longer parses out of the
  // box, which moves the signature — so staleness is re-read after it, not before.
  noteTimer = setTimeout(() => { refreshWorksNote(); refreshStale(); }, 250);
});

/* One delegated pair for every control in the panel — textareas, the year select,
 * both kinds of checkbox, the mode radios. Cheaper to read than five call sites
 * kept in step, and it cannot miss a control added later. Bubbling puts it after
 * the specific handlers, so worksFilter is already updated when this runs. */
$("#profile-panel").addEventListener("input", refreshStale);
$("#profile-panel").addEventListener("change", refreshStale);

// Both controls re-render the note (counts, the "led" tags, each other's
// option labels) and nothing else. Changing one does not re-chart: the works
// box behaves the same way, and the button stays the one thing that commits.
$("#works-since").addEventListener("change", (e) => {
  worksFilter.since = e.target.value ? Number(e.target.value) : null;
  refreshWorksNote();
});
$("#works-first").addEventListener("change", (e) => {
  worksFilter.firstOnly = e.target.checked;
  refreshWorksNote();
});

// Delegated, because the list is rebuilt whenever the other two controls move.
$("#works-list").addEventListener("change", (e) => {
  const cb = e.target;
  if (!cb.matches("input[type=checkbox][data-i]")) return;
  const it = listedItems[Number(cb.dataset.i)];
  if (!it) return;
  const out = new Set(worksFilter.excluded);
  if (cb.checked) out.delete(it.title); else out.add(it.title);
  worksFilter.excluded = [...out];
  // In place, not a re-render — see worksCountHtml.
  cb.closest("label")?.classList.toggle("out", !cb.checked);
  $("#works-count").innerHTML = worksCountHtml();
});

/* Both flags load before the saved route renders: the route promotes sessions
 * the user is presenting in, so reading them afterwards would draw one agenda
 * and then silently replace it. */
try {
  mine = new Set(JSON.parse(localStorage.getItem(MINE_KEY) || "[]").map(Number).filter(Number.isFinite));
} catch { mine = new Set(); }
try {
  instRaw = localStorage.getItem(INST_KEY) || "";
  INST = instNeedles(instRaw);
  if (instRaw) $("#works-inst").value = instRaw;
} catch { instRaw = ""; INST = []; }

// restore a previous profile
try {
  const saved = JSON.parse(localStorage.getItem(FRAGLET_KEY) || "null");
  if (saved) {
    // pre-two-box profiles only have `detail`; it was whatever they pasted, so
    // it belongs in the works box.
    $("#works").value = saved.works ?? saved.detail ?? "";
    $("#goals").value = saved.goals ?? "";
    worksFilter = { ...WORKS_FILTER_NONE, ...(saved.worksFilter || {}) };
    if (saved.works || saved.goals || saved.detail) {
      $("#save-fraglet").hidden = false;
      $("#fraglet-hint").hidden = false;
      refreshWorksNote();
    }
  }
} catch { /* ignore corrupt state */ }

// warm the data and model caches in the background so "Chart my route" is
// instant by the time the user has finished typing; errors here are ignored —
// plan() retries with visible status if anything failed. The route from last
// time renders as soon as the data is in, before the model even starts.
loadData()
  .then(() => { setStatus(""); restoreRoute(); return loadEmbedder(); })
  .then(() => setStatus(""))
  // ...with one exception: a missing docs/data/ is not a transient failure that
  // retrying will fix, and saying so on load beats letting someone fill in the
  // boxes first and find out afterwards.
  .catch((e) => setStatus(e instanceof NoProgrammeData || e instanceof DataInconsistent ? failureMessage(null, e) : ""));

// Offline support: cache the shell and data so the route opens on venue wifi
// (or none). The model is already cached by transformers.js itself.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* http, old browser — fine */ });
}
