// @vitest-environment jsdom

import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectStep } from "../xero-wizard-steps";
import type {
  XeroOrgReadError,
  XeroWizardContext,
} from "../use-xero-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";

/*
  #2394 — the connect step must never sit on "Confirming the organisation
  name…" for ever.

  Before this, a single transient failure (a Xero 429, a 5xx, a dropped socket)
  left the wizard on that message with no error, no retry, and no way forward:
  the wizard context swallowed the failure in a bare `catch {}`, the org read
  negative-cached for 60 seconds, and the post-OAuth refresh was a one-shot
  mount effect.

  The owner's binding decision was to SHOW the failure and offer a manual Try
  again — deliberately not an automatic retry, which would spend Xero quota
  nobody asked for and, on a rate limit, make things worse. The wording has to
  separate the three things an operator does differently: reconnect, wait, or
  press the button. These tests pin all of that, plus the fourth (client-only)
  case where this site refuses the read because the role has no finance access.

  The hook side — that Try again genuinely re-fetches, bypassing the negative
  cache — is pinned in `use-xero-wizard-context-org-retry.test.tsx`.
*/

function makeContext(
  overrides: Partial<XeroWizardContext> = {},
): XeroWizardContext {
  return {
    redirectUri: "https://example.test/api/admin/xero/callback",
    companyUrl: "https://example.test",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: true, setAt: null },
      client_secret: { set: true, setAt: null },
      webhook_key: { set: false, setAt: null },
    },
    isFullAdmin: true,
    connected: true,
    needsReentry: false,
    orgName: null,
    orgError: null,
    orgLoading: false,
    webhookDeliveryUrl: "https://example.test/api/webhooks/xero",
    webhooksVerifiable: true,
    webhookVerified: false,
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
    isVerified: true,
    optional: false,
    acknowledged: false,
    skip: vi.fn(),
    ancestorRendersViewOnlyBanner: true,
    ...overrides,
  };
}

function failure(overrides: Partial<XeroOrgReadError>): XeroOrgReadError {
  return {
    kind: "unavailable",
    rateLimit: null,
    retryAfterSeconds: null,
    ...overrides,
  };
}

const tryAgain = () => screen.queryByRole("button", { name: /try again/i });

beforeEach(() => {
  // ConnectStep mounts `useXeroConnection`, which reads /api/admin/xero/status.
  // Answer it so the step's own connection-error alert stays empty and these
  // assertions are about the ORGANISATION read only.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        connected: true,
        needsReentry: false,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectStep: a successful organisation read is unchanged (#2394)", () => {
  it("confirms the organisation by name, with no error and no retry control", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: "Alpine Sports Club" })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/Alpine Sports Club/)).toBeTruthy();
    expect(screen.getByText(/right Xero organisation/i)).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });

  // The placeholder is still correct while the read is genuinely in flight —
  // what must never happen is settling there.
  it("still shows the interim 'Confirming…' message while nothing has failed", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: null, orgError: null, orgLoading: true })}
        helpers={makeHelpers()}
      />,
    );

    expect(
      screen.getByText(/Confirming the organisation name/i),
    ).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });
});

describe("ConnectStep: each failure class says something different (#2394)", () => {
  it("tells a disconnected operator to reconnect, and offers no retry", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "disconnected" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/needs re-authorising/i)).toBeTruthy();
    expect(screen.getByText(/Connect again/i)).toBeTruthy();
    // Retrying cannot fix a revoked authorisation; offering the button would
    // teach the operator it does nothing.
    expect(tryAgain()).toBeNull();
    // …and the "Confirming…" placeholder is gone.
    expect(screen.queryByText(/Confirming the organisation name/i)).toBeNull();
  });

  it("tells a daily-limited operator when the limit resets, and offers a retry", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "rate_limited", rateLimit: "day" }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/daily limit/i)).toBeTruthy();
    // The owner asked for the reset to be stated in terms a NZ club can act on.
    expect(screen.getByText(/midnight UTC/i)).toBeTruthy();
    expect(screen.getByText(/midday in New Zealand/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  it("passes on Xero's Retry-After for a per-minute limit", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({
            kind: "rate_limited",
            rateLimit: "minute",
            retryAfterSeconds: 42,
          }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/limiting how quickly/i)).toBeTruthy();
    expect(screen.getByText(/about 40 seconds/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  it("treats a transient failure as 'try again now'", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/could not reach Xero/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  it("names the permission problem when this site refuses the read", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "forbidden" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/cannot read the Xero organisation details/i)).toBeTruthy();
    expect(screen.getByText(/finance access/i)).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });
});

describe("ConnectStep: the failure is announced, not just drawn (#2394)", () => {
  it("renders the explanation inside a live region", () => {
    const { container } = render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers()}
      />,
    );

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(
      alerts.some((node) => /could not reach Xero/i.test(node.textContent ?? "")),
    ).toBe(true);
  });

  // The live-region convention (AGENTS.md): the region is mounted even when
  // empty, so a message injected into it later is actually announced.
  it("keeps the live region mounted while there is nothing to say", () => {
    const { container } = render(
      <ConnectStep context={makeContext({ orgName: "Alpine Sports Club" })} helpers={makeHelpers()} />,
    );

    expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });
});

describe("ConnectStep: the Try again control (#2394)", () => {
  it("re-runs the context read, which forces a fresh organisation call", () => {
    const helpers = makeHelpers();
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={helpers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(helpers.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows itself as busy, and cannot be double-spent, while a read is running", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "unavailable" }),
          orgLoading: true,
        })}
        helpers={makeHelpers()}
      />,
    );

    const button = screen.getByRole("button", {
      name: /trying again/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("is offered to a view-only admin, who can still clear a transient failure", () => {
    // The read changes nothing and the wizard already performs it on load for
    // any admin who can open the page, so gating the retry on finance EDIT
    // would strand a view-only admin on an error with no way to clear it.
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );

    const button = screen.getByRole("button", {
      name: /try again/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
