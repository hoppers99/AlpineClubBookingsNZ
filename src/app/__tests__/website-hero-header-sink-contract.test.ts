import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract for #2819 (and #2818 decision 6): on every code-backed public hero,
 * the only value that may reach an HTML sink is the stored CMS header field —
 * admin HTML, sanitised on write and again on read. The sentence each page
 * COMPOSES for the empty-or-missing-row branch interpolates club identity, which
 * is free settings text no sanitiser has ever seen, so it must stay an escaped
 * React text child.
 *
 * The rendered-DOM suites — `website-page-header-fallback-render.test.tsx` and
 * `booking-request-pages-fallback-render.test.tsx` — pin the behaviour, and on
 * four of the five pages a restored sink is caught there by the live element the
 * markup-shaped club identity would create. `/contact` is the exception, and it
 * is why this file exists: its fallback interpolates nothing, so a restored sink
 * emits DOM identical apart from the element tag, and no escaping assertion can
 * see it. Leaving that page's only protection a `tagName` check plus a
 * hand-maintained "this page interpolates identity" flag meant two innocent edits
 * could reopen the #2819 hole with the whole suite green.
 *
 * Matching is on the SINK EXPRESSION — the source text after the `__html`
 * property key — never on a bare substring, so prose and comments may name
 * either identifier freely.
 */

const APP_ROOT = path.join(__dirname, "..");

/**
 * Every public hero that composes a fallback header. The three `(website)` pages
 * are #2819; the two `(website-dynamic)` form pages are #2818 and are included
 * because the rule the security surface doc states is one rule over all five, and
 * a contract that covered three of them would let the other two drift.
 */
const HERO_PAGES = [
  "(website)/join/page.tsx",
  "(website)/join/apply/page.tsx",
  "(website)/contact/page.tsx",
  "(website-dynamic)/booking-requests/page.tsx",
  "(website-dynamic)/school-bookings/page.tsx",
];

/**
 * The local each page assigns the stored, twice-sanitised field to (or `null`).
 * An allowlist rather than a ban, so a page that acquires a second sink fails
 * here and is triaged by a human, instead of passing because its new expression
 * happened to name neither identifier.
 */
const ALLOWED_SINK_EXPRESSIONS = ["storedHeaderHtml"];

/** The local holding the composed sentence, which must never reach a sink. */
const COMPOSED_FALLBACK = "fallbackHeaderText";

async function readAppFile(relative: string) {
  return fs.readFile(path.join(APP_ROOT, relative), "utf8");
}

/**
 * The source text of every HTML-sink expression in a file: what follows the
 * `__html` property key, up to the brace that closes the object literal, with
 * whitespace flattened and any trailing comma dropped so a wrapped expression
 * reads the same as a one-liner — Prettier wraps these attributes whenever the
 * class list grows, and that must not read as a new sink.
 *
 * Brace/paren depth is counted naively, so a literal brace inside a string could
 * over-extend a region. That errs toward a LONGER expression — a false positive a
 * human triages — never toward silently missing what a sink was handed. The probe
 * test below pins that this sees the shapes that matter.
 */
function sinkExpressions(source: string): string[] {
  const expressions: string[] = [];

  for (const match of source.matchAll(/__html\s*:/g)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let index = start;

    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{" || char === "(" || char === "[") {
        depth += 1;
      } else if (char === ")" || char === "]") {
        depth -= 1;
      } else if (char === "}") {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
    }

    expressions.push(
      source
        .slice(start, index)
        .trim()
        .replace(/\s+/g, " ")
        .replace(/,$/, "")
        .trim(),
    );
  }

  return expressions;
}

describe("public hero header HTML sink contract (#2819)", () => {
  it.each(HERO_PAGES)(
    "renders the composed fallback as a text child in %s",
    async (relative) => {
      const source = await readAppFile(relative);

      // Non-vacuity: the guard below is only worth anything while this page
      // really does compose a fallback under this name. A rename must come here
      // and be re-reasoned, not silently empty the contract.
      expect(
        source,
        `${relative} must compose its fallback into a \`${COMPOSED_FALLBACK}\` local`,
      ).toContain(`const ${COMPOSED_FALLBACK} =`);
      expect(
        source,
        `${relative} must render the fallback as a JSX text child`,
      ).toContain(`{${COMPOSED_FALLBACK}}`);
    },
  );

  it.each(HERO_PAGES)(
    "hands only the stored CMS field to an HTML sink in %s",
    async (relative) => {
      const source = await readAppFile(relative);
      const expressions = sinkExpressions(source);

      // Every one of these pages keeps exactly one sink, for the stored header.
      // An empty list would mean the extractor stopped seeing the page at all.
      expect(
        expressions.length,
        `${relative} names no HTML sink — has the hero markup moved?`,
      ).toBeGreaterThan(0);

      for (const expression of expressions) {
        expect(
          expression,
          [
            `${relative} hands \`${expression}\` to an HTML sink.`,
            "Only the stored, twice-sanitised PageContent header may be rendered",
            "that way; a sentence this application composes interpolates club",
            "identity that no sanitiser has seen, so it renders as an escaped",
            "text child (#2819).",
          ].join(" "),
        ).not.toContain(COMPOSED_FALLBACK);
        expect(
          ALLOWED_SINK_EXPRESSIONS,
          `${relative} introduces the unreviewed HTML sink \`${expression}\``,
        ).toContain(expression);
      }
    },
  );

  // The scan above is only protection if it really sees a restored sink, so its
  // reach is pinned here rather than assumed — the same reason the neutral-200
  // class scan in `app-theme-layout-contract.test.ts` carries a probe test. These
  // are the shapes a revert would take, including the two the rendered-DOM suite
  // cannot catch on /contact.
  it("sees a composed fallback wired into a sink, in every shape a revert takes", () => {
    const restored =
      '<p className="mt-4 max-w-2xl" dangerouslySetInnerHTML={{ __html: fallbackHeaderText }} />';
    expect(sinkExpressions(restored)).toEqual([COMPOSED_FALLBACK]);

    // Wrapped across lines, which is how Prettier formats it in these files.
    const wrapped = [
      "<div",
      '  className="mt-4"',
      "  dangerouslySetInnerHTML={{",
      "    __html: fallbackHeaderText,",
      "  }}",
      "/>",
    ].join("\n");
    expect(sinkExpressions(wrapped)).toEqual([COMPOSED_FALLBACK]);

    // Smuggled into one branch of a larger expression: reported whole, so the
    // `not.toContain` above still fires and the allowlist rejects it too.
    const coalesced =
      "<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml ?? fallbackHeaderText }} />";
    expect(sinkExpressions(coalesced)[0]).toContain(COMPOSED_FALLBACK);
    expect(ALLOWED_SINK_EXPRESSIONS).not.toContain(sinkExpressions(coalesced)[0]);

    // The current, correct shape is accepted — otherwise the contract would fail
    // for the wrong reason and stop being evidence of anything.
    expect(
      sinkExpressions(
        '<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml }} />',
      ),
    ).toEqual(["storedHeaderHtml"]);
  });
});
