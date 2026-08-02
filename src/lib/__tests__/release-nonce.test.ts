import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: mocks.error, warn: vi.fn(), info: vi.fn() },
}));

import {
  getPublicWebsiteNonce,
  RELEASE_ID_ENV_VAR,
  resetPublicWebsiteNonceCache,
  resolvePublicWebsiteNonce,
} from "@/lib/release-nonce";

/**
 * The fixed public-website CSP nonce (#2352 D1).
 *
 * The properties that matter are not "it returns a string" — they are the ones a
 * stored page's hydration depends on: the same release must always produce the same
 * value, two releases must not, and nothing about the release identifier may be
 * recoverable from what ends up in the page source.
 */
const RELEASE_A = "0123456789abcdef0123456789abcdef01234567";
const RELEASE_B = "fedcba9876543210fedcba9876543210fedcba98";

describe("public website release nonce (#2352 D1)", () => {
  beforeEach(() => {
    resetPublicWebsiteNonceCache();
    mocks.error.mockClear();
    delete process.env.RELEASE_ID;
    delete process.env.GIT_COMMIT_SHA;
  });

  afterEach(() => {
    resetPublicWebsiteNonceCache();
    delete process.env.RELEASE_ID;
    delete process.env.GIT_COMMIT_SHA;
  });

  it("names the environment variable the Dockerfile and CI set", () => {
    expect(RELEASE_ID_ENV_VAR).toBe("RELEASE_ID");
  });

  it("is STABLE for one release — the property a stored page depends on", async () => {
    process.env.RELEASE_ID = RELEASE_A;

    const first = await getPublicWebsiteNonce();
    resetPublicWebsiteNonceCache();
    const second = await getPublicWebsiteNonce();

    expect(second).toBe(first);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("CHANGES between releases, so a stored page cannot outlive its own policy", async () => {
    process.env.RELEASE_ID = RELEASE_A;
    const a = await getPublicWebsiteNonce();

    resetPublicWebsiteNonceCache();
    process.env.RELEASE_ID = RELEASE_B;
    const b = await getPublicWebsiteNonce();

    expect(b).not.toBe(a);
  });

  it("does not disclose the release identifier — the nonce is a digest", async () => {
    process.env.RELEASE_ID = RELEASE_A;

    const nonce = await getPublicWebsiteNonce();

    // Neither the value nor its hex/base64 forms appear in what ships in the page.
    expect(nonce).not.toContain(RELEASE_A);
    expect(nonce).not.toContain(RELEASE_A.slice(0, 12));
    expect(Buffer.from(nonce, "base64").toString("utf8")).not.toContain(RELEASE_A);
  });

  it("is a base64 value a CSP nonce source expression accepts", async () => {
    process.env.RELEASE_ID = RELEASE_A;

    const nonce = await getPublicWebsiteNonce();

    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // SHA-256 is 32 bytes, so well past the 128 bits a nonce is expected to carry.
    expect(Buffer.from(nonce, "base64")).toHaveLength(32);
  });

  it("falls back to GIT_COMMIT_SHA, which CI and the deploy runner already pass", async () => {
    process.env.GIT_COMMIT_SHA = RELEASE_A;

    const viaCommitSha = await resolvePublicWebsiteNonce();

    expect(viaCommitSha.source).toBe("commit-sha");
    expect(mocks.error).not.toHaveBeenCalled();

    // And RELEASE_ID wins when both are present, so a fork that sets only the
    // older arg still works while the intended variable stays authoritative.
    resetPublicWebsiteNonceCache();
    process.env.RELEASE_ID = RELEASE_B;
    const viaReleaseId = await resolvePublicWebsiteNonce();

    expect(viaReleaseId.source).toBe("release-id");
    expect(viaReleaseId.nonce).not.toBe(viaCommitSha.nonce);
  });

  it("treats a blank identifier as absent rather than as a value", async () => {
    process.env.RELEASE_ID = "   ";

    const resolved = await resolvePublicWebsiteNonce();

    expect(resolved.source).toBe("process-fallback");
  });

  it("LOGS AN ERROR and mints a per-process value when no identifier is readable", async () => {
    const resolved = await resolvePublicWebsiteNonce();

    expect(resolved.source).toBe("process-fallback");
    expect(resolved.nonce).toBeTruthy();
    // Loud on purpose: a multi-reader deployment on this path serves stored pages
    // that never hydrate, and the only other symptom is a blank screen.
    expect(mocks.error).toHaveBeenCalledTimes(1);

    // Per PROCESS, not per call — a value that changed between two responses of
    // the same process would break the page it had just stored.
    const again = await resolvePublicWebsiteNonce();
    expect(again.nonce).toBe(resolved.nonce);
  });

  it("memoises so concurrent first callers share one digest", async () => {
    process.env.RELEASE_ID = RELEASE_A;

    const [a, b, c] = await Promise.all([
      getPublicWebsiteNonce(),
      getPublicWebsiteNonce(),
      getPublicWebsiteNonce(),
    ]);

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(resolvePublicWebsiteNonce()).toBe(resolvePublicWebsiteNonce());
  });
});
