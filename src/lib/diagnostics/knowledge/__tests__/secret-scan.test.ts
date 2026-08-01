import { describe, expect, it } from "vitest";

import { scanForSecrets } from "../secret-scan";

// Synthetic secret SHAPES assembled at runtime from fragments, so no contiguous
// credential-looking literal is ever committed (which would trip the repo's own
// gitleaks gate). None of these is a real key.
const fakeAwsKey = `AKIA${"1234567890ABCDEF"}`; // AKIA + 16 chars
const fakePrivateKeyHeader = `${"-----BEGIN "}RSA ${"PRIV"}ATE KEY-----`;
const fakeAnthropicKey = `sk-${"ant"}-${"0123456789abcdefghijKL"}`;
const fakeStripeLive = `sk_${"live"}_${"0123456789abcdefABCDEF"}`;
const fakeGithubToken = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`; // ghp_ + 36

describe("scanForSecrets", () => {
  it("returns no findings for clean content", () => {
    expect(scanForSecrets("export const x = 1;\n// just code\n")).toEqual([]);
  });

  it("flags an AWS access key id shape", () => {
    const findings = scanForSecrets(`const key = "${fakeAwsKey}";\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("aws-access-key-id");
    expect(findings[0].line).toBe(1);
    // Preview is redacted — never the full token.
    expect(findings[0].preview).not.toContain(fakeAwsKey);
    expect(findings[0].preview.endsWith("…")).toBe(true);
  });

  it("flags a private key block, provider keys, and github tokens", () => {
    expect(scanForSecrets(fakePrivateKeyHeader)[0]?.rule).toBe(
      "private-key-block",
    );
    expect(scanForSecrets(`x=${fakeAnthropicKey}`)[0]?.rule).toBe(
      "anthropic-api-key",
    );
    expect(scanForSecrets(`x=${fakeStripeLive}`)[0]?.rule).toBe(
      "stripe-live-secret-key",
    );
    expect(scanForSecrets(`x=${fakeGithubToken}`)[0]?.rule).toBe("github-token");
  });

  it("flags a long quoted literal assigned to a secret-named key", () => {
    const line = `const client_secret = "${"abcdef0123456789ZZ"}";\n`;
    const findings = scanForSecrets(line);
    expect(findings.map((f) => f.rule)).toContain("assigned-secret-literal");
  });

  it("does NOT flag documented placeholders (example/redacted/etc.)", () => {
    // Same AWS shape but with an EXAMPLE marker inside the token region.
    expect(scanForSecrets(`AKIA${"IOSFODNN7EXAMPLE"}`)).toEqual([]);
    expect(
      scanForSecrets(`const secret = "your-${"secret-goes-here"}";`),
    ).toEqual([]);
    expect(
      scanForSecrets(`stripe = "sk_${"test"}_placeholder";`),
    ).toEqual([]);
    // A mock fixture value is not a live secret.
    expect(
      scanForSecrets(`access_token: "mock-access-token",`),
    ).toEqual([]);
  });

  it("STILL flags a real provider token even when 'mock' is in the span", () => {
    // The generic assigned-secret rule is exempted by 'mock', but the specific
    // AWS rule matches the token shape and is not.
    const line = `const mock_key = "AKIA${"1234567890ABCDEF"}";`;
    expect(scanForSecrets(line).map((f) => f.rule)).toContain(
      "aws-access-key-id",
    );
  });

  it("reports the correct 1-based line for a multi-line file", () => {
    const content = `line one\nline two\nkey = "${fakeAwsKey}"\n`;
    expect(scanForSecrets(content)[0]?.line).toBe(3);
  });
});
