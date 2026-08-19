import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// requireActiveSession re-verifies the member row (active / force-password
// flags); return an active member so the guard admits the mocked session.
const mockMemberFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: (...args: unknown[]) => mockMemberFindUnique(...args),
    },
  },
}));

// #2827: the route reads the family-invite return address from an HttpOnly
// cookie. Mocked at the reader rather than at `next/headers`, because `cookies()`
// throws outside a request scope and the reader is the seam the route depends on.
const mockReadReturnAddress = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/family-invite-return-address-cookie", () => ({
  readFamilyInviteReturnAddress: () => mockReadReturnAddress(),
}));

import {
  FAMILY_INVITE_RETURN_COOKIE,
  serialiseFamilyInviteReturnCookie,
} from "@/lib/family-invite-return-address";
import { GET } from "@/app/api/auth/post-login-landing/route";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

function session(user: Record<string, unknown>) {
  return { user: { id: "m1", ...user } };
}

function req(callbackUrl?: string) {
  const url = callbackUrl
    ? `http://localhost/api/auth/post-login-landing?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "http://localhost/api/auth/post-login-landing";
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindUnique.mockResolvedValue({
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
  });
  mockReadReturnAddress.mockResolvedValue(null);
});

describe("GET /api/auth/post-login-landing (#2090)", () => {
  it("401s an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("resolves an admin with no preference to their first accessible admin page", async () => {
    mockAuth.mockResolvedValue(
      session({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ overview: "edit", bookings: "edit" }),
      }),
    );
    const res = await GET(req());
    await expect(res.json()).resolves.toEqual({ path: "/admin/dashboard" });
  });

  it("honours a MEMBER_DASHBOARD preference for an admin", async () => {
    mockAuth.mockResolvedValue(
      session({
        postLoginLanding: "MEMBER_DASHBOARD",
        adminPermissionMatrix: matrix({ overview: "edit" }),
      }),
    );
    const res = await GET(req());
    await expect(res.json()).resolves.toEqual({ path: "/dashboard" });
  });

  it("lets a genuinely explicit callbackUrl win over the role default", async () => {
    mockAuth.mockResolvedValue(
      session({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ overview: "edit" }),
      }),
    );
    const res = await GET(req("/nominations/tok-9"));
    await expect(res.json()).resolves.toEqual({ path: "/nominations/tok-9" });
  });

  it("keeps a demoted admin with a stale ADMIN preference on a safe page", async () => {
    mockAuth.mockResolvedValue(
      session({
        postLoginLanding: "ADMIN_DASHBOARD",
        adminPermissionMatrix: matrix(),
      }),
    );
    const res = await GET(req());
    await expect(res.json()).resolves.toEqual({ path: "/dashboard" });
  });

  it("rejects an open-redirect callbackUrl and falls through to the role default", async () => {
    mockAuth.mockResolvedValue(
      session({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ overview: "edit" }),
      }),
    );
    const res = await GET(req("https://evil.example/phish"));
    await expect(res.json()).resolves.toEqual({ path: "/admin/dashboard" });
  });
});

/**
 * #2827 — this route is the terminal consumer of the family-invite return
 * address for the credential and magic-link flows: the client navigates to
 * whatever it answers. It is also the only one of the four resolution sites that
 * can CLEAR the cookie, `cookies()` being writable in a route handler and not in
 * a server component.
 */
describe("GET /api/auth/post-login-landing — family-invite return address (#2827)", () => {
  const TOKEN =
    "e7c1b93a5d0f4826" +
    "1af74c02be95d738" +
    "6b0d2e8149a3fc57" +
    "d4938e6017c2ba5f";
  const INVITE_PATH = `/family-invite/${TOKEN}`;

  function clearedCookies(res: Response) {
    return res.headers
      .getSetCookie()
      .filter((value) => value.startsWith(`${FAMILY_INVITE_RETURN_COOKIE}=`));
  }

  it("lands the member back on the exact invite path", async () => {
    mockAuth.mockResolvedValue(
      session({ postLoginLanding: null, adminPermissionMatrix: matrix() }),
    );
    mockReadReturnAddress.mockResolvedValue(INVITE_PATH);

    const res = await GET(req());

    await expect(res.json()).resolves.toEqual({ path: INVITE_PATH });
  });

  it("clears the cookie once it has been answered", async () => {
    mockAuth.mockResolvedValue(
      session({ postLoginLanding: null, adminPermissionMatrix: matrix() }),
    );
    mockReadReturnAddress.mockResolvedValue(INVITE_PATH);

    const res = await GET(req());

    expect(clearedCookies(res)).toEqual([
      serialiseFamilyInviteReturnCookie("", 0),
    ]);
  });

  it("clears it even when an explicit callbackUrl outranked it", async () => {
    // Otherwise a leftover address would steer the member's NEXT sign-in somewhere
    // they did not ask for, minutes later, with no visible cause.
    mockAuth.mockResolvedValue(
      session({ postLoginLanding: null, adminPermissionMatrix: matrix() }),
    );
    mockReadReturnAddress.mockResolvedValue(INVITE_PATH);

    const res = await GET(req("/bookings"));

    await expect(res.json()).resolves.toEqual({ path: "/bookings" });
    expect(clearedCookies(res)).toHaveLength(1);
  });

  it("degrades to the ordinary landing — and a 200 — when the cookie is gone", async () => {
    // An expired or absent address is the normal case for every member who did not
    // arrive from an invite. It must never be an error, and it must not write a
    // pointless expiry header either.
    mockAuth.mockResolvedValue(
      session({ postLoginLanding: null, adminPermissionMatrix: matrix() }),
    );
    mockReadReturnAddress.mockResolvedValue(null);

    const res = await GET(req());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ path: "/dashboard" });
    expect(clearedCookies(res)).toEqual([]);
  });
});
