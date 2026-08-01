/**
 * Secret scanner for the knowledge bundle (AID-3). Generation runs this over
 * EVERY candidate file and FAILS CLOSED — a file whose content matches any rule
 * is refused, never truncated-and-included — so a committed credential can
 * never reach the bundle (and, through it, Anthropic).
 *
 * This is a second, independent line to the repo's gitleaks gates
 * (`.gitleaks.toml`, `gitleaks-full-repo`/`gitleaks-pr-diff` in CI): those
 * guard what is committed; this guards what is EXTRACTED into a shipped
 * artifact. The rules are deliberately HIGH-PRECISION (provider-shaped tokens
 * and key blocks), not a generic entropy sweep, so a real deploy is not broken
 * by a false positive — while a genuine live key is still caught.
 *
 * The patterns match secret SHAPES only; no real secret appears in this file or
 * its tests. A documented placeholder (`sk_test_placeholder`, `AKIAEXAMPLE…`,
 * `...redacted...`) is NOT a leak — the allowlist below mirrors the gitleaks
 * placeholder allowance so docs that SHOW a token shape stay buildable.
 */

export interface SecretFinding {
  /** Which rule matched (stable identifier, safe to log). */
  rule: string;
  /** 1-based line number of the match. */
  line: number;
  /**
   * A redacted preview of the match — first 4 chars then `…`, never the full
   * secret — so a finding is safe to surface in a build log or error.
   */
  preview: string;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

/**
 * Substrings that mark a match as a documented PLACEHOLDER rather than a live
 * secret. Case-insensitive. Kept aligned with `.gitleaks.toml`'s allowance.
 */
const PLACEHOLDER_MARKERS = [
  "placeholder",
  "example",
  "redacted",
  "changeme",
  "your-",
  "your_",
  "dummy",
  "sample",
  "xxxxxxxx",
  "notreal",
  "fake",
  // A "mock"-labelled value is a fixture, not a live secret (e.g. the test-only
  // `mock-access-token` in the Xero mock route). Real provider secrets are still
  // caught: their specific rules (AWS/Stripe/Anthropic/…) match the token SHAPE,
  // whose own match text never contains these markers, so this exemption only
  // relaxes the generic `assigned-secret-literal` catch-all.
  "mock",
];

/**
 * HIGH-PRECISION rules. Each matches a token shape distinctive enough that a
 * match is almost certainly a real credential. Ordered roughly by specificity.
 */
const SECRET_RULES: SecretRule[] = [
  // PEM private key blocks of any flavour (RSA/EC/OPENSSH/PGP/generic).
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  // AWS access key ids (long-term AKIA / temporary ASIA).
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // Stripe live secret / restricted keys (test keys are ignored on purpose).
  { id: "stripe-live-secret-key", pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/ },
  // Anthropic API keys.
  { id: "anthropic-api-key", pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  // Google API keys.
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // GitHub personal-access / OAuth / app tokens.
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/ },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  // Slack tokens.
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  // Generic assignment of a long quoted literal to a secret-named key. Requires
  // a quoted value of >=16 chars so ordinary code (a field NAMED `password`, a
  // short label) is not swept up; placeholder markers exempt documented values.
  {
    id: "assigned-secret-literal",
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["'\s]*[:=]\s*["'][^"'\n]{16,}["']/i,
  },
];

function isPlaceholder(matchText: string): boolean {
  const lower = matchText.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

function redact(matchText: string): string {
  const head = matchText.slice(0, 4);
  return `${head}…`;
}

/**
 * Scan text for credential shapes. Returns every finding (empty ⇒ clean). The
 * caller (`generate.ts`) treats a non-empty result as FATAL and refuses to emit
 * the bundle. Line numbers are 1-based against the already-normalized content.
 */
export function scanForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (match && !isPlaceholder(match[0])) {
        findings.push({
          rule: rule.id,
          line: i + 1,
          preview: redact(match[0]),
        });
      }
    }
  }
  return findings;
}
