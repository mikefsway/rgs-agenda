/* Checks the *live* site, not the working tree.
 *
 *   node test/monitor.mjs                 # against GitHub Pages
 *   node test/monitor.mjs http://localhost:8765/
 *
 * Exits non-zero if anything a visitor depends on is broken. Prints one line
 * per check; add --quiet to print only failures, which is what a cron job
 * wants.
 *
 * Traverse has no server to fall over, so the outages that can actually happen
 * are all somewhere else:
 *
 *  - a half-deployed Pages build, where the four data files disagree. The four
 *    are only meaningful together, and stale-while-revalidate will happily hand
 *    a browser one new file and three old ones.
 *  - jsDelivr or Hugging Face going away. The model is ~30 MB fetched from HF at
 *    first visit; if that 404s the app cannot match anything, and the only
 *    symptom on the page is "couldn't load the language model".
 *  - the programme changing under us. Late changes before 1 September are
 *    expected, and a moved session is invisible: the route still renders, it
 *    just sends people to the wrong room at the wrong time.
 */

const BASE = (process.argv.find((a) => a.startsWith("http")) || "https://mikefsway.github.io/rgs-agenda/")
  .replace(/\/?$/, "/");
const QUIET = process.argv.includes("--quiet");

let failures = 0;
const say = (s) => { if (!QUIET) console.log(s); };
const heading = (h) => say(`\n${h}`);
const ok = (name, cond, detail = "") => {
  if (cond) say(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
  return cond;
};
const info = (s) => say(`  info  ${s}`);

const NO_CACHE = { headers: { "cache-control": "no-cache", pragma: "no-cache" } };
async function head(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", ...NO_CACHE });
    return r.status;
  } catch (e) { return `network error: ${e.message}`; }
}
async function get(url) {
  const r = await fetch(url, { redirect: "follow", ...NO_CACHE });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r;
}

console.log(`traverse monitor — ${BASE} — ${new Date().toISOString()}`);

// ---------- the site itself ----------

heading("site");
let appjs = "";
try {
  ok("index.html loads", (await head(BASE)) === 200);
  appjs = await (await get(BASE + "app.js")).text();
  ok("app.js loads", appjs.length > 1000);
  const sw = await (await get(BASE + "sw.js")).text();
  info(`service worker cache ${(sw.match(/const CACHE = "([^"]+)"/) || [])[1]}`);
} catch (e) {
  ok("the site is reachable", false, e.message);
}

// ---------- the four data files, as served ----------

heading("programme data");
try {
  const meta = await (await get(BASE + "data/meta.json")).json();
  const sessions = (await (await get(BASE + "data/sessions.json")).json()).sessions;
  const facets = await (await get(BASE + "data/facets.json")).json();
  const bin = await (await get(BASE + "data/embeddings.bin")).arrayBuffer();

  info(`${sessions.length} sessions, ${facets.length} facets, ${(bin.byteLength / 1e6).toFixed(1)} MB matrix`);

  // Same djb2 the browser recomputes at load. If this fails, every visitor gets
  // a thrown error instead of a route.
  const s = sessions.map((x) => x.id).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  ok("sessions.json row order matches the matrix", h.toString(36) === meta.order_sig,
    `served order ${h.toString(36)}, matrix built for ${meta.order_sig}`);
  ok("facets.json matches meta.n_facets", facets.length === meta.n_facets,
    `${facets.length} vs ${meta.n_facets} — a partial deploy`);
  ok("sessions.json matches meta.n_sessions", sessions.length === meta.n_sessions,
    `${sessions.length} vs ${meta.n_sessions} — a partial deploy`);
  ok("embeddings.bin is the right size", bin.byteLength === meta.n_facets * meta.dim * 2,
    `${bin.byteLength} bytes, expected ${meta.n_facets * meta.dim * 2}`);
} catch (e) {
  ok("the data files are reachable", false, e.message);
}

// ---------- everything the browser fetches from somewhere else ----------

heading("external dependencies");
const cdn = (appjs.match(/const TRANSFORMERS_CDN = "([^"]+)"/) || [])[1];
const model = (appjs.match(/const EMBED_MODEL = "([^"]+)"/) || [])[1];
if (cdn) {
  const st = await head(cdn + "/+esm");
  ok(`transformers.js on jsDelivr (${cdn.split("/npm/")[1]})`, st === 200, `HTTP ${st}`);
}
if (model) {
  // dtype: "q8" on the wasm backend, so this is the exact file the app pulls.
  const files = ["onnx/model_quantized.onnx", "config.json", "tokenizer.json"];
  for (const f of files) {
    const url = `https://huggingface.co/${model}/resolve/main/${f}`;
    const st = await head(url);
    ok(`${model}/${f}`, st === 200, `HTTP ${st}`);
  }
}

// ---------- has the programme moved? ----------

heading("programme freshness (Ex Ordo)");
try {
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
  let live = 0;
  for (const d of days) {
    // Same endpoint pipeline/fetch.py uses; page_size is clamped to 15 server-
    // side, but `count` is the whole day's total, which is all we need here.
    const url = `https://event.ac2026.exordo.com/api/virtual_published_contents?date=${d}&page=1&page_size=15`;
    const r = await fetch(url, NO_CACHE);
    if (!r.ok) throw new Error(`${d}: HTTP ${r.status}`);
    const j = await r.json();
    live += j.count ?? 0;
  }
  const shipped = (await (await get(BASE + "data/meta.json")).json()).n_sessions;
  info(`Ex Ordo reports ${live} sessions; the site ships ${shipped}`);
  ok("the published programme still matches the shipped one", live === shipped,
    `${live} vs ${shipped} — re-run the pipeline (fetch → normalize → embed), bump CACHE in docs/sw.js`);
} catch (e) {
  // The API changing shape is itself worth knowing about, but it is not an
  // outage of the site: a stale programme still works.
  ok("the Ex Ordo API answers", false, e.message);
}

console.log(failures ? `\n${failures} check(s) failed` : (QUIET ? "" : "\nall checks passed"));
process.exit(failures ? 1 : 0);
