// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The page reads the session permission matrix for view-only gating; give it an
// edit-level admin so the restore control is live (the view-only path is
// covered by the shared ViewOnlyActionButton contract).
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import AdminDisplayTemplatesPage from "./page";

// #2247. Two complaints, one screen:
//
//  1. An install whose database predates the lobby-display feature has no
//     `builtin-*` rows — nothing but the seed ever creates them, and no upgrade
//     runs the seed. The gallery was simply blank, with no cause named and no
//     way out. It must now name WHICH of the three causes applies and offer the
//     restore.
//  2. The restore is a CONVERGENT re-seed: it rewrites every built-in from
//     code. It must state that before it runs.

/**
 * Templates GET answers with `status`; everything else is benign. `status: 0`
 * means the fetch itself REJECTS, the transport failure that used to hang the
 * page on "Loading…" for ever.
 */
function installFetch(status: number, templates: unknown[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url === "/api/admin/display/templates" && method === "GET") {
      if (status === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(status === 200 ? { templates } : {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/display/built-ins/restore" && method === "POST") {
      return json({ layouts: 7, templates: 7 });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Display templates — empty state names the cause (#2247)", () => {
  it("a successful but empty list is the never-seeded case, and offers the restore", async () => {
    installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/not even the built-in boards/i);
    expect(screen.getByText(/does not re-run the seed/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Restore built-in boards" })
    ).toBeDefined();
    // It must not blame a cause that did not happen.
    expect(screen.queryByText(/switched off/i)).toBeNull();
    expect(screen.queryByText(/403/)).toBeNull();
  });

  it("a 403 is reported as a permission problem, not an empty database", async () => {
    installFetch(403);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/can’t see the display templates/i);
    expect(screen.getByText(/lodge view/i)).toBeDefined();
    // Honest about the inference: the browser is never told which permission.
    expect(screen.getByText(/not which permission was missing/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  it("a 404 is reported as the module being off, not an empty database", async () => {
    installFetch(404);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/module looks switched off/i);
    expect(screen.getByText(/Admin → Setup → Modules/)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  it("an unexplained failure is named as unknown rather than guessed at", async () => {
    installFetch(500);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/could not be loaded/i);
    expect(screen.getByText(/did not say why/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
    expect(screen.queryByText(/module looks switched off/i)).toBeNull();
  });

  it("a 401 is reported as an expired session", async () => {
    installFetch(401);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/session has expired/i);
    expect(screen.getByText(/sign in again/i)).toBeDefined();
    expect(screen.queryByText(/not even the built-in boards/i)).toBeNull();
  });

  // The page used to leave "Loading…" up for ever when the fetch rejected —
  // the very blank screen this issue removes.
  it("a transport failure ends the loading state and names the connection", async () => {
    installFetch(0);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByText(/could not be fetched/i);
    expect(screen.getByText(/never reached the server/i)).toBeDefined();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  // In these states the POST fails by construction — the same proxy, guard or
  // transport that refused the list refuses the restore — and the copy tells
  // the operator to do something else first.
  it.each([
    ["module off", 404],
    ["forbidden", 403],
    ["signed out", 401],
    ["unreachable", 0],
    ["server error", 500],
  ])("does not offer a restore that cannot work (%s)", async (_label, status) => {
    installFetch(status);
    render(<AdminDisplayTemplatesPage />);

    await screen.findByRole("button", { name: "New template" });
    expect(
      screen.queryByRole("button", { name: "Restore built-in boards" })
    ).toBeNull();
  });
});

describe("Restore built-in boards (#2247)", () => {
  it("warns that existing built-ins are overwritten before it runs", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/OVERWRITTEN/);
    expect(dialog.textContent).toMatch(/not touched/i);
    // The three things an operator can actually lose, all stated up front:
    // a reserved-key row, an in-place edit, and an imported customisation…
    expect(dialog.textContent).toMatch(/reserved built-in keys/i);
    expect(dialog.textContent).toMatch(/edited in place/i);
    expect(dialog.textContent).toMatch(/imported/i);
    // …plus the knock-on nobody expects: a custom board on a built-in layout
    // follows that layout's restored shape.
    expect(dialog.textContent).toMatch(/built on a built-in LAYOUT/i);
    // Nothing has been written yet — the warning precedes the action.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("cancelling writes nothing", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      calls.some((c) => c.url === "/api/admin/display/built-ins/restore")
    ).toBe(false);
  });

  it("confirming posts the restore, reports it, and reloads the gallery", async () => {
    const { calls } = installFetch(200, []);
    render(<AdminDisplayTemplatesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore built-in boards" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore built-in boards" })
    );

    await screen.findByText(/Restored the built-in boards/);
    expect(
      calls.filter(
        (c) =>
          c.url === "/api/admin/display/built-ins/restore" && c.method === "POST"
      )
    ).toHaveLength(1);
    // The outcome is announced, not merely displayed.
    const live = screen.getByText(/Restored the built-in boards/).closest(
      "[role='status']"
    );
    expect(live).not.toBeNull();
    // Focus survives the dialog closing: the trigger is never disabled in the
    // same turn Radix restores focus to it, so focus cannot land on <body>.
    const trigger = screen.getByRole("button", {
      name: /Restore built-in boards|Restoring…/,
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    // The list is re-read so the new boards appear without a manual reload.
    expect(
      calls.filter(
        (c) => c.url === "/api/admin/display/templates" && c.method === "GET"
      ).length
    ).toBeGreaterThan(1);
  });
});
