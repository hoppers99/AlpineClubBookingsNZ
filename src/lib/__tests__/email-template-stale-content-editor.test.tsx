// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #2269 (F3) — the admin-facing half. A club whose saved wording has fallen
// behind the built-in wording has to be able to SEE that, and see exactly how,
// before deciding between patching their words and Restore Default (which
// throws their words away).
//
// The load-bearing requirement is what must NOT happen: a club that reworded a
// message on purpose — which is the entire point of saving one — must not be
// told it has drifted. So the two tests that matter most here are the one that
// asserts a rewritten-but-complete override shows no warning at all, and the
// one that asserts the diff shows both sides.
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

import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

const definition = getEmailTemplateDefinition("booking-confirmed");
if (!definition) throw new Error("missing booking-confirmed");

const REWORDED_BODY = [
  "Kia ora {{firstName}}, your bunk is locked in.",
  "",
  "{{promoSummary}}Total Paid: {{totalPaid}}",
  "",
  "{{CLUB_LODGE_TRAVEL_NOTE}}",
  "",
  "{{doorCodeNote}}",
].join("\n");

function stubEmailFetches(
  templatesBody: Record<string, unknown>,
) {
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
          ? templatesBody
          : null;
      if (!body) throw new Error(`Unstubbed fetch in test: ${url}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function templatesResponse({
  bodyText,
  staleContent,
  missingRequiredTokenOverrides = [],
}: {
  bodyText: string;
  staleContent: Record<string, unknown>;
  missingRequiredTokenOverrides?: Array<{
    templateName: string;
    tokens: string[];
  }>;
}) {
  return {
    templates: [
      {
        ...definition,
        override: {
          subject: null,
          bodyText,
          updatedAt: "2026-06-01T00:00:00.000Z",
          updatedByMemberId: "admin-1",
        },
        staleContent,
      },
    ],
    staleOverrideCount: 0,
    bracketAnnotationOverrides: [],
    retiredTokenOverrides: [],
    missingRequiredTokenOverrides,
  };
}

/** True when the rendered diff contains a line matching `pattern`. */
function diffLine(pattern: RegExp): boolean {
  return Array.from(document.querySelectorAll("pre > div")).some((element) =>
    pattern.test(element.textContent ?? ""),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("email template saved-copy staleness surface (#2269)", () => {
  it("states a deliberate rewording as a plain difference, with no warning", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText: REWORDED_BODY,
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByText(
        /Your saved copy of this message differs from the built-in wording/,
      ),
    ).toBeInTheDocument();
    // Nothing that reads as a problem: no reason sentences and no banner.
    expect(screen.queryByText(/no longer shows something/)).not.toBeInTheDocument();
    expect(screen.queryByText(/renders as nothing at all/)).not.toBeInTheDocument();
    expect(screen.queryByText(/square-bracketed notes/)).not.toBeInTheDocument();
  });

  it("shows both sides of the wording when the admin asks for the differences", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText: REWORDED_BODY,
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    const toggle = await screen.findByRole("button", {
      name: /Show differences/,
    });
    // Hidden until asked for: the diff is a decision aid, not page furniture.
    expect(screen.queryByText(/is your saved copy/)).not.toBeInTheDocument();
    fireEvent.click(toggle);

    expect(screen.getByText(/is your saved copy/)).toBeInTheDocument();
    // A line only the club has, and a line only the built-in wording has —
    // asserted inside the diff itself, because the editor textarea below the
    // diff also contains the club's text.
    expect(
      diffLine(/^- Kia ora \{\{firstName\}\}, your bunk is locked in\.$/),
    ).toBe(true);
    const firstDefaultLine = definition.defaultBody.split("\n")[0];
    expect(diffLine(new RegExp(`^\\+ ${firstDefaultLine}$`))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Hide differences/ }));
    expect(screen.queryByText(/is your saved copy/)).not.toBeInTheDocument();
  });

  it("names what a saved copy stopped saying, on the template and at the top of the page", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText:
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: ["missing_required_token"],
          missingRequiredTokens: ["promoSummary"],
          retiredTokens: [],
          bracketAnnotations: [],
        },
        missingRequiredTokenOverrides: [
          { templateName: "booking-confirmed", tokens: ["promoSummary"] },
        ],
      }),
    );
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByText(
        /Your saved copy no longer shows something this email is required to tell the recipient\. Add back \{\{promoSummary\}\}/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/booking-confirmed \(\{\{promoSummary\}\}\)/),
    ).toBeInTheDocument();
  });

  it("says nothing at all when there is no saved override", async () => {
    stubEmailFetches({
      templates: [{ ...definition, override: null, staleContent: null }],
      staleOverrideCount: 0,
      bracketAnnotationOverrides: [],
      retiredTokenOverrides: [],
      missingRequiredTokenOverrides: [],
    });
    render(<EmailMessageSettingsPanel />);

    await screen.findByLabelText("Body");
    expect(
      screen.queryByText(/differs from the built-in wording/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show differences/ }),
    ).not.toBeInTheDocument();
  });
});
