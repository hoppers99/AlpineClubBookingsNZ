import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HEADING = "## Concurrency And Lock Impact";

const REQUIRED_FIELDS = [
  "Writer class(es), canonical lock key(s), and acquisition order",
  "Immutable pre-lock key source and mutable under-lock re-read",
  "Status-guarded claim and proof that a lost claim runs no side effect",
  "Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence",
  "Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`)",
];

const SENSITIVE_PATH = /^(?:src\/(?:app\/api|lib)\/.*(?:booking|capacity|payment|refund|credit|settlement|waitlist|webhook|cron|xero|stripe|membership|member-lifecycle)|prisma\/schema\.prisma|prisma\/migrations\/)/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const sensitiveFiles = changedFiles.filter((file) => SENSITIVE_PATH.test(file));
    if (sensitiveFiles.length > 0) {
      throw new Error(
        `Concurrency declaration cannot use N/A for sensitive paths: ${sensitiveFiles.join(", ")}`,
      );
    }
    return;
  }

  for (const field of REQUIRED_FIELDS) {
    const fieldPattern = new RegExp(`^\\s*-\\s*${escapeRegex(field)}:\\s*(\\S.*)$`, "m");
    if (!fieldPattern.test(section)) {
      throw new Error(
        `Concurrency declaration must complete "${field}:" or explicitly check N/A.`,
      );
    }
  }

  const compatibilityPattern = new RegExp(
    `^\\s*-\\s*${escapeRegex(REQUIRED_FIELDS[3])}:\\s*(\\S.*)$`,
    "m",
  );
  const compatibilityEvidence = section.match(compatibilityPattern)?.[1] ?? "";
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
    validateConcurrencyDeclaration(process.env.PR_BODY ?? "", changedFiles);
    console.log("PR concurrency declaration is complete.");
  } catch (error) {
    console.error(`PR concurrency declaration check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
