/* Deterministic cleanup for pasted publication lists (Google Scholar and
 * friends). Kept as its own module so it can be unit-tested directly — it is
 * a pile of heuristics validated against a real 68-article profile, and it
 * will rot silently without tests. See test/parse.test.mjs.
 */

const YEAR_MIN = 1950;
const YEAR_MAX = new Date().getFullYear() + 1;
const isYear = (n) => Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX;

// Page furniture that a select-all copy drags along.
const CHROME_RE = /^(title|cited by|year|sort by|articles?|public access|co-?authors?|verified email.*|homepage|follow(ing)?|new articles|citations|h-?index|i10-?index|all|since \d{4}|view all|my (profile|library)|alerts?|metrics|profile|show more|load more|[×✕✓·•*\-–—]+)$/i;

// Venue-name shapes. Deliberately narrow: "review", "letters" and "press" alone
// appear in real titles, so only match phrasings a title would not use.
const JOURNAL_RE = /\b(journal of|proceedings of|transactions on|annals of|university press|routledge|springer|elsevier|wiley|blackwell|sage publications|arxiv|ssrn|preprint|working paper|phd thesis|doctoral dissertation)\b/i;

// "Environment and Planning A 52 (3), 445-467" / "Energy Policy 122, 1-10"
const VENUE_RE = /\b\d{1,4}\s*\(\d+\)|\b\d+\s*[,:]\s*\d+\s*[-–]\s*\d+|\bpp?\.\s*\d+|\bvol\.?\s*\d+|\bdoi:|\bhttps?:\/\//i;

// A row's trailing cells. Real pastes put cited-by and year on ONE line
// ("366    2017"), not one per line, and the count may carry a trailing asterisk
// ("36*    2015"), so parse the whole line rather than testing Number(line).
const NUM_LINE_RE = /^[\d\s*]+$/;

// Scholar renders authors initials-first: "M Fell, D Shipworth, T Oreszczyn".
// Requiring the initial is deliberately conservative — a missed author line costs
// one noise chunk, a false positive costs a real title.
function isNamePart(p) {
  const toks = p.replace(/\.{3}|…/g, "").trim().split(/\s+/);
  return toks.length >= 2 && toks.length <= 4 && /^[A-ZÀ-Þ]{1,3}\.?$/.test(toks[0]);
}

function splitAuthors(line) {
  return line.split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
}

function isAuthorLine(line) {
  const parts = splitAuthors(line);
  if (parts.length < 2) return false;
  return parts.filter(isNamePart).length / parts.length >= 0.6;
}

/* Identity of one author, for the single question anything downstream asks:
 * is this me? Scholar abbreviates the given name inconsistently across rows of
 * the same profile ("MJ Fell" on one paper, "M Fell" on the next), so match on
 * first initial plus surname and nothing else. Returns null for a part that
 * isn't a name — a trailing "…", an "et al" — and callers keep the null so
 * position is preserved. */
function authorKey(part) {
  const toks = part.replace(/\.{3}|…/g, "").trim().split(/\s+/);
  if (toks.length < 2) return null;
  return `${toks[0][0]}|${toks[toks.length - 1]}`.toLowerCase();
}

/* Whose profile is this? The modal author, because nobody appears on more of
 * your papers than you do.
 *
 * Inferring it beats asking for it: the name on the profile is up in the
 * furniture sliceToTable has already cut, and a name typed into a box would
 * silently turn "papers I led" into "papers nobody led". It refuses to guess
 * rather than guess wrong — a wrong owner marks the wrong papers, and no check
 * downstream could tell. Two guards: the winner has to be on most of the rows,
 * and it has to be clear of the runner-up, which is what stops a two-person
 * lab's second author being crowned on a coin toss. */
function detectOwner(items) {
  const rows = new Map();     // key -> rows it appears on
  const forms = new Map();    // key -> {surface form -> count}, for display
  let withAuthors = 0;
  for (const it of items) {
    if (!it.authors?.some(Boolean)) continue;
    withAuthors++;
    const seen = new Set();
    it.authors.forEach((k, i) => {
      if (!k || seen.has(k)) return;
      seen.add(k);
      rows.set(k, (rows.get(k) ?? 0) + 1);
      const form = it.authorNames[i];
      if (!forms.has(k)) forms.set(k, new Map());
      const f = forms.get(k);
      f.set(form, (f.get(form) ?? 0) + 1);
    });
  }
  if (withAuthors < 3) return null;
  const ranked = [...rows.entries()].sort((a, b) => b[1] - a[1]);
  const [key, n] = ranked[0];
  if (n < withAuthors * 0.6) return null;
  if ((ranked[1]?.[1] ?? 0) > n * 0.5) return null;
  const name = [...forms.get(key)].sort((a, b) => b[1] - a[1])[0][0];
  return { key, name, rows: n };
}

// A solo author ("MJ Fell") is only safely separable from a short title by
// position — in a Scholar row it always sits directly under the title. Matching
// it on shape alone would eat titles that open with an acronym ("GIS in the field").
function isSoloAuthorLine(line) {
  return line.length <= 40 && isNamePart(line);
}

// Two words is enough ("Just flexibility?" is a real paper). The word floor was
// only ever guarding against profile furniture, which sliceToTable now removes
// structurally; what's left in the table is caught by shape.
function looksLikeTitle(line) {
  return line.length >= 16
    && line.split(/\s+/).length >= 2
    && !VENUE_RE.test(line)
    && !JOURNAL_RE.test(line);
}

/* Everything above the "Title / Cited by / Year" header is profile furniture —
 * the citation stats block, the co-author cards, funding notices, "Add co-authors".
 * Several of those lines are indistinguishable from titles by shape alone
 * ("Based on funding mandates", "University of Exeter"), so cut by structure
 * rather than trying to name them all. Absent (someone selected just the table),
 * we keep everything. */
function sliceToTable(lines) {
  for (let i = lines.length - 1; i >= 1; i--) {
    if (/^year$/i.test(lines[i]) && /^cited by$/i.test(lines[i - 1])) return lines.slice(i + 1);
  }
  return lines;
}

/* Pull paper titles (and years) out of a pasted publication list.
 *
 * Scholar's row shape is title → authors → venue → cited-by → year, and copying
 * the table gives those as newline- or tab-separated fields. We classify each
 * line rather than trusting the tabs, since the exact copy format varies by
 * browser. Falls back to { kind: "prose" } for anything that isn't a list. */
function parseWorks(raw) {
  const lines = raw.split(/[\n\t]+/).map((s) => s.trim()).filter(Boolean);
  const looksScholar =
    (/^\s*title\b/im.test(raw) && /cited by/i.test(raw))
    || lines.filter(isAuthorLine).length >= 3
    || lines.filter((l) => isYear(Number(l))).length >= 3;
  if (!looksScholar) return { kind: "prose", items: [], owner: null };

  const items = [];
  let prev = null;   // "title" | "authors"
  for (const line of sliceToTable(lines)) {
    if (NUM_LINE_RE.test(line)) {
      // Cited-by then year, so the last year-shaped number wins — that way a
      // paper with 2019 citations doesn't become a 2019 paper.
      if (items.length) {
        for (const m of line.match(/\d+/g) ?? []) {
          if (isYear(Number(m))) items[items.length - 1].year = Number(m);
        }
      }
      prev = null;
      continue;
    }
    if (CHROME_RE.test(line)) { prev = null; continue; }
    // Order matters. isSoloAuthorLine only asks whether the line *looks* like a
    // single name, and a short two-author line ("G Powells, MJ Fell") looks
    // exactly like one, so the multi-author test has to win. Treating that line
    // as one name keys it to "G … Fell" — a person who doesn't exist, on a paper
    // whose real first author is somebody else.
    const multi = isAuthorLine(line);
    const solo = !multi && prev === "title" && isSoloAuthorLine(line);
    if (multi || solo) {
      // Scholar prints the author line directly under its title, in submission
      // order, and truncates the tail with "…" — never the head. So the one
      // thing this line reliably carries is who is first, which is the one
      // thing we want from it.
      if (prev === "title" && items.length) {
        const parts = multi ? splitAuthors(line) : [line];
        const it = items[items.length - 1];
        it.authorNames = parts;
        it.authors = parts.map(authorKey);
      }
      prev = "authors";
      continue;
    }
    if (prev === "authors") { prev = null; continue; }   // the line after authors is the venue
    if (looksLikeTitle(line)) {
      items.push({ title: line, year: null, authors: null, authorNames: null, authorFirst: null });
      prev = "title";
      continue;
    }
    prev = null;
  }

  const seen = new Set();
  const uniq = items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Newest first. Under a hard cap, ordering *is* recency prioritisation: recent
  // work survives the cut and the back catalogue falls off the end.
  uniq.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  /* `authorFirst` is deliberately three-valued. false is "somebody else led
   * this"; null is "no author line was read for this row", which happens when
   * the paste is partial or the row is shaped oddly, and must not be silently
   * treated as false — a filter that drops your own paper because a heuristic
   * missed a line is invisible from the outside. Callers keep the nulls. */
  const owner = detectOwner(uniq);
  for (const it of uniq) {
    // Keyed off authors[0] specifically, not "any name was read": a row whose
    // *first* slot didn't parse is unknown, not somebody else's.
    it.authorFirst = owner && it.authors?.[0] ? it.authors[0] === owner.key : null;
  }
  return { kind: "works", items: uniq, owner };
}

export { parseWorks };
