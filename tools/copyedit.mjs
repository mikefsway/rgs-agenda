#!/usr/bin/env node
/* copyedit — edit the words on a static site without opening the HTML.
 *
 *   on the Pi:     node tools/copyedit.mjs
 *   from a laptop: ssh -L 7000:localhost:7000 <pi>
 *   then open:     http://localhost:7000
 *
 *   node tools/copyedit.mjs docs/index.html about.html --port 7100
 *
 * No dependencies and nothing site-specific: point it at any static HTML file
 * and it finds the copy. It reads the file, works out which bits are words
 * rather than markup, and gives you one box per bit. Save writes the file back
 * with everything else — attributes, ids, indentation, script tags — untouched.
 * Publish runs whatever tests the repo has, then commits and pushes.
 *
 * It binds to 127.0.0.1 on purpose, and that is necessary rather than
 * sufficient: the tunnel lands it on your laptop's localhost alongside whatever
 * you are browsing, so /api/ also wants a per-run token that only the page it
 * serves knows. See the note above TOKEN.
 *
 * What it will not let you do: delete an element that app.js looks up by id,
 * or leave a tag unclosed. Both are checked before anything is written, and a
 * failed check writes nothing.
 *
 * Note it does NOT bump CACHE in a service worker. For copy that's right — a
 * bump re-downloads every cached file, which for Agenda Navigator is 2.5 MB of
 * embeddings to fix a typo. Stale-while-revalidate picks the new text up on
 * the visit after next either way.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, relative, basename } from "node:path";

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg > -1 ? Number(argv[portArg + 1]) : 7000;
const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port");
const ROOT = process.cwd();

/* Binding to 127.0.0.1 is not the access control it looks like. The tunnel puts
 * this server on your *laptop's* localhost, next to every site your browser has
 * open, and a page on any of them can POST here: the handler parses the body
 * whatever the content-type says, so a text/plain form post skips the CORS
 * preflight and lands. The attacker can't read the reply, but /api/save
 * rewrites the copy on your site and /api/publish commits and pushes it, and
 * neither of those needs a reply to hurt.
 *
 * So: a per-run token, minted here and baked into the page, required on every
 * /api/ call. A cross-origin script can't read `/` — no CORS headers — so it
 * can't learn the token. Origin and Host are checked too, mostly so the failure
 * is legible in the log: Host also stops DNS rebinding, where an attacker's
 * domain resolves to 127.0.0.1 and the browser therefore thinks it is us. */
const TOKEN = randomBytes(18).toString("hex");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const hostOf = (v) => String(v || "").trim().replace(/^\w+:\/\//, "").replace(/:\d+$/, "");

const TARGETS = (files.length ? files : defaultTargets()).map((f) => resolve(ROOT, f));
for (const f of TARGETS) {
  if (!existsSync(f)) { console.error(`no such file: ${relative(ROOT, f)}`); process.exit(1); }
}

function defaultTargets() {
  for (const guess of ["docs/index.html", "public/index.html", "site/index.html", "index.html"]) {
    if (existsSync(resolve(ROOT, guess))) return [guess];
  }
  console.error("couldn't find an index.html — pass one: node tools/copyedit.mjs path/to/page.html");
  process.exit(1);
}

// ------------------------------------------------------------------ parsing

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
// Inline tags may sit inside a block of copy without breaking it into pieces:
// "…never <strong>uploaded</strong>." is one sentence, not three fields.
const INLINE = new Set("a abbr b br cite code em i mark q s small span strong sub sup time u".split(" "));
const OPAQUE = new Set("script style svg textarea pre code".split(" "));
const ATTRS = ["placeholder", "alt", "aria-label", "title"];

function parse(src) {
  const root = { tag: "#root", attrs: "", attrsAt: 0, children: [], contentStart: 0, contentEnd: src.length };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
  let last = 0, m;
  const text = (from, to) => { if (to > from) stack[stack.length - 1].children.push({ text: true, start: from, end: to }); };

  while ((m = re.exec(src))) {
    if (m[2] === undefined) { last = re.lastIndex; continue; }   // comment or doctype
    text(last, m.index);
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack[i].contentEnd = m.index; stack.length = i; break; }
      }
    } else {
      const node = {
        tag, attrs: m[3] || "", attrsAt: m.index + 1 + m[2].length,
        children: [], contentStart: re.lastIndex, contentEnd: re.lastIndex,
      };
      stack[stack.length - 1].children.push(node);
      if (!(m[4] === "/" || VOID.has(tag))) stack.push(node);
    }
    last = re.lastIndex;
  }
  text(last, src.length);
  return root;
}

const hasWords = (s) => /[A-Za-z]{2}/.test(s.replace(/<[^>]*>/g, " "));

function identify(node) {
  const id = (node.attrs.match(/\bid="([^"]+)"/) || [])[1];
  const cls = (node.attrs.match(/\bclass="([^"]+)"/) || [])[1];
  let s = node.tag;
  if (id) s += "#" + id;
  else if (cls) s += "." + cls.split(/\s+/)[0];
  return s;
}

/* Trim to the words. The span written back excludes the surrounding newlines
 * and indentation, so editing copy can never reflow the file around it. */
function core(src, start, end) {
  while (start < end && /\s/.test(src[start])) start++;
  while (end > start && /\s/.test(src[end - 1])) end--;
  return [start, end];
}

function units(src, file) {
  const root = parse(src);
  const out = [];
  const add = (u) => { if (u.end > u.start) out.push({ ...u, file }); };

  // Attributes first — they can sit on elements we otherwise don't descend into.
  (function attrs(node) {
    for (const c of node.children) {
      if (c.text) continue;
      const at = c.attrsAt, s = c.attrs;
      const wanted = c.tag === "meta" && /\bname="description"/i.test(s) ? ["content"] : ATTRS;
      for (const name of wanted) {
        const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
        if (!m || !hasWords(m[1])) continue;
        const valueAt = at + s.indexOf(m[0]) + name.length + 2;
        add({ start: valueAt, end: valueAt + m[1].length, kind: "attr", label: `${identify(c)} [${name}]` });
      }
      attrs(c);
    }
  })(root);

  // Then the words themselves.
  (function walk(node, trail) {
    if (OPAQUE.has(node.tag)) return;
    const els = node.children.filter((c) => !c.text);
    const inner = src.slice(node.contentStart, node.contentEnd);
    const here = node.tag === "#root" ? trail : trail.concat(identify(node));

    // An element whose children are all inline is one piece of copy.
    if (node.tag !== "#root" && els.every((c) => INLINE.has(c.tag)) && hasWords(inner)) {
      const [s, e] = core(src, node.contentStart, node.contentEnd);
      add({ start: s, end: e, kind: src.slice(s, e).includes("<") ? "html" : "text", label: here.slice(-2).join(" › ") });
      return;
    }
    for (const c of node.children) {
      if (c.text) {
        const [s, e] = core(src, c.start, c.end);
        if (hasWords(src.slice(s, e))) add({ start: s, end: e, kind: "text", label: here.slice(-2).join(" › ") });
      } else walk(c, here);
    }
  })(root, []);

  out.sort((a, b) => a.start - b.start);
  return out.map((u, i) => ({ ...u, id: `${file}:${i}`, value: src.slice(u.start, u.end) }));
}

// -------------------------------------------------------------- display <-> file

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m]);
/* Every field takes markup, so you can add a <strong> to a line that never had
 * one, and an unbalanced tag is caught before anything is written. Only what
 * could not have been meant as markup gets escaped: a bare ampersand, and a "<"
 * that doesn't start a tag. "Institutions & groups" goes back as "&amp;",
 * "a < b" survives as text, "<em>and</em>" stays a tag.
 *
 * Attribute values are the exception. A quote there closes the attribute and
 * everything after it becomes markup, so they take plain text only. */
const AMP = /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/g;
const loose = (s) => s.replace(AMP, "&amp;").replace(/<(?![a-zA-Z/!])/g, "&lt;");
const strict = (s) => s.replace(AMP, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const forDisplay = (u) => decode(u.value).replace(/\s*\n\s*/g, " ").trim();
function forFile(u, text) {
  const body = (u.kind === "attr" ? strict : loose)(text.trim());
  if (!u.value.includes("\n")) return body;
  // The original was wrapped by hand; keep the file looking like itself.
  const indent = (u.value.match(/\n(\s*)/) || [, "  "])[1];
  const words = body.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > 88) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.join("\n" + indent);
}

// ---------------------------------------------------------------- safety net

/* Every id app.js reaches for. If a copy edit deletes one, the page still
 * renders and then quietly stops working — exactly the kind of failure that
 * only shows up when somebody else tries it. */
function requiredIds() {
  const ids = new Set();
  for (const f of ["docs/app.js", "app.js", "js/app.js"]) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) continue;
    const js = readFileSync(p, "utf8");
    for (const m of js.matchAll(/(?:\$\(|querySelector\(|getElementById\()\s*["'`]#?([A-Za-z][\w-]*)["'`]/g)) {
      if (/^[a-z]+$/.test(m[1]) && !js.includes(`id="${m[1]}"`)) continue;   // a tag name, not an id
      ids.add(m[1]);
    }
  }
  return ids;
}

function check(before, after) {
  const problems = [];
  for (const id of requiredIds()) {
    if (before.includes(`id="${id}"`) && !after.includes(`id="${id}"`)) {
      problems.push(`the element with id="${id}" would be lost, and app.js looks for it`);
    }
  }
  for (const tag of ["script", "link", "textarea", "input", "button"]) {
    const n = (s) => (s.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
    if (n(before) !== n(after)) problems.push(`the number of <${tag}> tags changed (${n(before)} → ${n(after)})`);
  }
  // Tag balance, ignoring void elements.
  const stack = [];
  for (const m of after.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[4] === "/") continue;
    if (m[1] === "/") {
      if (stack[stack.length - 1] === tag) stack.pop();
      else problems.push(`</${tag}> doesn't close ${stack.length ? "<" + stack[stack.length - 1] + ">" : "anything"}`);
    } else stack.push(tag);
  }
  if (stack.length) problems.push(`unclosed: ${[...new Set(stack)].map((t) => "<" + t + ">").join(", ")}`);
  // One unclosed tag makes every later close tag look wrong, so say the first
  // thing that went wrong rather than the avalanche after it.
  const seen = [...new Set(problems)];
  return seen.length > 2 ? seen.slice(0, 2).concat(`(+${seen.length - 2} more, probably all the same cause)`) : seen;
}

// --------------------------------------------------------------------- state

function load() {
  return TARGETS.map((path) => {
    const src = readFileSync(path, "utf8");
    return { path, rel: relative(ROOT, path), src, mtime: statSync(path).mtimeMs, units: units(src, relative(ROOT, path)) };
  });
}

const payload = () => load().map((f) => ({
  rel: f.rel, mtime: f.mtime,
  units: f.units.map((u) => ({ id: u.id, kind: u.kind, label: u.label, value: forDisplay(u) })),
}));

function save(edits) {
  const docs = load();
  const written = [];
  for (const doc of docs) {
    const mine = doc.units.filter((u) => u.id in edits && forDisplay(u) !== edits[u.id]);
    if (!mine.length) continue;
    let out = doc.src;
    for (const u of [...mine].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, u.start) + forFile(u, edits[u.id]) + out.slice(u.end);
    }
    const problems = check(doc.src, out);
    if (problems.length) return { ok: false, error: `${doc.rel}: ${problems.join("; ")}`, files: payload() };
    writeFileSync(doc.path, out);
    written.push(`${doc.rel} (${mine.length} change${mine.length === 1 ? "" : "s"})`);
  }
  return { ok: true, message: written.length ? `saved ${written.join(", ")}` : "nothing changed", files: payload() };
}

const run = (cmd, args) => new Promise((done) =>
  execFile(cmd, args, { cwd: ROOT, maxBuffer: 4e6 }, (err, stdout, stderr) =>
    done({ ok: !err, out: ((stdout || "") + (stderr || "")).trim() })));

async function publish(message) {
  const log = [];
  for (const t of ["test/parse.test.mjs", "test/data.test.mjs"]) {
    if (!existsSync(resolve(ROOT, t))) continue;
    const r = await run("node", [t]);
    log.push(`${t}: ${r.ok ? "passed" : "FAILED\n" + r.out}`);
    if (!r.ok) return { ok: false, log: log.join("\n") };
  }
  const rels = TARGETS.map((t) => relative(ROOT, t));
  const add = await run("git", ["add", ...rels]);
  if (!add.ok) return { ok: false, log: log.concat("git add: " + add.out).join("\n") };
  const staged = await run("git", ["diff", "--cached", "--quiet"]);
  if (staged.ok) return { ok: false, log: log.concat("nothing to publish — save first").join("\n") };
  const commit = await run("git", ["commit", "-m", message || "Copy edits"]);
  log.push(commit.out.split("\n")[0]);
  if (!commit.ok) return { ok: false, log: log.join("\n") };
  const push = await run("git", ["push"]);
  log.push(push.ok ? "pushed" : "push failed:\n" + push.out);
  return { ok: push.ok, log: log.join("\n") };
}

// ---------------------------------------------------------------------- page

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>copy — ${TARGETS.map((t) => basename(t)).join(", ")}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23fbfbf9'/><rect x='4' y='13' width='24' height='8' fill='%23ffe066'/><rect x='6' y='15' width='15' height='3' fill='%2317191a'/></svg>">
<style>
:root{--ink:#17191a;--dim:#666c6a;--rule:#e2e3df;--bg:#fbfbf9;--mark:#ffe066;--warn:#a3341c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--rule);z-index:2}
.bar{max-width:52rem;margin:0 auto;padding:.65rem 1.25rem;display:flex;gap:.75rem;align-items:center}
.bar h1{font:500 .95rem ui-monospace,monospace;margin:0;flex:1}
.bar h1 b{background:var(--mark);font-weight:500;padding:0 .15em}
button{font:inherit;font-size:.9rem;padding:.35rem .8rem;border:1px solid var(--ink);border-radius:3px;background:#fff;cursor:pointer}
button.go{background:var(--ink);color:#fff}
button:disabled{opacity:.4;cursor:default}
main{max-width:52rem;margin:0 auto;padding:1.25rem 1.25rem 6rem}
.file{font:500 .8rem ui-monospace,monospace;color:var(--dim);margin:1.5rem 0 .5rem;padding-bottom:.3rem;border-bottom:1px solid var(--rule)}
.f{margin:0 0 1.1rem}
.f label{display:flex;gap:.5rem;align-items:baseline;font:.75rem ui-monospace,monospace;color:var(--dim);margin-bottom:.2rem}
.f .tag{border:1px solid var(--rule);border-radius:2px;padding:0 .3rem;font-size:.68rem}
.f .rv{margin-left:auto;border:0;background:none;color:var(--dim);text-decoration:underline;cursor:pointer;font-size:.72rem;padding:0;display:none}
.f.dirty .rv{display:inline}
.f.dirty label{color:var(--ink)}
textarea{width:100%;font:inherit;padding:.5rem .6rem;border:1px solid var(--rule);border-radius:3px;background:#fff;resize:none;overflow:hidden}
.f.dirty textarea{border-color:var(--ink);box-shadow:inset 3px 0 0 var(--mark)}
textarea:focus{outline:2px solid #1a4f7a;outline-offset:1px}
#msg{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--rule);padding:.6rem 1.25rem;font:.82rem ui-monospace,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto}
#msg.bad{color:var(--warn)}
#msg:empty{display:none}
</style></head><body>
<header><div class="bar">
  <h1><b>copy</b> <span id="where"></span></h1>
  <span id="count" style="color:#666c6a;font-size:.8rem"></span>
  <button id="save" class="go" disabled>Save</button>
  <button id="pub">Publish</button>
</div></header>
<main id="main"></main>
<div id="msg"></div>
<script>
var orig = {}, files = [];
function el(t, c, x){ var e = document.createElement(t); if(c) e.className = c; if(x!=null) e.textContent = x; return e; }
function grow(t){ t.style.height = "auto"; t.style.height = (t.scrollHeight + 2) + "px"; }
function dirtyCount(){ return document.querySelectorAll(".f.dirty").length; }
function refresh(){
  var n = dirtyCount();
  document.getElementById("save").disabled = n === 0;
  document.getElementById("count").textContent = n ? n + " unsaved" : "";
}
function render(data){
  files = data; orig = {};
  var main = document.getElementById("main");
  main.textContent = "";
  document.getElementById("where").textContent = data.map(function(f){ return f.rel; }).join("  ");
  data.forEach(function(f){
    main.appendChild(el("div", "file", f.rel));
    f.units.forEach(function(u){
      orig[u.id] = u.value;
      var w = el("div", "f"); w.dataset.id = u.id;
      var lab = el("label");
      lab.appendChild(el("span", null, u.label));
      if (u.kind !== "text") lab.appendChild(el("span", "tag", u.kind === "html" ? "html allowed" : "attribute"));
      var rv = el("button", "rv", "revert");
      rv.onclick = function(){ ta.value = orig[u.id]; grow(ta); w.classList.remove("dirty"); refresh(); };
      lab.appendChild(rv);
      var ta = el("textarea"); ta.value = u.value; ta.rows = 1; ta.spellcheck = true;
      ta.oninput = function(){ grow(ta); w.classList.toggle("dirty", ta.value !== orig[u.id]); refresh(); };
      w.appendChild(lab); w.appendChild(ta); main.appendChild(w);
      grow(ta);
    });
  });
  refresh();
}
function say(text, bad){
  var m = document.getElementById("msg");
  m.textContent = text || ""; m.className = bad ? "bad" : "";
}
function edits(){
  var out = {};
  document.querySelectorAll(".f").forEach(function(w){ out[w.dataset.id] = w.querySelector("textarea").value; });
  return out;
}
var TOKEN = "${TOKEN}";
function post(path, body){
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-copyedit-token": TOKEN }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); });
}
document.getElementById("save").onclick = function(){
  say("saving…");
  post("/api/save", { edits: edits() }).then(function(r){
    if (!r.ok) { say(r.error, true); return; }
    render(r.files); say(r.message);
  });
};
document.getElementById("pub").onclick = function(){
  if (dirtyCount()) { say("save first — there are " + dirtyCount() + " unsaved changes", true); return; }
  var m = prompt("Commit message", "Copy edits");
  if (m === null) return;
  say("running tests, committing, pushing…");
  post("/api/publish", { message: m }).then(function(r){ say(r.log, !r.ok); });
};
addEventListener("keydown", function(e){
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); document.getElementById("save").click(); }
});
fetch("/api/units", { headers: { "x-copyedit-token": TOKEN } }).then(function(r){ return r.json(); }).then(render);
</script></body></html>`;

// -------------------------------------------------------------------- server

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/* Every /api/ route goes through this. Returns null when the request is ours,
 * or a reason string to refuse with — refusing loudly, because the only way to
 * see this fire is to read the log. */
function refuse(req) {
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) return `Host is ${req.headers.host}, not localhost`;
  // Browsers send Origin on same-origin POSTs too, so it is normally present.
  // Any local port is fine: `ssh -L 7100:localhost:7000` makes the page's port
  // differ from ours, and that is a supported way to run this.
  if (req.headers.origin && !LOCAL_HOSTS.has(hostOf(req.headers.origin))) return `Origin is ${req.headers.origin}`;
  if (req.headers["x-copyedit-token"] !== TOKEN) return "wrong or missing token — reload the page";
  return null;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.url.startsWith("/api/")) {
    const bad = refuse(req);
    if (bad) {
      console.error(`refused ${req.method} ${req.url}: ${bad}`);
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: `refused: ${bad}`, log: `refused: ${bad}` }));
    }
  }
  if (req.method === "GET" && req.url === "/api/units") return json(res, payload());
  if (req.method === "POST" && (req.url === "/api/save" || req.url === "/api/publish")) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    return req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        json(res, req.url === "/api/save" ? save(data.edits || {}) : await publish(data.message));
      } catch (e) { json(res, { ok: false, error: String(e && e.message || e), log: String(e) }); }
    });
  }
  res.writeHead(404).end("not found");
});

// 127.0.0.1 only: reachable through an SSH tunnel and from nowhere else.
server.listen(PORT, "127.0.0.1", () => {
  const n = payload().reduce((a, f) => a + f.units.length, 0);
  console.log(`copyedit — ${n} pieces of copy in ${TARGETS.map((t) => relative(ROOT, t)).join(", ")}`);
  console.log(`listening on 127.0.0.1:${PORT} (localhost only)\n`);
  console.log(`  from your laptop:  ssh -L ${PORT}:localhost:${PORT} ${process.env.USER || "pi"}@<this-machine>`);
  console.log(`  then open:         http://localhost:${PORT}\n`);
  console.log("  ctrl-c to stop");
});
