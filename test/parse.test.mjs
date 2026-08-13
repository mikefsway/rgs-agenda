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

  // ---- authorship, which the "only papers I led" filter rests on ----

  const { owner } = parseWorks(raw);
  // The profile owner is inferred, never asked for — see detectOwner. Scholar
  // renders him both "MJ Fell" and "M Fell" across rows of the same profile, so
  // this failing is the signal that first-initial+surname matching has broken.
  check("owner inferred from the author lines", owner?.key === "m|fell", JSON.stringify(owner));
  check("owner's display name is the modal surface form", owner?.name === "MJ Fell", owner?.name);
  check("owner is on all 67 rows", owner?.rows === 67, `got ${owner?.rows}`);

  const led = items.filter((i) => i.authorFirst === true);
  const notLed = items.filter((i) => i.authorFirst === false);
  const unknown = items.filter((i) => i.authorFirst === null);
  check("27 of 67 are first-authored", led.length === 27, `got ${led.length}`);
  check("40 are led by someone else", notLed.length === 40, `got ${notLed.length}`);
  // Not a nicety: a null is "no author line was read", and filterWorks keeps
  // those rather than dropping a paper on a heuristic miss. If this ever stops
  // being 0 on the real fixture, the author line parsing has regressed.
  check("no row is left with unknown authorship", unknown.length === 0,
    unknown.map((i) => i.title).join(" | "));

  // A solo-author row: the one shape where first-authorship is unambiguous.
  check("solo author row reads as led", services?.authorFirst === true);
  // "G Powells, MJ Fell" — his name is present, second. The whole point of the
  // filter is that this is the case it removes.
  const flexCapital = items.find((i) => /^Flexibility Capital and Flexibility Justice/.test(i.title));
  check("second-author row reads as not led", flexCapital?.authorFirst === false);
  // "MJ Fell, L Pagel, C Chen, ..., GM Huebner, ..." — a truncated list must not
  // lose its head, which is the only part of it that matters here.
  const covid = items.find((i) => /^Validity of energy social research/.test(i.title));
  check("truncated author list still reads its first author", covid?.authorFirst === true);
  /* Regression: "MJ Fell, LF Chiu" is 16 characters and reads as a single name
   * to isSoloAuthorLine, which only asks about shape. Taking that branch keys
   * the row to "M … Chiu" — nobody — and quietly hands three of his own
   * first-authored papers to someone else. isAuthorLine has to be asked first. */
  const children = items.find((i) => /^Children, parents and home energy use/.test(i.title));
  check("short two-author line is split, not read as one name",
    children?.authorFirst === true && children?.authors?.length === 2,
    JSON.stringify(children?.authors));
}

// ------------------------------------------------------- institution detection

group("institution read off the profile card");
{
  const fixture = readFileSync(join(here, "fixtures/scholar-profile.txt"), "utf8");
  const { institution } = parseWorks(fixture);
  check("affiliation taken from the line above the verified email",
    institution?.name === "UCL Energy Institute", JSON.stringify(institution));
  check("domain reduced to its distinctive label", institution?.domain === "ucl");

  /* The card is name / name / affiliation / verified-email, and a profile with
   * no affiliation set is name / name / verified-email. Shape can't tell them
   * apart — isNamePart reads "UCL Energy Institute" as a name, three tokens with
   * the first three capitals, exactly the shape of "MJ Fell" — so the check is
   * whether the line above is the repeated name. */
  const noAff = ["Cited by", "All", "Ann Other", "Ann Other",
    "Verified email at exeter.ac.uk - Homepage", "Geography",
    "Title", "Cited by", "Year",
    "A paper about something reasonably interesting", "A Other",
    "Journal of Things 1 (2), 3-4", "10\t2021"].join("\n");
  const bare = parseWorks(noAff).institution;
  check("no affiliation on the card reads as null, not as the owner's name",
    bare?.name === null, JSON.stringify(bare));
  check("the domain still comes through", bare?.domain === "exeter");

  // Co-author cards have the identical name/name/affiliation shape and end in
  // "Following". Only the verified-email anchor separates the owner from them.
  check("co-author affiliations above the card are not taken",
    institution?.name !== "University of Exeter");

  const noEmail = noAff.replace("Verified email at exeter.ac.uk - Homepage", "Following");
  check("no anchor means no guess", parseWorks(noEmail).institution === null);
  check("prose profiles carry no institution",
    parseWorks("I am a geographer working on energy and cities.").institution === null);
}

// ------------------------------------------------------------ owner detection

group("owner detection refuses to guess rather than guessing wrong");
{
  const row = (title, authors, year) => [title, authors, `Some Journal 12 (3), 1-9`, `4    ${year}`];
  // Two people on everything, in alternating order: nobody is the profile owner
  // on the evidence available, and marking papers against a coin toss would be
  // invisible downstream. The control hides itself in this state.
  const pair = parseWorks(["TITLE\tCITED BY\tYEAR",
    ...row("Household energy demand and the shape of the evening peak", "A Smith, B Jones", 2021),
    ...row("Time of use tariffs and the working day", "B Jones, A Smith", 2022),
    ...row("Fieldwork methods for domestic energy research", "A Smith, B Jones", 2023),
    ...row("Peak demand and the limits of automation", "B Jones, A Smith", 2024),
  ].join("\n"));
  check("no owner when two authors share every paper", pair.owner === null, JSON.stringify(pair.owner));
  check("authorship is unknown, not false, when there's no owner",
    pair.items.every((i) => i.authorFirst === null));

  const solo = parseWorks(["TITLE\tCITED BY\tYEAR",
    ...row("Household energy demand and the shape of the evening peak", "A Smith, B Jones", 2021),
    ...row("Time of use tariffs and the working day", "C Patel, A Smith", 2022),
    ...row("Fieldwork methods for domestic energy research", "A Smith, D Okafor", 2023),
    ...row("Peak demand and the limits of automation", "A Smith", 2024),
  ].join("\n"));
  check("owner found when one name recurs and the others don't",
    solo.owner?.key === "a|smith", JSON.stringify(solo.owner));
  check("first-authorship read off the recovered owner",
    solo.items.filter((i) => i.authorFirst === true).length === 3,
    solo.items.map((i) => `${i.authorFirst}`).join(","));

  // Three rows is the floor; below it the modal author means nothing.
  const thin = parseWorks(["TITLE\tCITED BY\tYEAR",
    ...row("Household energy demand and the shape of the evening peak", "A Smith, B Jones", 2021),
    ...row("Time of use tariffs and the working day", "A Smith, C Patel", 2022),
  ].join("\n"));
  check("two papers is too few to name an owner", thin.owner === null, JSON.stringify(thin.owner));
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
