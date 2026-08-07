import { pathToFileURL } from "node:url";

import { fetchLivePrBody, gitDiffChangedFiles, selectPrBody } from "./pr-body.mjs";

const HEADING = "## Concurrency And Lock Impact";

const GATE_LABEL = "PR concurrency declaration check";

export const REQUIRED_FIELDS = [
  "Writer class(es), canonical lock key(s), and acquisition order",
  "Immutable pre-lock key source and mutable under-lock re-read",
  "Status-guarded claim and proof that a lost claim runs no side effect",
  "Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence",
  "Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`)",
];

const SENSITIVE_PATH = /^(?:src\/(?:app\/api|lib)\/.*(?:booking|capacity|payment|refund|credit|settlement|waitlist|webhook|cron|xero|stripe|membership|member-lifecycle)|prisma\/schema\.prisma|prisma\/migrations\/)/i;

// Pure test/spec files never move money, capacity, or lifecycle state, so they
// must not force a full concurrency declaration. Filter them out before the
// sensitive-path check: a test-only PR may legitimately check N/A, while a PR
// that also touches real sensitive source still needs the full declaration.
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match a required field bullet whose value sits on the SAME line as its label.
// Horizontal-whitespace classes (`[^\S\r\n]`) keep `\s` from swallowing the
// newline(s) after an empty bullet and capturing the next bullet as the value;
// the trailing `\r?` tolerates GitHub's CRLF-stored PR bodies. A value of only
// whitespace fails because the capture must start with `\S`.
function fieldValuePattern(field) {
  return new RegExp(
    `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:[^\\S\\r\\n]*(\\S[^\\r\\n]*?)[^\\S\\r\\n]*\\r?$`,
    "m",
  );
}

export function validateConcurrencyDeclaration(body, changedFiles = []) {
  // Anchor to the START OF A LINE. A plain indexOf also matches the heading text
  // quoted inside prose or a code span — and a PR body that explains this gate
  // will quote it. When that mention comes first, the "section" starts there and
  // runs to the next `## `, so the real declaration below is never read and every
  // field reports missing. Found exactly that way: this gate's own PR body.
  const headingMatch = new RegExp(
    `^[^\\S\\r\\n]*${escapeRegex(HEADING)}[^\\S\\r\\n]*\\r?$`,
    "m",
  ).exec(body);
  if (!headingMatch) {
    throw new Error(`PR body must include ${HEADING}.`);
  }

  const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIndex = afterHeading.search(/\n##\s+/);
  const section = nextHeadingIndex >= 0 ? afterHeading.slice(0, nextHeadingIndex) : afterHeading;

  if (/^\s*-\s*\[[xX]\]\s*N\/A\b/m.test(section)) {
    const sensitiveFiles = changedFiles.filter(
      (file) => !TEST_FILE.test(file) && SENSITIVE_PATH.test(file),
    );
    if (sensitiveFiles.length > 0) {
      throw new Error(
        `Concurrency declaration cannot use N/A for sensitive paths: ${sensitiveFiles.join(", ")}`,
      );
    }
    return;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fieldValuePattern(field).test(section)) {
      // Say WHY, not just WHICH. The overwhelmingly common cause is a value
      // wrapped onto the line below its label, which reads as an empty field —
      // and an author who is told only "complete this field" while looking at a
      // field they believe they completed will re-guess the format, burning a
      // full CI cycle per attempt. Naming the same-line rule here is what makes
      // this failure self-correcting on the first try.
      const labelPresent = new RegExp(
        `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:`,
        "m",
      ).test(section);
      throw new Error(
        labelPresent
          ? `Concurrency declaration field "${field}:" has no value on its own line. ` +
            "Put the value on the SAME line as the label — a value wrapped onto the " +
            "following line reads as empty. Continuation lines after that first " +
            "line are fine. Check it before pushing with: npm run pr:check -- <body-file>"
          : `Concurrency declaration must complete "${field}:" or explicitly check N/A. ` +
            "Copy the field list verbatim from .github/pull_request_template.md — the " +
            "labels are matched exactly. Check it before pushing with: " +
            "npm run pr:check -- <body-file>",
      );
    }
  }

  const compatibilityEvidence = section.match(fieldValuePattern(REQUIRED_FIELDS[3]))?.[1] ?? "";
  if (!/#\d+/.test(compatibilityEvidence)) {
    throw new Error(
      "Concurrency compatibility evidence must identify at least one reviewed open or last-10 PR number.",
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    const changedFiles =
      base && head
        ? gitDiffChangedFiles(base, head)
            .split(/\r?\n/)
            .filter(Boolean)
        : [];
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: process.env.PR_BODY });
    validateConcurrencyDeclaration(body, changedFiles);
    console.log("PR concurrency declaration is complete.");
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
