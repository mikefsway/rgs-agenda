/* Traverse — client-side agenda builder for RGS-IBG 2026.
 *
 * All matching runs in the browser: the programme ships as precomputed
 * bge-small embeddings (float16 matrix); the user's text is embedded locally
 * with transformers.js and scored with the facet model from ucl-explorer
 * (session score = 0.75 * best facet + 0.25 * mean of top 3, facets kept as
 * evidence). Parallel-session clashes are surfaced with alternatives, never
 * auto-resolved (household_flex Conflict pattern).
 */

import { parseWorks } from "./scholar.js";

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const CLASH_EPS = 0.03;          // top-2 scores this close = genuine clash
const WEAK_REL = 0.55;           // below this normalized score, a slot is "no strong match"
const FRAGLET_KEY = "traverse.rgs2026.fraglet";

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

let DATA = null;          // { sessions, facets, matrix (Float32Array), dim, meta }
let dataPromise = null;
let embedderPromise = null;  // resolves to async (texts, kind) => Float32Array[]

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
  DATA = { sessions: sessionsDoc.sessions, facets, matrix, dim: meta.dim, meta };
  return DATA;
}

function loadEmbedder() {
  if (!embedderPromise) {
    embedderPromise = buildEmbedder().catch((e) => { embedderPromise = null; throw e; });
  }
  return embedderPromise;
}

async function buildEmbedder() {
  setStatus("loading language model (~30 MB, first visit only)…");
  const { pipeline } = await import(TRANSFORMERS_CDN);
  const fe = await pipeline("feature-extraction", EMBED_MODEL, {
    dtype: "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.file?.endsWith(".onnx")) {
        setStatus(`loading language model… ${Math.round(p.progress || 0)}%`);
      }
    },
  });
  return async (texts, kind) => {
    const prefix = kind === "query" ? DATA.meta.query_prefix : "";
    const out = await fe(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    const [n, d] = out.dims;
    const flat = out.data;
    return Array.from({ length: n }, (_, i) => flat.slice(i * d, (i + 1) * d));
  };
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
const GOALS_FULL_WEIGHT_CHARS = 300;   // ~3 real sentences earns the goals box its full weight

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
  // Scale with what they actually wrote: one vague line shouldn't carry half the score.
  const goals = GOALS_MAX_WEIGHT * Math.min(goalsRaw.trim().length / GOALS_FULL_WEIGHT_CHARS, 1);
  return { works: 1 - goals, goals };
}

/* Embed in batches so the status line can tick.
 *
 * Embedding is ~95% of the wall clock and a single fe() call over 67 titles is
 * opaque — the user watches a frozen page for ten seconds and assumes it hung.
 * The yield after each batch is load-bearing: ONNX runs sync on the main thread,
 * so without it the status text never repaints and this buys nothing. */
async function embedBatched(embed, texts, onBatch) {
  const vecs = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    vecs.push(...await embed(batch, "query"));
    onBatch(vecs.length);
    await new Promise((r) => setTimeout(r, 0));
  }
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

const EV_MIN = 0.35;   // below this a facet isn't worth citing as evidence

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
 * This marks only the standouts. */
const DUAL_PCTL = 0.97;

function percentile(values, p) {
  if (!values.length) return Infinity;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
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

  // Weights sum to 1, so the blend stays on the same 0–1 scale as a raw
  // similarity — EV_MIN and the weak-slot threshold keep their calibration.
  const facetScore = new Float32Array(nFacets);
  for (let f = 0; f < nFacets; f++) {
    facetScore[f] = w.works * W.best.sim[f] + w.goals * G.best.sim[f];
  }

  // aggregate per session
  const perSession = new Map();
  for (let f = 0; f < nFacets; f++) {
    const s = facets[f].s;
    if (!perSession.has(s)) perSession.set(s, []);
    perSession.get(s).push(f);
  }
  const results = [];
  for (const [si, fIdxs] of perSession) {
    const sess = sessions[si];
    if (!filters.days.has(sess.day)) continue;
    if (!modeAllowed(sess.mode, filters.mode)) continue;
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
      const from = [];
      for (const src of [W, G]) {
        if (src.best.sim[f] >= EV_MIN && src.best.which[f] >= 0) {
          from.push({ label: src.quoteLabel, chunk: src.chunks[src.best.which[f]], sim: src.best.sim[f] });
        }
      }
      from.sort((a, b) => b.sim - a.sim);
      evidence.push({ kind, label: facets[f].label, score: facetScore[f], from });
    }
    results.push({ session: sess, score, evidence, worksHit, goalsHit, dual: false });
  }

  // Second pass: the badge only means something once we know the spread.
  if (w.works > 0 && w.goals > 0) {
    const tw = percentile(results.map((r) => r.worksHit), DUAL_PCTL);
    const tg = percentile(results.map((r) => r.goalsHit), DUAL_PCTL);
    for (const r of results) r.dual = r.worksHit >= tw && r.goalsHit >= tg;
  }

  results.sort((a, b) => b.score - a.score);
  return results;
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

function buildAgenda(results) {
  const min = Math.min(...results.map((r) => r.score));
  const max = Math.max(...results.map((r) => r.score));
  const norm = (s) => (max > min ? (s - min) / (max - min) : 0.5);

  const slots = new Map(); // "day|start" -> [result]
  for (const r of results) {
    const key = `${r.session.day}|${r.session.start}`;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(r);
  }
  const days = new Map();
  for (const [key, list] of [...slots.entries()].sort()) {
    const [day] = key.split("|");
    list.sort((a, b) => b.score - a.score);
    const substantive = list.filter((r) => !isAdminSession(r.session));
    const ranked = substantive.length ? substantive : list;
    const top = ranked[0];
    const weak = norm(top.score) < WEAK_REL || !substantive.length;
    const clash = !weak && ranked.length > 1 && ranked[1].score >= top.score - CLASH_EPS;
    const slot = {
      start: top.session.start,
      end: top.session.end,
      parallel: list.length,
      pick: top,
      clashWith: clash ? ranked[1] : null,
      alternatives: ranked.slice(clash ? 2 : 1, clash ? 5 : 4),
      weak,
      relStrength: norm(top.score),
    };
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(slot);
  }
  return { days, norm };
}

// ---------- rendering ----------

const fmtTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
const t = (iso) => fmtTime.format(new Date(iso));
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
      parts.push(`${esc(f.label)} <span class="q">“${esc(trunc(f.chunk, 80))}”</span>`);
    }
    const from = parts.length ? ` — from ${parts.join(" and ")}` : "";
    return `<li><span class="why">Matches ${what}</span>${from}</li>`;
  });
  return `<ul class="evidence">${items.join("")}</ul>`;
}

function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

function pickHtml(r, norm, { clash = false } = {}) {
  const s = r.session;
  const modeLabel = { "in-person": "in person", hybrid: "hybrid", online: "online", unspecified: "" }[s.mode];
  return `<article class="pick${clash ? " clash-a" : ""}">
    ${r.dual ? `<span class="dual-flag">Your work and your aims both point here</span>` : ""}
    <h4>${esc(s.title)}</h4>
    <span class="meta mono">${[s.code, s.venue || "venue tbc", modeLabel, s.papers.length ? s.papers.length + " papers" : "panel/plenary"].filter(Boolean).map(esc).join(" · ")}</span>
    <div class="match-bar" role="img" aria-label="match strength ${Math.round(norm(r.score) * 100)} of 100"><span style="width:${Math.round(norm(r.score) * 100)}%"></span></div>
    ${evidenceHtml(r.evidence)}
  </article>`;
}

function slotHtml(slot, norm) {
  const time = `<div class="slot-time mono">${t(slot.start)}–${t(slot.end)} · ${slot.parallel} parallel option${slot.parallel === 1 ? "" : "s"}</div>`;
  if (slot.weak) {
    return `<div class="slot"><div class="weak-slot">${time}
      No strong match here — closest is <span class="pick-inline">${esc(slot.pick.session.title)}</span>
      (${esc(slot.pick.session.venue || "venue tbc")}). A good slot for coffee and corridors.</div></div>`;
  }
  let body;
  if (slot.clashWith) {
    body = `<span class="clash-flag">Genuine clash</span>
      <p class="clash-note">Two sessions match you almost equally here — your call, not ours:</p>
      <div class="fork">
        ${pickHtml(slot.pick, norm, { clash: true })}
        ${pickHtml(slot.clashWith, norm, { clash: true })}
      </div>`;
  } else {
    body = pickHtml(slot.pick, norm);
  }
  const alts = slot.alternatives.length
    ? `<details class="alts"><summary>Also worth a look in this slot (${slot.alternatives.length})</summary>
        ${slot.alternatives.map((a) => pickHtml(a, norm)).join("")}</details>`
    : "";
  return `<div class="slot">${time}${body}${alts}</div>`;
}

function render(results, agenda) {
  const { days, norm } = agenda;
  const top5 = results.filter((r) => !isAdminSession(r.session)).slice(0, 5);
  $("#overview").innerHTML = `<div class="overview-card">
    <h3>If you only make five sessions</h3>
    ${top5.map((r) => `<div>• ${esc(r.session.title)} <span class="mono">(${fmtDay.format(new Date(r.session.start)).split(",")[0]} ${t(r.session.start)})</span></div>`).join("")}
  </div>`;

  const tabs = [...days.keys()].map((d) =>
    `<button type="button" data-day="${d}">${fmtDay.format(new Date(d + "T12:00:00Z"))}</button>`).join("");
  $("#day-tabs").innerHTML = tabs;

  $("#route").innerHTML = [...days.entries()].map(([day, slots]) => `
    <section class="day-block" id="day-${day}">
      <h3 class="day-heading">${fmtDay.format(new Date(day + "T12:00:00Z"))}</h3>
      <div class="route">${slots.map((s) => slotHtml(s, norm)).join("")}</div>
    </section>`).join("");

  $("#day-tabs").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      document.getElementById(`day-${b.dataset.day}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#day-tabs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b));
    });
  });

  $("#results").hidden = false;
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

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
  try {
    await loadData();
    const embed = await loadEmbedder();
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
    const results = scoreSessions(profile, { days, mode });
    if (!results.length) { setStatus("no sessions match those filters."); return; }
    const agenda = buildAgenda(results);
    render(results, agenda);
    const fraglet = buildFraglet(worksRaw, goalsRaw, [...days], mode);
    localStorage.setItem(FRAGLET_KEY, JSON.stringify(fraglet));
    $("#save-fraglet").hidden = false;
    $("#fraglet-hint").hidden = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("something went wrong loading the model — refresh and try again.");
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
// plan() retries with visible status if anything failed.
loadData()
  .then(() => { setStatus(""); return loadEmbedder(); })
  .then(() => setStatus(""))
  .catch(() => setStatus(""));
