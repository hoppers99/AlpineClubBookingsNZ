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
      "stripe-secret-key",
    );
    expect(scanForSecrets(`x=${fakeGithubToken}`)[0]?.rule).toBe("github-token");
  });

  it("flags a long quoted literal assigned to a secret-named key", () => {
    const line = `const client_secret = "${"abcdef0123456789ZZ"}";\n`;
    const findings = scanForSecrets(line);
    expect(findings.map((f) => f.rule)).toContain("assigned-secret-literal");
  });

  it("flags URL-embedded credentials (the DATABASE_URL connection shape)", () => {
    // Synthetic password assembled at runtime — never a real credential.
    const pw = `${"REAL"}${"PASS"}${"w0rd9Q"}`;
    const findings = scanForSecrets(`DATABASE_URL=postgres://u:${pw}@h:5432/db\n`);
    expect(findings.map((f) => f.rule)).toContain("url-embedded-credential");
    // Preview is redacted to the scheme prefix — the password never appears.
    expect(findings[0].preview).not.toContain(pw);
    expect(findings[0].preview.endsWith("…")).toBe(true);
  });

  it("flags an UNQUOTED high-entropy assignment to a secret-named key", () => {
    // Mixed-case + digits, length >= 16, assembled from fragments.
    const token = `${"aB3xK9mP2"}${"qR7sT1vW5yZ"}`;
    const findings = scanForSecrets(`SECRET_KEY=${token}\n`);
    expect(findings.map((f) => f.rule)).toContain("assigned-secret-literal");
  });

  it("does NOT flag a placeholder connection string (user:password@…)", () => {
    // Weak/dev passwords are documentation, not a leak.
    expect(scanForSecrets("postgres://user:password@localhost:5432/db")).toEqual(
      [],
    );
    expect(scanForSecrets("postgresql://user:pass@localhost/tacbookings")).toEqual(
      [],
    );
    expect(scanForSecrets("postgres://postgres:postgres@127.0.0.1/postgres")).toEqual(
      [],
    );
    expect(scanForSecrets("postgresql://codex:codex@127.0.0.1:5432/codex_local")).toEqual(
      [],
    );
    // A symbolic redaction is not a live password either.
    expect(scanForSecrets("mysql://root:***@db")).toEqual([]);
  });

  it("does NOT flag ordinary unquoted code assigned to a secret-named key", () => {
    // Code references / dotted identifiers must not read as literal secrets.
    expect(scanForSecrets("const secret = process.env.CLIENT_SECRET;")).toEqual(
      [],
    );
    expect(scanForSecrets("apiKey: config.provider.apiKeyValue")).toEqual([]);
  });

  it("does NOT flag a host:port URL that carries no userinfo", () => {
    // `://host:port/…` has no `user:password@`, so it is not a credential.
    expect(scanForSecrets("see https://example.com:8080/path for docs")).toEqual(
      [],
    );
  });

  it("does NOT flag documented placeholders (example/redacted/etc.)", () => {
    // Same AWS shape but with an EXAMPLE marker inside the token region.
    expect(scanForSecrets(`AKIA${"IOSFODNN7EXAMPLE"}`)).toEqual([]);
    expect(
      scanForSecrets(`const secret = "your-${"secret-goes-here"}";`),
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

  it("fails closed on a Stripe TEST/restricted/webhook shape EVEN as a placeholder", () => {
    // Regression for #2531: Trivy's `stripe-secret-token` rule flags
    // `(sk|rk)_(test|live|prod)_[10+ alnum]` with NO placeholder allowance, so a
    // doc "example" of that shape (`sk_test_placeholder`) shipped in the bundle
    // and failed `docker-image-security`. The bundle gate must therefore refuse
    // the identical shape regardless of any placeholder marker, or it re-ships.
    // Shapes assembled from fragments so no contiguous token is committed.
    const stripeTest = `sk_${"test"}_${"0123456789abcABCD"}`;
    expect(scanForSecrets(`x=${stripeTest}`).map((f) => f.rule)).toContain(
      "stripe-secret-key",
    );
    // The exact literal that tripped Trivy — a placeholder marker MUST NOT exempt it.
    expect(
      scanForSecrets(`a documented placeholder such as \`sk_${"test"}_placeholder\``).map(
        (f) => f.rule,
      ),
    ).toContain("stripe-secret-key");
    // Restricted test key + webhook signing secret, both fail closed too.
    expect(
      scanForSecrets(`x=rk_${"test"}_${"exampleKey0123456"}`).map((f) => f.rule),
    ).toContain("stripe-secret-key");
    expect(
      scanForSecrets(`STRIPE_WEBHOOK_SECRET=whsec_${"example0123456789"}`).map(
        (f) => f.rule,
      ),
    ).toContain("stripe-webhook-secret");
  });

  it("reports the correct 1-based line for a multi-line file", () => {
    const content = `line one\nline two\nkey = "${fakeAwsKey}"\n`;
    expect(scanForSecrets(content)[0]?.line).toBe(3);
  });
});
