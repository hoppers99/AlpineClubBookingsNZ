// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import type { DisplayWizardContext } from "../display-wizard-state";
import { ConfigStep, ModuleStep, PairStep } from "../display-wizard-steps";

// Behaviour these renders pin down, all of it load-bearing:
//  • the module step is honest about the SUPPORT area it needs, rather than
//    offering a lodge admin a button the route would refuse;
//  • the config quick-set posts the WHOLE config object, because the route
//    replaces `displayConfig` wholesale and a partial post would silently delete
//    every key the wizard does not show;
//  • pairing binds the chosen board BEFORE arming the code, so the screen never
//    flashes the club default;
//  • the shared install-wide cursor is stated on every step.

const editAccess = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: (area: string) => editAccess.value[area],
  ADMIN_VIEW_ONLY_ACTION_REASON: "view only",
}));

function makeContext(
  overrides: Partial<DisplayWizardContext> = {},
): DisplayWizardContext {
  return {
    moduleEnabled: true,
    templates: [
      {
        id: "tpl-1",
        key: "everyday-board",
        name: "Everyday board",
        layout: { id: "lay-1", key: "everyday-board", name: "Everyday board" },
        deviceCount: 0,
      },
    ],
    devices: [],
    lodges: [{ id: "lodge-1", name: "Ruapehu Lodge" }],
    lodgeId: "lodge-1",
    lodgeConfig: {
      lodgeId: "lodge-1",
      lodgeName: "Ruapehu Lodge",
      displayConfig: { "wifi-name": "RUAPEHU-GUEST", "custom-key": "keep me" },
      displayNotice: null,
    },
    loaded: true,
    moduleBlockedReads: false,
    ...overrides,
  };
}

function makeHelpers(
  overrides: Partial<WizardStepHelpers> = {},
): WizardStepHelpers {
  return {
    canEdit: true,
    refresh: vi.fn(),
    goNext: vi.fn(),
    isVerified: false,
    optional: false,
    acknowledged: false,
    skip: vi.fn(),
    ...overrides,
  };
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url, init) as
        { ok?: boolean; status?: number; body?: unknown } | undefined;
      const status = result?.status ?? 200;
      return {
        ok: result?.ok ?? (status >= 200 && status < 300),
        status,
        json: async () => result?.body ?? {},
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  editAccess.value = { lodge: true, support: true };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("step 1 — module check", () => {
  it("says the module is on without offering a switch", () => {
    render(<ModuleStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByText(/Lobby TV display is on/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /turn the module on/i }),
    ).toBeNull();
  });

  it("tells a lodge-only admin who can turn it on, instead of a dead button", () => {
    editAccess.value = { lodge: true, support: false };
    render(
      <ModuleStep
        context={makeContext({ moduleEnabled: false })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /turn the module on/i }),
    ).toBeNull();
    expect(
      screen.getByText(/needs system-settings \(support\) edit access/i),
    ).toBeTruthy();
  });

  it("reads the whole settings object before flipping the one flag", async () => {
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/modules" && init?.method === "PUT")
        return { ok: true };
      return { ok: true, body: { lobbyDisplay: false, chores: true } };
    });
    const helpers = makeHelpers();
    render(
      <ModuleStep
        context={makeContext({ moduleEnabled: false })}
        helpers={helpers}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /turn the module on/i }),
    );

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === "PUT");
      expect(put).toBeTruthy();
      // Every other module survives the write.
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        settings: { lobbyDisplay: true, chores: true },
      });
    });
    expect(helpers.refresh).toHaveBeenCalled();
  });

  it("states the install-wide cursor", () => {
    render(<ModuleStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByTestId("shared-cursor-note").textContent).toMatch(
      /saved for the whole club, not for you personally/i,
    );
  });
});

describe("step 4 — lodge details quick-set", () => {
  it("posts the FULL config object so keys it does not show survive", async () => {
    const calls = mockFetch(() => ({ ok: true }));
    render(<ConfigStep context={makeContext()} helpers={makeHelpers()} />);

    fireEvent.change(screen.getByLabelText(/Wi-Fi password/i), {
      target: { value: "kea2026" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /save lodge details/i }),
    );

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/admin/display/lodge-config");
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        lodgeId: "lodge-1",
        displayConfig: {
          "wifi-name": "RUAPEHU-GUEST",
          "custom-key": "keep me",
          "wifi-code": "kea2026",
        },
        displayNotice: null,
      });
    });
  });

  it("names the other saved keys it is leaving alone, and links to the full editor", () => {
    render(<ConfigStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.getByText(/custom-key/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /full display settings/i })
        .getAttribute("href"),
    ).toBe("/admin/lodges/lodge-1/display");
  });

  it("disables the fields for a view-only admin", () => {
    render(
      <ConfigStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );
    expect(
      (screen.getByLabelText(/Wi-Fi network name/i) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });
});

describe("step 5 — pair the TV", () => {
  it("creates the screen, binds the chosen board, THEN arms the code", async () => {
    const calls = mockFetch((url, init) => {
      if (url === "/api/admin/display/devices" && init?.method === "POST") {
        return { ok: true, body: { device: { id: "dev-9" } } };
      }
      return { ok: true, body: { ok: true } };
    });
    render(
      <PairStep
        context={makeContext()}
        helpers={makeHelpers()}
        chosenTemplateId="tpl-1"
      />,
    );

    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "K7DPQM" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(
        calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`),
      ).toEqual([
        "POST /api/admin/display/devices",
        "PATCH /api/admin/display/devices/dev-9",
        "POST /api/admin/display/devices/dev-9/pairing",
      ]);
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      templateId: "tpl-1",
    });
  });

  it("reuses the screen already awaiting pairing rather than creating another", async () => {
    const calls = mockFetch(() => ({ ok: true, body: { ok: true } }));
    render(
      <PairStep
        context={makeContext({
          devices: [
            {
              id: "dev-pending",
              name: "Lobby TV — Ruapehu Lodge",
              lodgeId: "lodge-1",
              lodgeName: "Ruapehu Lodge",
              templateId: null,
              templateName: null,
              paired: false,
              pairingArmedUntil: null,
              lastSeenAt: null,
              revoked: false,
            },
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId={null}
      />,
    );

    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(calls.map((call) => call.url)).toEqual([
        "/api/admin/display/devices/dev-pending/pairing",
      ]);
    });
  });

  it("explains a rate-limited pairing rather than blaming the code", async () => {
    mockFetch(() => ({ ok: false, status: 429 }));
    render(
      <PairStep
        context={makeContext({
          devices: [
            {
              id: "dev-pending",
              name: "Lobby TV",
              lodgeId: "lodge-1",
              lodgeName: "Ruapehu Lodge",
              templateId: null,
              templateName: null,
              paired: false,
              pairingArmedUntil: null,
              lastSeenAt: null,
              revoked: false,
            },
          ],
        })}
        helpers={makeHelpers()}
        chosenTemplateId={null}
      />,
    );
    fireEvent.change(screen.getByLabelText(/code on the tv/i), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /pair this screen/i }));

    await waitFor(() => {
      expect(screen.getByText(/too many pairing attempts/i)).toBeTruthy();
    });
  });
});
