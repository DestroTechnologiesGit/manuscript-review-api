import { chromium } from "playwright";

const PORT = process.argv[2] || 3114;
const TAG = process.argv[3] || "before";
const OUT = "/private/tmp/claude-501/-Users-mac-ChaseProject-Manuscript/7fb8dbdb-cc4f-4b6b-9e7f-142241df5644/scratchpad";

// A realistic issue list, shaped like what the reviewer actually returns.
const ISSUES = [
  { title: "Bird count contradicts itself between chapters",
    category: "Accuracy", severity: "high", location: "Ch. 2 and Ch. 9",
    excerpt: "There are over 400 species of hummingbird in the Americas.",
    problem: "Chapter 2 says 400 species, chapter 9 says 360. Both cite no source, and the accepted figure is about 366. A reader who checks will stop trusting the rest of the book.",
    suggestion: "Use 366 in both places and name the taxonomy you are following." },
  { title: "Same joke structure used in 14 consecutive entries",
    category: "Content", severity: "high", location: "Ch. 4, entries 31-44",
    excerpt: "And no, that is not a typo. Yes, really. We checked.",
    problem: "Fourteen entries in a row end on the same mock-disbelief beat. By the fourth the reader can predict the line, and the gag stops landing.",
    suggestion: "Keep three or four of the strongest and rewrite the rest to end on the fact itself." },
  { title: "Dated reference to periods will age badly",
    category: "Reader experience", severity: "medium", location: "Ch. 6",
    excerpt: "the sort of thing women only notice at that time of the month",
    problem: "The aside is not needed for the fact and reads as a dig. It narrows who feels welcome in a gift book meant for a wide audience.",
    suggestion: "Cut the clause. The sentence works without it." },
  { title: "Inconsistent capitalisation of common bird names",
    category: "Consistency", severity: "medium", location: "Throughout",
    excerpt: "the Ruby-throated hummingbird and the rufous Hummingbird",
    problem: "Bird names switch between title case and lower case, sometimes in the same sentence. Field guides pick one and hold it.",
    suggestion: "Use sentence case throughout except where a proper noun appears." },
  { title: "Missing serial commas in three-item lists",
    category: "Copyediting", severity: "low", location: "Ch. 1, Ch. 3",
    excerpt: "nectar, insects and tree sap",
    problem: "The book uses the serial comma elsewhere. These are the only places it drops.",
    suggestion: "Add the comma so the style is consistent." }
];

const browser = await chromium.launch();

for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${TAG}-1-upload-${scheme}.png`, fullPage: true });

  // Drive the real app into the issues screen with real state.
  await page.evaluate((issues) => {
    const t = document.querySelector("#title");
    t.value = "101 Hummingbird Facts";
    const paste = document.querySelector("#paste");
    paste.hidden = false;
    paste.value = "The hummingbird is the only bird that can fly backwards. ".repeat(400);
    paste.dispatchEvent(new Event("input", { bubbles: true }));
    window.__seed(issues);
  }, ISSUES);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${TAG}-2-issues-${scheme}.png`, fullPage: true });

  // A couple of decisions made, so the marked-up states show.
  await page.evaluate(() => window.__decide());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${TAG}-3-decided-${scheme}.png`, fullPage: true });

  await ctx.close();
}

// Mobile, light only.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/${TAG}-4-mobile-upload.png`, fullPage: true });
await page.evaluate((issues) => window.__seed(issues), ISSUES);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/${TAG}-5-mobile-issues.png`, fullPage: true });
await ctx.close();

await browser.close();
console.log("shots written:", TAG);
