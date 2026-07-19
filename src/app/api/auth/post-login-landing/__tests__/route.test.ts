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
