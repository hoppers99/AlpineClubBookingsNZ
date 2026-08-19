import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  FAMILY_INVITE_RETURN_COOKIE,
  FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
} from "@/lib/family-invite-return-address";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

/**
 * #2827 — the proxy is what carries the family-invite post-login return address.
 *
 * The invite page's sign-in link is a plain `/login` anchor now, so the address
 * has to travel out of band and it has to survive with JavaScript switched off.
 * A server COMPONENT may not set a cookie during render, and the token only ever
 * reaches the server on a request whose URL contains it — so the response to the
 * invite page's own GET is the carrier, and that response is the proxy's.
 *
 * These cases assert the whole of that: the cookie is written, it carries the
 * exact path, it is `HttpOnly` (which is the entire point — a value on the page
 * would be readable by the CSS this fix exists to defend against), and it is
 * written on the invite page and nowhere else.
 *
 * The #2578 pairing is asserted in `csp-proxy.test.ts`, which owns that invariant
 * for both of the proxy's cookie writers.
 */

// Same pins as csp-proxy.test.ts: without a database the setup gate resolves
// "incomplete" and the module gate disables every optional module, and either
// short-circuit would answer these requests before the header block runs.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: async () => ({ isComplete: true, css: "" }),
}));

vi.mock("@/lib/module-settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/module-settings")>();
  const { MODULE_KEYS: keys } = await import("@/config/modules");

  return {
    ...original,
    loadEffectiveModuleFlags: async () =>
      Object.fromEntries(keys.map((key) => [key, true])) as FeatureFlags,
  };
});

import proxy from "../../proxy";

const TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

const INVITE_PATH = `/family-invite/${TOKEN}`;

function returnCookies(headers: Headers): string[] {
  return headers
    .getSetCookie()
    .filter((value) => value.startsWith(`${FAMILY_INVITE_RETURN_COOKIE}=`));
}

async function get(path: string, init?: RequestInit) {
  return proxy(new NextRequest(`https://example.org${path}`, init));
}

beforeEach(() => {
  // Not vacuous: every module on, so no gate answers ahead of the header block.
  expect(MODULE_KEYS.length).toBeGreaterThan(0);
});

describe("proxy family-invite return address (#2827)", () => {
  it("stamps the exact invite path on a GET of the invite page", async () => {
    const response = await get(INVITE_PATH);
    const [cookie, ...rest] = returnCookies(response.headers);

    expect(cookie, "the invite page must carry a return address").toBeTruthy();
    expect(rest, "one cookie, not several").toEqual([]);
    expect(cookie).toContain(`${FAMILY_INVITE_RETURN_COOKIE}=${INVITE_PATH};`);
  });

  it("writes it HttpOnly, SameSite=Lax, path-wide and short-lived", async () => {
    const [cookie] = returnCookies((await get(INVITE_PATH)).headers);

    // HttpOnly is the property the whole rework rests on. Without it the token
    // would be readable from `document.cookie`, which is a wider exposure than
    // the href this replaced.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${FAMILY_INVITE_RETURN_MAX_AGE_SECONDS}`);
  });

  it("stamps it for a SIGNED-IN visitor too — the wrong-account branch needs it", async () => {
    // That branch ("Sign in with a different account") is reached BY a signed-in
    // visitor, so gating the stamp on the absence of a session cookie would have
    // dropped the return address for the one case that most needs to come back.
    const response = await get(INVITE_PATH, {
      headers: { cookie: "authjs.session-token=abc" },
    });

    expect(returnCookies(response.headers)).toHaveLength(1);
  });

  it("normalises a trailing slash rather than missing the address", async () => {
    const [cookie] = returnCookies((await get(`${INVITE_PATH}/`)).headers);

    expect(cookie).toContain(`${FAMILY_INVITE_RETURN_COOKIE}=${INVITE_PATH};`);
  });

  it("ignores a query string, which the address has no use for", async () => {
    const [cookie] = returnCookies(
      (await get(`${INVITE_PATH}?utm_source=email`)).headers,
    );

    expect(cookie).toContain(`${FAMILY_INVITE_RETURN_COOKIE}=${INVITE_PATH};`);
    expect(cookie).not.toContain("utm_source");
  });

  it("writes nothing on any other address", async () => {
    // Deliberately includes the sibling (public) token routes: they render no
    // sign-in link, so a return address for them would be a cookie nobody reads,
    // carrying a bearer credential for no benefit.
    for (const path of [
      "/",
      "/login",
      "/dashboard",
      "/family-invite",
      "/family-invite/",
      `/family-invite/${TOKEN}/extra`,
      `/family-invite/${TOKEN.slice(0, 63)}`,
      `/family-invite/${TOKEN.toUpperCase()}`,
      `/pay/${TOKEN}`,
      `/chores/${TOKEN}`,
      `/membership-cancellation/${TOKEN}`,
      "/api/auth/post-login-landing",
    ]) {
      const response = await get(path);

      expect(returnCookies(response.headers), path).toEqual([]);
    }
  });

  it("writes nothing on a method that is not GET", async () => {
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
      const response = await get(INVITE_PATH, { method });

      expect(returnCookies(response.headers), method).toEqual([]);
    }
  });

  it("leaves the response cacheable by nobody but the browser", async () => {
    // The #2578 pairing, checked here as well as in csp-proxy.test.ts, because a
    // Set-Cookie carrying a bearer credential beside a shared-cache directive
    // would be strictly worse than the marker cookie that rule was written for.
    const response = await get(INVITE_PATH);
    const directive = response.headers.get("Cache-Control") ?? "";

    expect(returnCookies(response.headers)).toHaveLength(1);
    expect(directive).toContain("private");
    expect(directive).toContain("no-store");
    expect(directive).not.toContain("s-maxage");
    expect(directive).not.toContain("public");
  });
});
