import { describe, expect, it, vi } from "vitest";
import { isActionTokenFormat } from "@/lib/action-tokens";
import {
  appendFamilyInviteReturnParam,
  buildFamilyInviteLoginPath,
  buildFamilyInviteReturnCookieValue,
  createFamilyInviteReturnNonce,
  FAMILY_INVITE_RETURN_COOKIE,
  FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
  FAMILY_INVITE_RETURN_PARAM,
  getFamilyInviteReturnNonce,
  getFamilyInviteReturnPath,
  matchFamilyInviteReturnCookie,
  parseFamilyInviteReturnCookie,
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
 *
 * #2974 added the third property, and it is the one that closes the residual #2827
 * left open: the address is honoured only for the TAB that opened the invitation.
 * A cookie is per-browser, so before this, somebody who opened an invitation on a
 * shared lodge or kiosk browser and walked away WITHOUT signing in handed the next
 * person to sign in that landing — the invited email address and the family-group
 * name on their screen. The nonce cases below are that fix at its narrowest point.
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

  it("expires within two minutes", () => {
    // Two minutes, not the ten this shipped at first. #2974 re-examined the figure
    // once tab scoping closed the disclosure the shortening was mitigating, and
    // KEPT it: the window covers "load /login, type an email and a password,
    // submit" and nothing longer, because every landing site reads the cookie
    // during the first authenticated page load — entering a 2FA code happens after
    // /login/verify has already resolved the landing. Pinned by value, not just by
    // the constant, so changing it is a deliberate edit here. (Earlier revisions
    // credited the two minutes to an owner decision of 19 Aug 2026; no such comment
    // exists on #2827 or PR #2970. The owner did make the call — it was made in
    // session and never written down as a dated comment.)
    expect(FAMILY_INVITE_RETURN_MAX_AGE_SECONDS).toBe(120);
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
      expect(
        serialiseFamilyInviteReturnCookie(
          INVITE_PATH,
          FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
        ),
      ).toContain("Secure");
      vi.stubEnv("NODE_ENV", "development");
      expect(
        serialiseFamilyInviteReturnCookie(
          INVITE_PATH,
          FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
        ),
      ).not.toContain("Secure");
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(original);
    }
  });
});

/**
 * #2974 — the tab-binding nonce, tested at the level where the whole property
 * lives: a cookie value plus a presented nonce either agree or they do not.
 */
describe("family-invite tab-binding nonce (#2974)", () => {
  const NONCE = "3f9c17ae42b0d85610c73fe29ab4d051";
  const OTHER_NONCE = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const COOKIE_VALUE = `${NONCE}.${INVITE_PATH}`;

  describe("createFamilyInviteReturnNonce", () => {
    it("mints 32 lowercase hex characters", () => {
      expect(createFamilyInviteReturnNonce()).toMatch(/^[0-9a-f]{32}$/);
    });

    it("mints a different value every time", () => {
      // A repeated nonce would make the binding meaningless: a second tab could
      // present a value it had seen before and be honoured.
      const minted = new Set(
        Array.from({ length: 50 }, () => createFamilyInviteReturnNonce()),
      );

      expect(minted.size).toBe(50);
    });

    it("mints a value its own shape guard accepts", () => {
      expect(getFamilyInviteReturnNonce(createFamilyInviteReturnNonce())).not.toBeNull();
    });
  });

  describe("getFamilyInviteReturnNonce", () => {
    it("accepts exactly the minted shape, and the first of an array", () => {
      expect(getFamilyInviteReturnNonce(NONCE)).toBe(NONCE);
      expect(getFamilyInviteReturnNonce([NONCE, OTHER_NONCE])).toBe(NONCE);
    });

    it("refuses everything else", () => {
      for (const candidate of [
        null,
        undefined,
        "",
        " ",
        NONCE.slice(0, 31),
        `${NONCE}0`,
        NONCE.toUpperCase(),
        `${NONCE} `,
        `${NONCE}\n`,
        ".*",
        "../../admin",
        `${NONCE}.${INVITE_PATH}`,
        [],
      ] as (string | string[] | null | undefined)[]) {
        expect(
          getFamilyInviteReturnNonce(candidate),
          JSON.stringify(candidate),
        ).toBeNull();
      }
    });
  });

  describe("buildFamilyInviteReturnCookieValue / parseFamilyInviteReturnCookie", () => {
    it("round-trips a nonce and an invite path", () => {
      const value = buildFamilyInviteReturnCookieValue(NONCE, INVITE_PATH);

      expect(value).toBe(COOKIE_VALUE);
      expect(parseFamilyInviteReturnCookie(value)).toEqual({
        nonce: NONCE,
        path: INVITE_PATH,
      });
    });

    it("refuses to build a value no consumption site could ever match", () => {
      // Writing an unmatchable cookie would look like the feature working right up
      // until it silently did not; writing nothing degrades visibly to the ordinary
      // landing instead.
      expect(buildFamilyInviteReturnCookieValue("not-a-nonce", INVITE_PATH)).toBeNull();
      expect(buildFamilyInviteReturnCookieValue(NONCE, "/dashboard")).toBeNull();
      expect(
        buildFamilyInviteReturnCookieValue(NONCE, `https://evil.example${INVITE_PATH}`),
      ).toBeNull();
    });

    it("refuses a pre-#2974 cookie, which carried a bare path and no nonce", () => {
      // The deploy case: an in-flight visitor holding an old cookie degrades to
      // their ordinary landing for the two minutes it survives.
      expect(parseFamilyInviteReturnCookie(INVITE_PATH)).toBeNull();
    });

    it("refuses a malformed value rather than half-parsing it", () => {
      for (const candidate of [
        null,
        undefined,
        "",
        NONCE,
        `${NONCE}.`,
        `.${INVITE_PATH}`,
        `${NONCE}.${INVITE_PATH}.extra`,
        `${NONCE}.//evil.example${INVITE_PATH}`,
        `${NONCE}./dashboard`,
        `${NONCE.toUpperCase()}.${INVITE_PATH}`,
      ]) {
        expect(
          parseFamilyInviteReturnCookie(candidate),
          String(candidate),
        ).toBeNull();
      }
    });
  });

  describe("matchFamilyInviteReturnCookie — the binding itself", () => {
    it("returns the path when the presented nonce is the cookie's own", () => {
      expect(matchFamilyInviteReturnCookie(COOKIE_VALUE, NONCE)).toBe(INVITE_PATH);
    });

    /**
     * THE #2974 PROPERTY. This is the shared-kiosk case reduced to one assertion:
     * the cookie is alive, the person signing in did not open the invitation, so
     * they present nothing and are told nothing.
     */
    it("returns null when no nonce is presented — the shared-kiosk case", () => {
      for (const presented of [null, undefined, ""]) {
        expect(
          matchFamilyInviteReturnCookie(COOKIE_VALUE, presented),
          String(presented),
        ).toBeNull();
      }
    });

    it("returns null for a nonce from another tab", () => {
      expect(matchFamilyInviteReturnCookie(COOKIE_VALUE, OTHER_NONCE)).toBeNull();
    });

    it("refuses a prefix, a suffix, a case change and a regex metacharacter", () => {
      for (const presented of [
        NONCE.slice(0, 31),
        `${NONCE}0`,
        NONCE.toUpperCase(),
        `${NONCE.slice(0, 31)}f`,
        ".*",
        `${NONCE} `,
      ]) {
        expect(
          matchFamilyInviteReturnCookie(COOKIE_VALUE, presented),
          presented,
        ).toBeNull();
      }
    });

    it("still refuses an off-origin or non-invite path even with the right nonce", () => {
      // The nonce is a tab binding, never an authorisation to land anywhere: the
      // shape guard is applied to the cookie's path regardless.
      for (const path of [
        `https://evil.example${INVITE_PATH}`,
        `//evil.example${INVITE_PATH}`,
        "/admin/members",
        "/dashboard",
        `${INVITE_PATH}?next=/admin`,
      ]) {
        expect(
          matchFamilyInviteReturnCookie(`${NONCE}.${path}`, NONCE),
          path,
        ).toBeNull();
      }
    });
  });

  it("keeps the parameter NAME in step with the pages that spell it literally", () => {
    // `/login`, `/login/verify` and `/login/enroll` declare their `searchParams`
    // type with the key written out — `inviteReturn?: string | string[]` — because
    // a TypeScript object-literal type cannot take a computed key from a const the
    // way an object value can. So renaming this constant without renaming those
    // three declarations would leave the nonce silently unread at every landing
    // site, and the address would just stop working. Pinned by value, which is the
    // cheapest thing that turns that into a failing test.
    expect(FAMILY_INVITE_RETURN_PARAM).toBe("inviteReturn");
  });

  describe("buildFamilyInviteLoginPath / appendFamilyInviteReturnParam", () => {
    it("puts the nonce — and only the nonce — on the sign-in address", () => {
      const built = buildFamilyInviteLoginPath(NONCE);

      expect(built).toBe(`/login?${FAMILY_INVITE_RETURN_PARAM}=${NONCE}`);
      expect(built).not.toContain(TOKEN);
      expect(built).not.toContain("family-invite");
      expect(built).not.toContain("callbackUrl");
    });

    it("falls back to a plain /login for an absent or malformed nonce", () => {
      for (const candidate of [null, undefined, "", "../../admin", `"><script>`]) {
        expect(buildFamilyInviteLoginPath(candidate), String(candidate)).toBe(
          "/login",
        );
      }
    });

    it("appends the nonce to a detour hop's query, and drops a bad one", () => {
      const params = new URLSearchParams({ callbackUrl: "/bookings" });
      appendFamilyInviteReturnParam(params, NONCE);

      expect(params.get(FAMILY_INVITE_RETURN_PARAM)).toBe(NONCE);

      const rejected = new URLSearchParams();
      appendFamilyInviteReturnParam(rejected, "../../admin");

      expect(rejected.toString()).toBe("");
    });
  });
});
