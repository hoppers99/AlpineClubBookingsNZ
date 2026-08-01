import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { fetchLivePrBody, selectPrBody } from "./pr-body.mjs";

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
  const headingIndex = body.indexOf(HEADING);
  if (headingIndex < 0) {
    throw new Error(`PR body must include ${HEADING}.`);
  }

  const afterHeading = body.slice(headingIndex + HEADING.length);
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
      throw new Error(
        `Concurrency declaration must complete "${field}:" or explicitly check N/A.`,
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
        ? execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
            encoding: "utf8",
          })
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
