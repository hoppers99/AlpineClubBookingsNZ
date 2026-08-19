import { describe, expect, it, vi } from "vitest";
import { isActionTokenFormat } from "@/lib/action-tokens";
import {
  FAMILY_INVITE_RETURN_COOKIE,
  FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
  getFamilyInviteReturnPath,
  serialiseFamilyInviteReturnCookie,
} from "@/lib/family-invite-return-address";

/**
 * #2827 — the family-invite post-login return address.
 *
 * The invite page's sign-in link used to be
 * `buildLoginPath('/family-invite/<token>')`, which rendered the invite token
 * into an `href` and so into the visitor's address bar, history and `Referer`.
 * (It did NOT expose the token to admin Raw CSS: that page's layout injects the
 * `appCss` variant, which excludes it — the module docblock records the correction
 * in full.) The token now travels in an `HttpOnly` cookie instead, and these cases
 * pin the two properties that makes safe: the value can only ever be an invite
 * page (so a planted cookie is neither an open redirect nor a general "land
 * anywhere" lever), and the cookie is genuinely unreadable from the page.
 */

/** A realistic 64-hex action token — the shape `issueActionToken` mints. */
const TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

const INVITE_PATH = `/family-invite/${TOKEN}`;

describe("getFamilyInviteReturnPath (#2827)", () => {
  it("accepts exactly the invite-page shape", () => {
    expect(getFamilyInviteReturnPath(INVITE_PATH)).toBe(INVITE_PATH);
  });

  it("refuses an absent value rather than inventing one", () => {
    expect(getFamilyInviteReturnPath(null)).toBeNull();
    expect(getFamilyInviteReturnPath(undefined)).toBeNull();
    expect(getFamilyInviteReturnPath("")).toBeNull();
  });

  it("refuses every off-origin shape — the open-redirect guard", () => {
    // Each one is an attempt to make a post-login redirect leave this origin, and
    // this case pins the PROPERTY — none of them survives — rather than which of
    // the two layers refuses it. Measured: today the anchored pattern refuses all
    // of them on its own, and getSafeInternalReturnPath() is the defence-in-depth
    // half that would take over if the pattern were ever loosened. See the
    // function's docblock, which says the same thing in the same words.
    for (const candidate of [
      `https://evil.example${INVITE_PATH}`,
      `http://evil.example${INVITE_PATH}`,
      `//evil.example${INVITE_PATH}`,
      `/\\evil.example${INVITE_PATH}`,
      `\\\\evil.example${INVITE_PATH}`,
      `javascript:alert(1)//${INVITE_PATH}`,
      `/%2fevil.example${INVITE_PATH}`,
      `/%5cevil.example${INVITE_PATH}`,
      `  ${INVITE_PATH}`,
      `${INVITE_PATH}\n`,
      `${INVITE_PATH}\u0000`,
    ]) {
      expect(getFamilyInviteReturnPath(candidate), candidate).toBeNull();
    }
  });

  it("refuses a SAFE internal path that is not an invite page", () => {
    // The second, narrower half — and the reason a planted cookie cannot steer a
    // member's landing anywhere in the application. Every one of these passes
    // getSafeInternalReturnPath() and must still be refused here.
    for (const candidate of [
      "/dashboard",
      "/admin/members",
      "/family-invite",
      "/family-invite/",
      `/family-invite/${TOKEN}/extra`,
      `/family-invite/${TOKEN.slice(0, 63)}`,
      `/family-invite/${TOKEN}f`,
      `/family-invite/${TOKEN.toUpperCase()}`,
      `/family-invite/${TOKEN.slice(0, 63)}z`,
      `/pay/${TOKEN}`,
      `/Family-Invite/${TOKEN}`,
      // The sanitiser PRESERVES a query string and a fragment, and this cookie has
      // no use for either — so a value carrying one is refused rather than trimmed.
      `${INVITE_PATH}?next=/admin`,
      `${INVITE_PATH}#x`,
    ]) {
      expect(getFamilyInviteReturnPath(candidate), candidate).toBeNull();
    }
  });

  it("keeps its token shape in step with ACTION_TOKEN_PATTERN", () => {
    // The pattern is duplicated rather than imported, because src/proxy.ts imports
    // this module and must not pull node:crypto into the middleware bundle. This
    // case is what makes that duplication safe: change the token format and it
    // fails here, instead of silently disabling the return address in production.
    for (const probe of [
      TOKEN,
      TOKEN.toUpperCase(),
      TOKEN.slice(0, 63),
      `${TOKEN}f`,
      "not-a-token",
      "",
    ]) {
      expect(
        getFamilyInviteReturnPath(`/family-invite/${probe}`) !== null,
        `token shape disagreement for ${JSON.stringify(probe)}`,
      ).toBe(isActionTokenFormat(probe));
    }
  });
});

describe("serialiseFamilyInviteReturnCookie (#2827)", () => {
  const cookie = serialiseFamilyInviteReturnCookie(
    INVITE_PATH,
    FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
  );

  it("carries the address under the documented name", () => {
    expect(cookie.startsWith(`${FAMILY_INVITE_RETURN_COOKIE}=${INVITE_PATH};`)).toBe(
      true,
    );
  });

  it("is HttpOnly — which is the whole mechanism", () => {
    // Without this attribute the fix buys nothing that mattered: the value would be
    // readable from `document.cookie` by any script on the page, and the point of
    // moving the token out of an href was to put it somewhere the page cannot see.
    expect(cookie).toContain("HttpOnly");
  });

  it("is SameSite=Lax and path-wide, so the login round trip still sends it", () => {
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("expires within ten minutes", () => {
    expect(FAMILY_INVITE_RETURN_MAX_AGE_SECONDS).toBe(600);
    expect(cookie).toContain(`Max-Age=${FAMILY_INVITE_RETURN_MAX_AGE_SECONDS}`);
  });

  it("expires as a past-dated overwrite with the same attributes, never a bare delete", () => {
    const cleared = serialiseFamilyInviteReturnCookie("", 0);

    expect(cleared).toContain(`${FAMILY_INVITE_RETURN_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Path=/");
  });

  it("is Secure in production and not in development", () => {
    // Not Secure in development for the same reason the #2352 marker cookie is not:
    // the app is served over plain http there and a Secure cookie would never be
    // stored at all, so the flow would silently stop working for every developer.
    const original = process.env.NODE_ENV;
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(serialiseFamilyInviteReturnCookie(INVITE_PATH, 600)).toContain("Secure");
      vi.stubEnv("NODE_ENV", "development");
      expect(
        serialiseFamilyInviteReturnCookie(INVITE_PATH, 600),
      ).not.toContain("Secure");
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(original);
    }
  });
});
