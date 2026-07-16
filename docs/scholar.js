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

function isAuthorLine(line) {
  const parts = line.split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.filter(isNamePart).length / parts.length >= 0.6;
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
  if (!looksScholar) return { kind: "prose", items: [] };

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
    if (isAuthorLine(line) || (prev === "title" && isSoloAuthorLine(line))) { prev = "authors"; continue; }
    if (prev === "authors") { prev = null; continue; }   // the line after authors is the venue
    if (looksLikeTitle(line)) { items.push({ title: line, year: null }); prev = "title"; continue; }
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
  return { kind: "works", items: uniq };
}

export { parseWorks };
