/* Traverse — client-side agenda builder for RGS-IBG 2026.
 *
 * All matching runs in the browser: the programme ships as precomputed
 * bge-small embeddings (float16 matrix); the user's text is embedded locally
 * with transformers.js and scored with the facet model from ucl-explorer
 * (session score = 0.75 * best facet + 0.25 * mean of top 3, facets kept as
 * evidence). Parallel-session clashes are surfaced with alternatives, never
 * auto-resolved (household_flex Conflict pattern).
 */

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const CLASH_EPS = 0.03;          // top-2 scores this close = genuine clash
const WEAK_REL = 0.55;           // below this normalized score, a slot is "no strong match"
const FRAGLET_KEY = "traverse.rgs2026.fraglet";

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

let DATA = null;      // { sessions, facets, matrix (Float32Array), dim, meta }
let embedder = null;  // async (texts, kind) => Float32Array[]

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

async function loadData() {
  if (DATA) return DATA;
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

async function loadEmbedder() {
  if (embedder) return embedder;
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
  embedder = async (texts, kind) => {
    const prefix = kind === "query" ? DATA.meta.query_prefix : "";
    const out = await fe(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    const [n, d] = out.dims;
    const flat = out.data;
    return Array.from({ length: n }, (_, i) => flat.slice(i * d, (i + 1) * d));
  };
  return embedder;
}

// ---------- profile ----------

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

function buildFraglet(text, days, mode) {
  return {
    title: "RGS-IBG 2026 conference interests",
    brief: text.replace(/\s+/g, " ").slice(0, 160),
    detail: text,
    category: "interests",
    domain: "conference",
    tags: ["rgs-ibg-2026", `mode:${mode}`, ...days.map((d) => `day:${d}`)],
    visibility: "private",
    created_at: new Date().toISOString(),
    source: "traverse",
  };
}

// ---------- scoring (ucl-explorer facet aggregate) ----------

function scoreSessions(queryVecs, chunks, filters) {
  const { sessions, facets, matrix, dim } = DATA;
  const nFacets = facets.length;
  // best similarity + which chunk, per facet
  const bestSim = new Float32Array(nFacets);
  const bestChunk = new Int16Array(nFacets);
  for (let q = 0; q < queryVecs.length; q++) {
    const qv = queryVecs[q];
    for (let f = 0; f < nFacets; f++) {
      let dot = 0;
      const off = f * dim;
      for (let k = 0; k < dim; k++) dot += matrix[off + k] * qv[k];
      if (dot > bestSim[f]) { bestSim[f] = dot; bestChunk[f] = q; }
    }
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
    fIdxs.sort((a, b) => bestSim[b] - bestSim[a]);
    const top = fIdxs.slice(0, 3).map((f) => bestSim[f]);
    const score = 0.75 * top[0] + 0.25 * (top.reduce((a, b) => a + b, 0) / top.length);
    const evidence = fIdxs.slice(0, 2)
      .filter((f) => bestSim[f] > 0.35)
      .map((f) => ({
        kind: DATA.facets[f].kind,
        label: DATA.facets[f].label,
        sim: bestSim[f],
        chunk: chunks[bestChunk[f]],
      }));
    results.push({ session: sess, score, evidence });
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
    const top = list[0];
    const clash = list.length > 1 && list[1].score >= top.score - CLASH_EPS && norm(top.score) >= WEAK_REL;
    const slot = {
      start: top.session.start,
      end: top.session.end,
      parallel: list.length,
      pick: top,
      clashWith: clash ? list[1] : null,
      alternatives: list.slice(clash ? 2 : 1, clash ? 5 : 4),
      weak: norm(top.score) < WEAK_REL,
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
  const seenChunks = new Set();
  const items = ev.map((e) => {
    const what = e.kind === "paper" ? `paper “${esc(trunc(e.label, 90))}”` : "the session theme";
    const showChunk = !seenChunks.has(e.chunk);
    seenChunks.add(e.chunk);
    const from = showChunk ? ` — from your <span class="q">“${esc(trunc(e.chunk, 80))}”</span>` : "";
    return `<li><span class="why">Matches ${what}</span>${from}</li>`;
  });
  return `<ul class="evidence">${items.join("")}</ul>`;
}

function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

function pickHtml(r, norm, { clash = false } = {}) {
  const s = r.session;
  const modeLabel = { "in-person": "in person", hybrid: "hybrid", online: "online", unspecified: "" }[s.mode];
  return `<article class="pick${clash ? " clash-a" : ""}">
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
  const top5 = results.slice(0, 5);
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

async function plan() {
  const text = $("#interests").value.trim();
  if (text.length < 30) {
    setStatus("tell us a bit more — a few sentences at least.");
    return;
  }
  const days = new Set([...document.querySelectorAll('input[name="day"]:checked')].map((i) => i.value));
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (!days.size) { setStatus("pick at least one day."); return; }

  const btn = $("#plan-btn");
  btn.disabled = true;
  try {
    await loadData();
    await loadEmbedder();
    setStatus("reading your interests…");
    const chunks = chunkText(text);
    const queryVecs = await embedder(chunks, "query");
    setStatus("charting the route…");
    await new Promise((r) => setTimeout(r, 30)); // let status paint
    const results = scoreSessions(queryVecs, chunks, { days, mode });
    if (!results.length) { setStatus("no sessions match those filters."); return; }
    const agenda = buildAgenda(results);
    render(results, agenda);
    const fraglet = buildFraglet(text, [...days], mode);
    localStorage.setItem(FRAGLET_KEY, JSON.stringify(fraglet));
    $("#save-fraglet").hidden = false;
    $("#fraglet-hint").hidden = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("something went wrong loading the model — refresh and try again.");
  } finally {
    btn.disabled = false;
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

// restore a previous profile
try {
  const saved = JSON.parse(localStorage.getItem(FRAGLET_KEY) || "null");
  if (saved?.detail) {
    $("#interests").value = saved.detail;
    $("#save-fraglet").hidden = false;
    $("#fraglet-hint").hidden = false;
  }
} catch { /* ignore corrupt state */ }

// warm the data cache in the background
loadData().then(() => setStatus("")).catch(() => {});
