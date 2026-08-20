import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

vi.mock("server-only", () => ({}));

// Every write to the images tree clears the stored public pages, because
// `{{photo-gallery}}` resolves its file list server-side. `revalidatePath` needs
// a static-generation store no unit test has, so the shared helper is stubbed;
// its contents are pinned by public-content-invalidation-contract.test.ts.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

// The route does `import fs from "fs/promises"` — mock the default so the
// filesystem is never touched. `resolveInImagesRoot` and `isSafeDirectoryName`
// stay REAL (pure path/string computations), so the containment barrier is
// exercised exactly as production runs it. The assertions below therefore turn
// on whether a sink was CALLED, which is the only thing that matters for a
// path-containment guard.
vi.mock("fs/promises", () => ({
  default: {
    mkdir: mocks.mkdir,
    rename: mocks.rename,
    rm: mocks.rm,
    readdir: mocks.readdir,
  },
  mkdir: mocks.mkdir,
  rename: mocks.rename,
  rm: mocks.rm,
  readdir: mocks.readdir,
}));

import {
  DELETE,
  PATCH,
  POST,
} from "@/app/api/admin/image-manager/directories/route";
import { IMAGES_ROOT } from "@/lib/image-storage";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/image-manager/directories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
});

// #2841, CodeQL js/path-injection alerts 32/33/34. The `name` charset filter
// banned separators and shell metacharacters but NOT dots, so ".." reached
// path.join. On create with a nested parent that walked back to IMAGES_ROOT and
// the containment check's `newAbs !== IMAGES_ROOT` short-circuit let it through
// to mkdir; on rename, "." resolved a nested directory onto its own parent,
// passed containment, and reached fs.rename. Neither destroyed data — mkdir got
// EEXIST, rename fails at the OS layer — but the barrier was one refactor from
// mattering, and both returned the wrong status.
describe("image-manager directories route: dot-only name containment", () => {
  describe("POST (create)", () => {
    it("creates an ordinary nested directory", async () => {
      const res = await POST(
        jsonRequest({ parent: "trips", name: "winter-2026" }) as never,
      );

      expect(res.status).toBe(200);
      expect(mocks.mkdir).toHaveBeenCalledWith(
        path.join(IMAGES_ROOT, "trips", "winter-2026"),
      );
    });

    it('rejects name ".." under a nested parent, and never calls mkdir', async () => {
      // The regression: parent "trips" made newAbs === IMAGES_ROOT, which the
      // old `newAbs !== IMAGES_ROOT &&` guard read as "contained".
      const res = await POST(
        jsonRequest({ parent: "trips", name: ".." }) as never,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Invalid directory name",
      });
      expect(mocks.mkdir).not.toHaveBeenCalled();
    });

    it('rejects name ".." at the root, and never calls mkdir', async () => {
      const res = await POST(jsonRequest({ parent: "", name: ".." }) as never);

      expect(res.status).toBe(400);
      expect(mocks.mkdir).not.toHaveBeenCalled();
    });

    it('rejects name "." (which would re-create the parent)', async () => {
      const res = await POST(
        jsonRequest({ parent: "trips", name: "." }) as never,
      );

      expect(res.status).toBe(400);
      expect(mocks.mkdir).not.toHaveBeenCalled();
    });

    it("still rejects a separator in the name", async () => {
      for (const name of ["../escape", "a/b", "a\\b"]) {
        vi.clearAllMocks();
        mocks.auth.mockResolvedValue(adminSession);
        mocks.requireActiveSessionUser.mockResolvedValue(null);

        const res = await POST(jsonRequest({ parent: "", name }) as never);

        expect(res.status, name).toBe(400);
        expect(mocks.mkdir, name).not.toHaveBeenCalled();
      }
    });

    it("rejects a parent that escapes the images root", async () => {
      const res = await POST(
        jsonRequest({ parent: "../../etc", name: "evil" }) as never,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Invalid parent path",
      });
      expect(mocks.mkdir).not.toHaveBeenCalled();
    });

    it("never lets a created directory be the images root itself", async () => {
      // Strict containment: mkdir's target must always be strictly BELOW the
      // root. Whatever the inputs, no accepted request may target the root.
      for (const body of [
        { parent: "", name: "." },
        { parent: "trips", name: ".." },
        { parent: "trips/summer", name: ".." },
      ]) {
        vi.clearAllMocks();
        mocks.auth.mockResolvedValue(adminSession);
        mocks.requireActiveSessionUser.mockResolvedValue(null);

        await POST(jsonRequest(body) as never);

        for (const call of mocks.mkdir.mock.calls) {
          expect(String(call[0]).startsWith(IMAGES_ROOT + path.sep)).toBe(true);
        }
      }
    });
  });

  describe("PATCH (rename)", () => {
    it("renames an ordinary directory", async () => {
      const res = await PATCH(
        jsonRequest({ path: "trips/winter", newName: "winter-2026" }) as never,
      );

      expect(res.status).toBe(200);
      expect(mocks.rename).toHaveBeenCalledWith(
        path.join(IMAGES_ROOT, "trips", "winter"),
        path.join(IMAGES_ROOT, "trips", "winter-2026"),
      );
    });

    it('rejects newName "." and never calls rename', async () => {
      // The real regression on this endpoint: dirname("<root>/trips/winter") is
      // "<root>/trips", and path.join("<root>/trips", ".") is "<root>/trips" —
      // which passes the startsWith containment check. fs.rename would then be
      // asked to move a directory onto its own parent.
      const res = await PATCH(
        jsonRequest({ path: "trips/winter", newName: "." }) as never,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Invalid directory name",
      });
      expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('rejects newName ".." and never calls rename', async () => {
      const res = await PATCH(
        jsonRequest({ path: "trips/winter", newName: ".." }) as never,
      );

      expect(res.status).toBe(400);
      expect(mocks.rename).not.toHaveBeenCalled();
    });

    it("never lets a rename target leave the images root", async () => {
      for (const body of [
        { path: "trips/winter", newName: "." },
        { path: "trips/winter", newName: ".." },
        { path: "trips", newName: ".." },
        { path: "trips", newName: "../escape" },
      ]) {
        vi.clearAllMocks();
        mocks.auth.mockResolvedValue(adminSession);
        mocks.requireActiveSessionUser.mockResolvedValue(null);

        await PATCH(jsonRequest(body) as never);

        for (const call of mocks.rename.mock.calls) {
          expect(String(call[1]).startsWith(IMAGES_ROOT + path.sep)).toBe(true);
        }
      }
    });

    it("refuses to rename the root itself", async () => {
      const res = await PATCH(
        jsonRequest({ path: "", newName: "anything" }) as never,
      );

      expect(res.status).toBe(400);
      expect(mocks.rename).not.toHaveBeenCalled();
    });
  });

  // DELETE takes no name, only a path, so it was never part of the dot-only
  // defect. It is covered here because #2841 replaced its hand-rolled body
  // narrowing with the shared `readStringField` helper, and a parsing helper
  // that quietly returns "" for a field it should have read would turn a real
  // delete into "Cannot delete the root directory".
  describe("DELETE (remove)", () => {
    it("removes a contained directory recursively", async () => {
      const res = await DELETE(jsonRequest({ path: "trips/winter" }) as never);

      expect(res.status).toBe(200);
      expect(mocks.rm).toHaveBeenCalledWith(
        path.join(IMAGES_ROOT, "trips", "winter"),
        { recursive: true },
      );
    });

    it("refuses an empty path, a non-string path and an escaping path", async () => {
      for (const body of [{}, { path: "" }, { path: 42 }, { path: "../../etc" }]) {
        vi.clearAllMocks();
        mocks.auth.mockResolvedValue(adminSession);
        mocks.requireActiveSessionUser.mockResolvedValue(null);

        const res = await DELETE(jsonRequest(body) as never);

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(mocks.rm, JSON.stringify(body)).not.toHaveBeenCalled();
      }
    });
  });

  it("keeps the endpoints behind content:edit", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "m-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });

    const created = await POST(
      jsonRequest({ parent: "", name: "sneaky" }) as never,
    );
    expect(created.status).toBe(403);
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });
});
