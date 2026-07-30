// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #2267 (owner decision on PR #2311) — the admin email-template editor has to
// SHOW the required-token rule, including the tokens that satisfy it instead.
// A filled token chip is the only other signal, and it cannot say "or
// {{promoAdjustment}}", so an admin editing a booking-confirmed override would
// otherwise discover the promo requirement only by having a save rejected.
//
// The fixture is the REAL registry definition, so this cannot pass against a
// hand-written fixture that has drifted from what the API serves.
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "view",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "edit",
        },
      },
    },
    status: "authenticated",
  }),
}));

import {
  EmailMessageSettingsPanel,
  requiredTokenSentence,
} from "@/components/admin/email-settings/email-message-settings-panel";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

function stubEmailFetches() {
  const definition = getEmailTemplateDefinition("booking-confirmed");
  if (!definition) throw new Error("missing booking-confirmed");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      const body = url.startsWith("/api/admin/email-settings")
        ? {
            settings: {
              clubName: "Example Mountain Club",
              bookingsName: "Bookings",
              emailFromName: "From",
              supportEmail: "support@example.org",
              contactEmail: "contact@example.org",
              publicUrl: "https://bookings.example.org",
            },
          }
        : url.startsWith("/api/admin/email-templates")
          ? {
              // The panel selects the first template on load, exactly as the
              // real GET response is ordered per template.
              templates: [{ ...definition, override: null }],
              staleOverrideCount: 0,
            }
          : null;
      if (!body) throw new Error(`Unstubbed fetch in test: ${url}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("email template editor required-token surfacing (#2267)", () => {
  it("tells the admin which tokens must stay in the booking-confirmed body", async () => {
    stubEmailFetches();
    render(<EmailMessageSettingsPanel />);

    const sentence = await screen.findByText(/Keep these in the body/);
    // The promo explanation is required, and the legacy tokens that satisfy it
    // are named alongside it — the whole point of the alternatives mechanism.
    expect(sentence).toHaveTextContent(
      "{{promoSummary}} (or {{promoAdjustment}} or {{discount}})",
    );
    // Its neighbours on the same template, so the sentence is the full rule.
    expect(sentence).toHaveTextContent("{{CLUB_LODGE_TRAVEL_NOTE}}");
    expect(sentence).toHaveTextContent("{{doorCodeNote}} (or {{doorCode}})");
  });

  it("says nothing for a template with no required tokens", () => {
    // Most templates require nothing; they must not grow an empty instruction.
    expect(
      requiredTokenSentence({ requiredTokens: [], requiredTokenAlternatives: {} }),
    ).toBeNull();
    expect(requiredTokenSentence(null)).toBeNull();
    // A required token with no registered alternative is named on its own.
    expect(requiredTokenSentence({ requiredTokens: ["token"] })).toBe(
      "Keep these in the body: {{token}}.",
    );
  });
});
