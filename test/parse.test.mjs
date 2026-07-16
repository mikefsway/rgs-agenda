/* Tests for the Scholar/publication-list cleanup.
 *
 * No dependencies and no runner: `node test/parse.test.mjs`.
 *
 * The parser is a pile of heuristics over a format nobody specified, so the
 * load-bearing test is the real 68-article profile in fixtures/ — two genuine
 * bugs (every year silently dropped; profile furniture embedded as papers) got
 * through a synthetic fixture that looked convincing. Keep the fixture real.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorks } from "../docs/scholar.js";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}

function group(name) { console.log(`\n${name}`); }

// ---------------------------------------------------------------- real paste

group("real Google Scholar profile (test/fixtures/scholar-profile.txt)");
{
  const raw = readFileSync(join(here, "fixtures/scholar-profile.txt"), "utf8");
  const { kind, items } = parseWorks(raw);
  const titles = items.map((i) => i.title);

  check("detected as a publication list", kind === "works", kind);

  // The profile footer says "Articles 1–68". One title ("Data Synergy in times
  // of crisis") is two different papers sharing a name, and dedupes to one.
  check("extracts 67 of 68 articles (1 genuine duplicate title)",
    items.length === 67, `got ${items.length}`);

  const dated = items.filter((i) => i.year).length;
  check("65 carry a year (2 have none in the source)", dated === 65, `got ${dated}`);

  check("years span 2014–2026",
    Math.min(...items.map((i) => i.year).filter(Boolean)) === 2014
    && Math.max(...items.map((i) => i.year).filter(Boolean)) === 2026);

  check("sorted newest first",
    items.every((it, i, a) => i === 0 || (a[i - 1].year ?? 0) >= (it.year ?? 0)));

  // Regression: cited-by and year arrive as ONE line ("366    2017"), so testing
  // Number(line) drops every year and silently kills the recency ordering.
  const services = items.find((i) => /^Energy services: A conceptual review/.test(i.title));
  check("year parsed from a '366    2017' row", services?.year === 2017, `got ${services?.year}`);

  // Regression: the cited-by count may carry an asterisk ("36*    2015").
  const isItTime = items.find((i) => /^Is it time\?/.test(i.title));
  check("year parsed from a '36*    2015' row", isItTime?.year === 2015, `got ${isItTime?.year}`);

  // A row with 2019 citations and a 2023 year must not become a 2019 paper.
  const p2pDef = items.find((i) => /^Defining characteristics of peer-to-peer/.test(i.title));
  check("cited-by that looks like a year loses to the real year",
    p2pDef?.year === 2024, `got ${p2pDef?.year}`);

  // Regression: two-word titles are real ("Just flexibility?", Nature Energy).
  check("two-word title survives", titles.some((t) => /^Just flexibility\?$/.test(t)));

  // Regression: everything above the "Title/Cited by/Year" header is furniture.
  const furniture = [
    "Help colleagues find you.", "Review public access", "Based on funding mandates",
    "Certain articles should be publicly available.", "We have co-authors suggestions.",
    "University of Exeter", "UCL Energy Institute",
  ];
  check("no profile furniture embedded as papers",
    !titles.some((t) => furniture.includes(t)),
    titles.filter((t) => furniture.includes(t)).join(" | "));

  check("no stats-block lines survived",
    !titles.some((t) => /^(Citations|h-index|i10-index|All)\s/.test(t)),
    titles.filter((t) => /^(Citations|h-index|i10-index|All)\s/.test(t)).join(" | "));

  check("no author lines survived",
    !titles.some((t) => /^(MJ?|GM|NE|ML|CM|UJJ|GAA|EJ|CA|LF|JP) [A-Z][a-z]/.test(t)),
    titles.filter((t) => /^(MJ?|GM|NE|ML|CM|UJJ|GAA|EJ|CA|LF|JP) [A-Z][a-z]/.test(t)).join(" | "));

  check("no venue lines survived",
    !titles.some((t) => /^(SocArXiv|Figshare|UK Power Networks|Edward Elgar|Event Horizon|Available at SSRN|Energy Policy \d|Nature Energy \d|Proceedings of)/.test(t)),
    titles.filter((t) => /^(SocArXiv|Figshare|UK Power Networks|Edward Elgar|Event Horizon|Available at SSRN|Proceedings of)/.test(t)).join(" | "));

  check("footer chrome dropped",
    !titles.some((t) => /^(Articles 1|PrivacyTermsHelp)/.test(t)));
}

// ------------------------------------------------------- tab-separated pastes

group("tab-separated paste (some browsers copy the table as cells)");
{
  const tabbed = [
    "TITLE\tCITED BY\tYEAR",
    "Mining the mind: Household energy data and the promise of behaviour change",
    "MJ Fell, D Shipworth, GM Huebner",
    "Energy Research & Social Science 45, 235-244\t312\t2018",
    "Anticipating distributed energy futures in the British grid",
    "MJ Fell",
    "Environment and Planning B: Urban Analytics and City Science\t14\t2026",
  ].join("\n");
  const { kind, items } = parseWorks(tabbed);
  check("still detected as a list", kind === "works", kind);
  check("both titles extracted", items.length === 2, `got ${items.length}`);
  check("years parsed from tab cells too",
    items[0].year === 2026 && items[1].year === 2018,
    items.map((i) => i.year).join(","));
  // Only the positional rule can drop a numberless venue under a solo author.
  check("numberless venue under a solo author dropped",
    !items.some((i) => /^Environment and Planning B/.test(i.title)));
}

// ------------------------------------------------------------- prose fallback

group("prose fallback");
{
  const { kind } = parseWorks(
    "I research household energy demand and the fairness of time-of-use tariffs. "
    + "My work spans survey methods and qualitative fieldwork. I lead the CREDS demand theme."
  );
  check("a bio is not treated as a publication list", kind === "prose", kind);
}

// ------------------------------------------- author-detection false positives

group("author detection must not eat titles");
{
  const { items } = parseWorks([
    "TITLE\tCITED BY\tYEAR",
    "Energy Justice, Climate Change and the Politics of Transition",
    "M Fell, D Shipworth",
    "Energy Policy 100, 1-12\t5\t2021",
    "Cities, flows and networks: a critical reading",
    "M Fell",
    "Urban Studies 58 (4), 700-720\t8\t2022",
    "GIS approaches to flood risk in coastal cities",
    "M Fell, A Jones",
    "Applied Geography 40, 1-9\t7\t2023",
    "A Smith, B Jones",
    "Some Journal 1, 1-2\t1\t2020",
  ].join("\n"));
  const titles = items.map((i) => i.title);
  check("title-cased title with a comma kept", titles.some((t) => /^Energy Justice, Climate Change/.test(t)));
  check("title with a leading comma clause kept", titles.some((t) => /^Cities, flows and networks/.test(t)));
  check("title opening with an acronym kept", titles.some((t) => /^GIS approaches/.test(t)));
  check("bare author line still dropped", !titles.some((t) => /^A Smith, B Jones$/.test(t)));
}

// ------------------------------------------------------------------ dedupe

group("dedupe");
{
  const dupe = [
    "TITLE\tCITED BY\tYEAR",
    "Mining the mind: Household energy data and the promise of behaviour change",
    "MJ Fell, D Shipworth",
    "Energy Research & Social Science 45, 235-244\t312\t2018",
    "Mining the mind: household energy data and the promise of behaviour change!",
    "MJ Fell, D Shipworth",
    "Energy Research & Social Science 45, 235-244\t312\t2018",
  ].join("\n");
  const { items } = parseWorks(dupe);
  // Identical titles embed identically — the second is a wasted chunk slot,
  // not extra signal. Match is case- and punctuation-insensitive.
  check("near-identical titles collapse to one", items.length === 1, `got ${items.length}`);
}

console.log(failed ? `\n${failed} test(s) FAILED` : "\nall tests passed");
process.exit(failed ? 1 : 0);
