/* Traverse — client-side agenda builder for RGS-IBG 2026.
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
const ROUTE_KEY = "traverse.rgs2026.route.v1";

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

async function fetchData() {
  setStatus("loading programme…");
  const [meta, sessionsDoc, facets, binBuf] = await Promise.all([
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/sessions.json").then((r) => r.json()),
    fetch("data/facets.json").then((r) => r.json()),
    fetch("data/embeddings.bin").then((r) => r.arrayBuffer()),
  ]);
  const matrix = f16ToF32(new Uint16Array(binBuf));
  const byId = new Map(sessionsDoc.sessions.map((s) => [s.id, s]));
  DATA = { sessions: sessionsDoc.sessions, facets, matrix, dim: meta.dim, meta, byId };
  const n = $("#n-sessions");
  if (n) n.textContent = DATA.sessions.length;
  return DATA;
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

// Which backend actually built the vectors. fp16-on-GPU and q8-on-wasm agree
// to ~2 decimal places, not exactly, so cached vectors must never cross over.
let EMB_DEVICE = "wasm-q8";

async function buildEmbedder() {
  setStatus("loading language model (~30 MB, first visit only)…");
  const { pipeline } = await import(TRANSFORMERS_CDN);
  const progress_callback = (p) => {
    if (p.status === "progress" && p.file?.endsWith(".onnx")) {
      setStatus(`loading language model… ${Math.round(p.progress || 0)}%`);
    }
  };
  let fe = null;
  // WebGPU embeds the same profile in ~1s instead of ~10s where the browser
  // supports it. Failures here are common (no adapter, driver quirks) and
  // fine — the wasm path below is the one that always works.
  if (navigator.gpu) {
    try {
      fe = await pipeline("feature-extraction", EMBED_MODEL, {
        device: "webgpu", dtype: "fp16", progress_callback,
      });
      EMB_DEVICE = "webgpu-fp16";
    } catch { fe = null; }
  }
  if (!fe) {
    fe = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", progress_callback });
    EMB_DEVICE = "wasm-q8";
  }
  return async (texts, kind) => {
    const prefix = kind === "query" ? DATA.meta.query_prefix : "";
    const out = await fe(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    const [n, d] = out.dims;
    const flat = out.data;
    return Array.from({ length: n }, (_, i) => new Float32Array(flat.slice(i * d, (i + 1) * d)));
  };
}

// ---------- embedding cache ----------

/* Embeddings are deterministic, so a title only ever needs embedding once per
 * model+device. Keyed by the raw text (titles are short; collisions impossible),
 * vectors stored as base64 float32 (~2 KB each). This is what makes editing the
 * goals box cheap: a re-plan re-embeds one sentence, not 67 titles. */
const EMB_CACHE_MAX = 400;

function embCacheKey() { return `traverse.embcache.${EMBED_MODEL}.${EMB_DEVICE}.${dataSig()}`; }

function b64FromVec(v) {
  const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function vecFromB64(b) {
  const s = atob(b);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
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
  texts.forEach((t, i) => {
    if (cache[t]) vecs[i] = vecFromB64(cache[t].v);
    else missing.push(i);
  });
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

function buildProfile(worksRaw, goalsRaw) {
  const parsed = parseWorks(worksRaw);
  const worksChunks = parsed.kind === "works"
    ? parsed.items.slice(0, WORKS_MAX_TITLES).map((it) => it.title)
    : chunkText(worksRaw, 420, WORKS_MAX_PROSE);
  const goalsChunks = chunkText(goalsRaw, 420, GOALS_MAX_CHUNKS);
  return {
    parsed,
    works: { chunks: worksChunks, quoteLabel: parsed.kind === "works" ? "your paper" : "your profile" },
    goals: { chunks: goalsChunks, quoteLabel: "your aims" },
    weights: sourceWeights(worksChunks, goalsChunks, goalsRaw),
  };
}

function buildFraglet(worksRaw, goalsRaw, days, mode) {
  const brief = (goalsRaw || worksRaw).replace(/\s+/g, " ").slice(0, 160);
  return {
    title: "RGS-IBG 2026 conference interests",
    brief,
    detail: [worksRaw, goalsRaw].filter(Boolean).join("\n\n"),
    works: worksRaw,
    goals: goalsRaw,
    category: "interests",
    domain: "conference",
    tags: ["rgs-ibg-2026", `mode:${mode}`, ...days.map((d) => `day:${d}`)],
    visibility: "private",
    created_at: new Date().toISOString(),
    source: "traverse",
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
      from.push({
        label: src.quoteLabel,
        chunk: src.chunks[src.best.which[f]],
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
// box only holds one line and the quote would be noise.
function creditHtml(c) {
  return c.sole ? esc(c.label) : `${esc(c.label)} <span class="q">“${esc(trunc(c.chunk, 80))}”</span>`;
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
const TOP_PAPERS = 10;
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
 * Ex Ordo publishes no author names, only presenting affiliations, so "people"
 * here means institutions and research groups, and the copy says so. Institutions
 * are ranked by how many of their papers land in the top decile of the paper-facet
 * distribution (a percentile, not an absolute cosine — same rule as everywhere),
 * tiebroken by their best paper. Groups are ranked like sessions are: mean of the
 * top 3 session scores, so a group with three good sessions beats one great
 * outlier plus filler. Session references are ids, not objects, so this survives
 * a localStorage round-trip unchanged. */
const TOP_INSTITUTIONS = 12;
const TOP_GROUPS = 8;

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
      let rec = inst.get(aff);
      if (!rec) inst.set(aff, rec = { name: aff, strong: 0, best: pf.score, papers: [] });
      if (pf.score >= strong) rec.strong++;
      if (rec.papers.length < 3) rec.papers.push({ label: pf.label, id: sessions[pf.si].id });
    }
  }
  const institutions = [...inst.values()]
    .filter((r) => r.strong > 0)
    .sort((a, b) => b.strong - a.strong || b.best - a.best)
    .slice(0, TOP_INSTITUTIONS)
    .map(({ name, strong, papers }) => ({ name, strong, papers }));

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

// Best similarity + winning chunk per facet, for one source pool.
function bestPerFacet(vecs) {
  const { facets, matrix, dim } = DATA;
  const sim = new Float32Array(facets.length);
  const which = new Int16Array(facets.length).fill(-1);
  for (let q = 0; q < vecs.length; q++) {
    const qv = vecs[q];
    for (let f = 0; f < facets.length; f++) {
      let dot = 0;
      const off = f * dim;
      for (let k = 0; k < dim; k++) dot += matrix[off + k] * qv[k];
      if (dot > sim[f]) { sim[f] = dot; which[f] = q; }
    }
  }
  return { sim, which };
}

function scoreSessions(profile, filters) {
  const { sessions, facets } = DATA;
  const nFacets = facets.length;
  const w = profile.weights;
  const W = { ...profile.works, best: bestPerFacet(profile.works.vecs) };
  const G = { ...profile.goals, best: bestPerFacet(profile.goals.vecs) };
  W.rank = toRanks(W.best.sim);
  G.rank = toRanks(G.best.sim);

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

  results.sort((a, b) => b.score - a.score);
  // Papers and people respect the day/mode filters for the same reason the route
  // does: there is no point being shown the perfect paper on a day you aren't here.
  return {
    results,
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
const ADMIN_TITLE = /\b(social|reception|drinks|welcome|placeholder|place ?holder|business meeting|agm|prize|awards)\b/i;
function isAdminSession(s) {
  return s.papers.length === 0 && (s.description.length < 200 || ADMIN_TITLE.test(s.title));
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
  const prepared = [...slots.entries()].sort().map(([key, list]) => {
    const [day] = key.split("|");
    list.sort((a, b) => b.score - a.score);
    const live = list.filter((r) => !dismissed.has(r.session.id));
    const substantive = live.filter((r) => !isAdminSession(r.session));
    const ranked = substantive.length ? substantive : (live.length ? live : list);
    // A pin is the user overruling the ranking; it also overrules "weak".
    const pinnedId = choices.get(key);
    const pinned = pinnedId != null ? list.find((r) => r.session.id === pinnedId) : null;
    const weak = !pinned && (norm(ranked[0].score) < WEAK_REL || !substantive.length);
    // Infinity, not 0, for a one-session slot: no runner-up means no contest, and it
    // must not count as the closest call of the day.
    const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : Infinity;
    return { key, day, list, ranked, pinned, weak, gap, hidden: list.length - live.length };
  });

  // Second pass: "closest" only means something once every gap is known. Measure
  // over the real decisions — weak slots aren't ones you're choosing in, and a
  // pinned slot has already been decided.
  const gaps = prepared.filter((p) => !p.weak && !p.pinned && p.gap < Infinity).map((p) => p.gap);
  const clashMax = gaps.length >= CLASH_MIN_SLOTS ? percentile(gaps, CLASH_PCTL) : -Infinity;

  const days = new Map();
  for (const p of prepared) {
    const clash = !p.pinned && !p.weak && p.gap <= clashMax;
    const top = p.pinned || p.ranked[0];
    const rest = p.ranked.filter((r) => r !== top);
    const slot = {
      key: p.key,
      start: top.session.start,
      end: top.session.end,
      parallel: p.list.length,
      pick: top,
      pinned: !!p.pinned,
      clashWith: clash ? rest[0] : null,
      alternatives: rest.slice(clash ? 1 : 0, clash ? 4 : 3),
      weak: p.weak,
      hidden: p.hidden,
      relStrength: norm(top.score),
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
const slimCredit = ({ label, chunk, sole }) => ({ label, chunk, sole });

function saveRoute() {
  if (!STATE) return;
  const slim = {
    dataSig: dataSig(),
    chartedAt: STATE.chartedAt,
    filters: { days: [...STATE.filters.days], mode: STATE.filters.mode },
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
    choices: new Map(Object.entries(saved.choices || {}).map(([k, v]) => [k, Number(v)])),
    dismissed: new Set(saved.dismissed || []),
    chartedAt: saved.chartedAt,
  };
  renderAll({ restored: true });
  return true;
}

// ---------- rendering ----------

const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
const fmtStamp = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const t = (iso) => fmtTime.format(new Date(iso));
const dayName = (d) => fmtDay.format(new Date(d + "T12:00:00Z"));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function evidenceHtml(ev) {
  if (!ev.length) return "";
  const seen = new Set();
  const items = ev.map((e) => {
    const what = e.kind === "paper" ? `paper “${esc(trunc(e.label, 90))}”` : "the session theme";
    const parts = [];
    for (const f of e.from) {
      const key = `${f.label}|${f.chunk}`;
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

/* Ex Ordo names 456 of the 623 rooms "In-person 10" and the like, so printing the
 * room and then the mode gives you "In-person 10 · in person" on most of the
 * programme. If the room name already says it, don't say it again. */
function metaBits(s) {
  const modeLabel = { "in-person": "in person", hybrid: "hybrid", online: "online", unspecified: "" }[s.mode];
  const venue = s.venue || "venue tbc";
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

function controlsHtml(r, slot, role) {
  const id = r.session.id;
  if (role === "alt") {
    return `<button type="button" class="mini" data-act="pin" data-id="${id}" data-slot="${esc(slot.key)}">Make this my pick</button>`;
  }
  if (role === "clash") {
    return `<button type="button" class="mini" data-act="pin" data-id="${id}" data-slot="${esc(slot.key)}">Go with this one</button>`;
  }
  if (slot.pinned) {
    return `<span class="pin-chip mono">your pick</span>
      <button type="button" class="mini" data-act="unpin" data-id="${id}" data-slot="${esc(slot.key)}">Unpin</button>`;
  }
  return `<button type="button" class="mini" data-act="dismiss" data-id="${id}" data-slot="${esc(slot.key)}">Not this one</button>`;
}

function pickHtml(r, norm, { clash = false, slot = null, role = "pick" } = {}) {
  const s = r.session;
  const controls = slot ? `<div class="pick-controls">${controlsHtml(r, slot, role)}</div>` : "";
  return `<article class="pick${clash ? " clash-a" : ""}">
    ${r.dual ? `<span class="dual-flag">matches your work and your aims</span>` : ""}
    <h4>${esc(s.title)}</h4>
    <span class="meta mono">${metaBits(s).map(esc).join(" · ")}</span>
    <div class="match-bar" role="img" aria-label="match strength ${Math.round(norm(r.score) * 100)} of 100"><span style="width:${Math.round(norm(r.score) * 100)}%"></span></div>
    ${evidenceHtml(r.evidence)}
    ${contentsHtml(s)}
    ${controls}
  </article>`;
}

function slotHtml(slot, norm) {
  const time = `<div class="slot-time mono">${t(slot.start)}–${t(slot.end)} · ${slot.parallel} parallel option${slot.parallel === 1 ? "" : "s"}</div>`;
  const restore = slot.hidden
    ? `<div class="hidden-note">${slot.hidden} hidden
        <button type="button" class="mini" data-act="restore" data-slot="${esc(slot.key)}">restore</button></div>`
    : "";
  if (slot.weak) {
    return `<div class="slot" data-start="${slot.start}" data-end="${slot.end}"><div class="weak-slot">${time}
      Nothing here matches you well — nearest is <span class="pick-inline">${esc(slot.pick.session.title)}</span>
      (${esc(slot.pick.session.venue || "venue tbc")}). Take the break.</div>${restore}</div>`;
  }
  let body;
  if (slot.clashWith) {
    body = `<span class="clash-flag">Close call</span>
      <p class="clash-note">These two are effectively tied for you. Read both, pick one:</p>
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
  return `<div class="slot" data-start="${slot.start}" data-end="${slot.end}">${time}${body}${alts}${restore}</div>`;
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
      <div class="paper-where mono">${dayName(p.session.day).split(",")[0]} ${t(p.session.start)} ·
        ${esc(p.session.title)}${p.session.venue ? ` · ${esc(p.session.venue)}` : ""}</div>
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
    <span class="mono">${dayName(s.day).split(",")[0]} ${t(s.start)}${s.venue ? ` · ${esc(s.venue)}` : ""}</span>
  </div>`;
}

function peopleHtml(people) {
  const inst = people.institutions.length
    ? `<div class="people-card">
        <h3>Institutions doing work near yours</h3>
        <p class="hint">The programme doesn't publish author names, only presenting
        affiliations — so this is as close to "people" as the public data gets. Ranked by how
        many of their papers land in the top tenth of your matches.</p>
        <ol class="inst-list">${people.institutions.map((r) => `
          <li>
            <div class="inst-head"><strong>${esc(r.name)}</strong>
              <span class="mono">${r.strong} close paper${r.strong === 1 ? "" : "s"}</span></div>
            <ul class="inst-papers">${r.papers.map((p) => {
              const s = DATA.byId.get(p.id);
              return `<li>${esc(p.label)}${s ? ` <span class="mono">${dayName(s.day).split(",")[0]} ${t(s.start)}</span>` : ""}</li>`;
            }).join("")}</ul>
          </li>`).join("")}</ol>
      </div>`
    : "";
  const groups = people.groups.length
    ? `<div class="people-card">
        <h3>Research groups convening your kind of sessions</h3>
        <p class="hint">RGS-IBG research groups sponsoring the sessions that score highest for
        you. Their sessions and socials are where you'll keep bumping into the same people —
        which is rather the point.</p>
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
    const where = `<span class="mono">${dayName(s.day).split(",")[0]} ${t(s.start)}${s.venue ? ` · ${esc(s.venue)}` : ""}</span>`;
    if (!r) {
      return `<div class="lookup-hit"><h4>${esc(s.title)}</h4>${where}
        <p class="hint">Outside your current day or attendance filters, so it wasn't ranked.</p></div>`;
    }
    const note = isAdminSession(s) ? `<p class="hint">Social/admin session — never recommended, whatever it scores.</p>` : "";
    return `<div class="lookup-hit">
      <h4>${esc(s.title)}</h4>${where}
      <div class="lookup-rank">Ranked <strong>#${rank}</strong> of ${total} for you</div>
      <div class="match-bar"><span style="width:${Math.round(norm(r.score) * 100)}%"></span></div>
      ${evidenceHtml(r.evidence)}${note}
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
    const from = e.from.map((f) => (f.sole ? f.label : `${f.label} "${trunc(f.chunk, 60)}"`)).join(" and ");
    return `Matches ${what}${from ? ` — from ${from}` : ""}`;
  }).join("\n");
}

function buildIcs(days) {
  const stamp = icsDate(new Date().toISOString());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Traverse//RGS-IBG 2026//EN",
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
  a.download = "rgs2026-route.ics";
  a.click();
  URL.revokeObjectURL(a.href);
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
    const chip = (cls, text) => {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      el.prepend(span);
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
    ${top5.map((r) => `<div>• ${esc(r.session.title)} <span class="mono">(${dayName(r.session.day).split(",")[0]} ${t(r.session.start)})</span></div>`).join("")}
    ${nudge}
  </div>`;
}

function renderRoute() {
  const agenda = buildAgenda(STATE.results, STATE);
  STATE.agenda = agenda;
  const { days, norm } = agenda;

  $("#day-tabs").innerHTML = [...days.keys()].map((d) =>
    `<button type="button" data-day="${d}" aria-selected="false">${dayName(d)}</button>`).join("");
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
  if (nowSlot) nowSlot.scrollIntoView({ behavior: "smooth", block: "center" });
  else if (scroll) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
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
  }
  renderRoute();
  $("#papers").innerHTML = papersHtml(STATE.papers, routedSessionIds(STATE.agenda.days));
  saveRoute();
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

// Live feedback on the works box. Cleanup is heuristic, so show what was read
// rather than asking the user to trust it.
function refreshWorksNote() {
  const el = $("#works-note");
  const raw = $("#works").value;
  if (!raw.trim()) { el.hidden = true; return; }
  const { kind, items } = parseWorks(raw);
  el.hidden = false;
  if (kind !== "works") {
    el.innerHTML = "Read as free text. Paste a Google Scholar profile and it'll be cleaned to titles automatically.";
    return;
  }
  const used = items.slice(0, WORKS_MAX_TITLES);
  const years = items.map((i) => i.year).filter(Boolean);
  const span = years.length ? ` spanning ${Math.min(...years)}–${Math.max(...years)}` : "";
  const dropped = items.length - used.length;
  const list = used.map((i) =>
    `<li>${esc(i.title)}${i.year ? ` <span class="mono">${i.year}</span>` : ""}</li>`).join("");
  el.innerHTML = `Cleaned to <strong>${items.length} title${items.length === 1 ? "" : "s"}</strong>${span} —
    authors, journals and citation counts stripped.`
    + (dropped ? ` Newest ${WORKS_MAX_TITLES} used, ${dropped} older dropped.` : "")
    + `<details><summary>Check what was read</summary><ol class="parsed-list">${list}</ol></details>`;
}

// One message per way this actually fails. "Something went wrong" was covering
// for offline, a CDN outage and a scoring bug alike, which helps nobody.
function failureMessage(stage) {
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

  const btn = $("#plan-btn");
  btn.disabled = true;
  document.body.classList.add("working");
  let stage = "data";
  try {
    await loadData();
    stage = "model";
    const embed = await loadEmbedder();
    stage = "matching";
    const profile = buildProfile(worksRaw, goalsRaw);
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
    const { results, papers, people } = scoreSessions(profile, { days, mode });
    if (!results.length) { setStatus("no sessions match those filters."); return; }
    STATE = {
      results, papers, people,
      weights: profile.weights,
      filters: { days, mode },
      choices: new Map(),
      dismissed: new Set(),
      chartedAt: new Date().toISOString(),
    };
    renderAll({ scroll: true });
    saveRoute();
    const fraglet = buildFraglet(worksRaw, goalsRaw, [...days], mode);
    localStorage.setItem(FRAGLET_KEY, JSON.stringify(fraglet));
    $("#save-fraglet").hidden = false;
    $("#fraglet-hint").hidden = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(failureMessage(stage));
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

let noteTimer = null;
$("#works").addEventListener("input", () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(refreshWorksNote, 250);
});

// restore a previous profile
try {
  const saved = JSON.parse(localStorage.getItem(FRAGLET_KEY) || "null");
  if (saved) {
    // pre-two-box profiles only have `detail`; it was whatever they pasted, so
    // it belongs in the works box.
    $("#works").value = saved.works ?? saved.detail ?? "";
    $("#goals").value = saved.goals ?? "";
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
  .catch(() => setStatus(""));

// Offline support: cache the shell and data so the route opens on venue wifi
// (or none). The model is already cached by transformers.js itself.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* http, old browser — fine */ });
}
