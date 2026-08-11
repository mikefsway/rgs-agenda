/* Checks the shipped data files against each other, and against the rules the
 * app relies on but can't check at load time.
 *
 *   node test/data.test.mjs
 *
 * Run after every pipeline run, before every deploy. The failures this catches
 * are the ones with no visible symptom: a route that quotes the wrong papers, a
 * real workshop silently filtered out of every agenda, a quarter of the
 * programme saying "venue tbc". None of them throws in the browser.
 *
 * By design it reads the regexes out of docs/app.js rather than restating them,
 * so a change to the filter is tested rather than shadowed by a stale copy.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

let failures = 0;
let group = "";
const heading = (h) => { group = h; console.log(`\n${h}`); };
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};

const meta = json("docs/data/meta.json");
const { sessions } = json("docs/data/sessions.json");
const facets = json("docs/data/facets.json");
const binBytes = statSync(join(root, "docs/data/embeddings.bin")).size;
const app = read("docs/app.js");

// ---------- the matrix and the programme describe the same thing ----------

heading("matrix ↔ programme");

// djb2 over the ids in row order, exactly as assertOrder() recomputes it in the
// browser and embed.py stamps it. This is the only check that sees a permutation.
function orderSig(list) {
  const s = list.map((x) => x.id).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
ok("sessions.json row order matches meta.order_sig", orderSig(sessions) === meta.order_sig,
  `sessions are ${orderSig(sessions)}, matrix was built for ${meta.order_sig} — re-run pipeline/embed.py`);
ok("meta.n_sessions matches sessions.json", meta.n_sessions === sessions.length,
  `${meta.n_sessions} vs ${sessions.length}`);
ok("meta.n_facets matches facets.json", meta.n_facets === facets.length,
  `${meta.n_facets} vs ${facets.length}`);
ok("embeddings.bin is n_facets × dim float16", binBytes === meta.n_facets * meta.dim * 2,
  `${binBytes} bytes, expected ${meta.n_facets * meta.dim * 2}`);
ok("every facet points at a real session row",
  facets.every((f) => Number.isInteger(f.s) && f.s >= 0 && f.s < sessions.length));
ok("every session has at least one facet",
  new Set(facets.map((f) => f.s)).size === sessions.length,
  `${new Set(facets.map((f) => f.s)).size} of ${sessions.length} sessions are addressed`);
// Session facets get a description chunk appended before embedding, so only
// paper facets are safe to use as embedder self-check probes.
ok("paper facets exist for the embedder self-check", facets.filter((f) => f.kind === "paper").length > 100);
ok("no facet has an empty label", facets.every((f) => f.label && f.label.trim().length > 1));

// ---------- fields the UI reads ----------

heading("session fields");

const noVenue = sessions.filter((s) => !s.venue || !s.venue.trim());
ok("every session has a room", noVenue.length === 0,
  `${noVenue.length} would render "venue tbc" — check virtual_stage as well as virtual_venue`);

const noEid = sessions.filter((s) => !s.eid);
ok("every session has an eid to link on", noEid.length === 0,
  `${noEid.length} sessions can't link to the official programme`);

ok("ids are unique", new Set(sessions.map((s) => s.id)).size === sessions.length);
ok("start is before end", sessions.every((s) => Date.parse(s.start) < Date.parse(s.end)));
ok("day matches start", sessions.every((s) => s.start.startsWith(s.day)));
ok("the programme covers four days", new Set(sessions.map((s) => s.day)).size === 4,
  [...new Set(sessions.map((s) => s.day))].sort().join(", "));
ok("every session has a title", sessions.every((s) => s.title && s.title.trim()));

// ---------- the admin filter ----------

heading("admin filter (isAdminSession)");

/* Lifted from the source rather than restated: the bare word "social" was in
 * ADMIN_TITLE once and quietly deleted a real workshop from every agenda. A
 * copy here would have kept passing. */
function regexFromSource(name) {
  const m = app.match(new RegExp(`const ${name} = /(.*)/([gimsuy]*);`));
  if (!m) throw new Error(`couldn't find ${name} in docs/app.js — has it been renamed?`);
  return new RegExp(m[1], m[2]);
}
const ADMIN_TITLE = regexFromSource("ADMIN_TITLE");
const SOCIAL_EVENT = regexFromSource("SOCIAL_EVENT");
const isAdmin = (s) => ADMIN_TITLE.test(s.title) || SOCIAL_EVENT.test(s.title);

const excluded = sessions.filter(isAdmin);
console.log(`  info  excludes ${excluded.length} of ${sessions.length} sessions`);

/* Ex Ordo's own `type` is the independent signal here, and it is the one the
 * title heuristic got wrong before: the workshop that vanished from every
 * agenda was a `workshop_with_manual_content` caught by the bare word "social".
 * Every genuine social and AGM in the programme is a paperless
 * `general_session_with_manual_content`, so anything else being excluded means
 * the regex has started eating real sessions. Description length is no help —
 * "Geographies of Children, Youth and Families Evening Social" has 1,027
 * characters of it. */
const ADMIN_TYPE = "general_session_with_manual_content";
const wrongType = excluded.filter((s) => s.type !== ADMIN_TYPE);
ok("only manual-content sessions are excluded", wrongType.length === 0,
  wrongType.map((s) => `"${s.title}" is a ${s.type}`).join("; "));

const withPapers = excluded.filter((s) => s.papers.length > 0);
ok("nothing with papers is excluded", withPapers.length === 0,
  withPapers.map((s) => `"${s.title}" (${s.papers.length} papers)`).join("; "));

ok("the filter still catches receptions and AGMs",
  excluded.some((s) => /reception/i.test(s.title)) && excluded.length >= 5);
ok("it does not swallow the whole programme", excluded.length < sessions.length * 0.15,
  `${excluded.length} excluded`);

// ---------- freshness ----------

heading("freshness");

const gen = json("docs/data/sessions.json").generated_from || "";
console.log(`  info  generated from ${gen || "(unrecorded)"}`);
const firstDay = [...new Set(sessions.map((s) => s.day))].sort()[0];
const daysToGo = Math.round((Date.parse(firstDay + "T00:00:00Z") - Date.now()) / 86400000);
console.log(`  info  ${daysToGo} days until the conference opens (${firstDay})`);
ok("the programme is still in the future", daysToGo > -5,
  "the conference has been and gone — this data is history");

// The service worker version has to move whenever the data does, or the four
// files refresh on four different schedules and can disagree in a live browser.
const cacheName = (app, sw = read("docs/sw.js")) => (sw.match(/const CACHE = "([^"]+)"/) || [])[1];
console.log(`  info  service worker cache is ${cacheName()}`);

console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
