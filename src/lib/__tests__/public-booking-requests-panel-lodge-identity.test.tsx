// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

/*
 * #2887: the per-row lodge badge is this panel's ONLY lodge identity — it has
 * no lodge picker at all. It was gated on `activeLodges.length >= 2`, which is
 * equally false for a multi-lodge club whose lodge list FAILED or is FORBIDDEN,
 * so an officer priced and approved a stay with no lodge on screen.
 *
 * `/admin/booking-requests` is in the BOOKINGS area, and `ADMIN_MEMBERSHIP` and
 * `FINANCE_ADMIN` hold `bookings: "view"` with no `lodge` entry, so for those
 * two shipped presets `/api/admin/lodges` is a permanent 403 — this was not
 * only an outage case.
 */
let lodgeOptions: {
  lodges: Array<{ id: string; name: string }>;
  loading: boolean;
  failed: boolean;
  forbidden: boolean;
  reload: () => void;
};
vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/lodge-select")>()),
  useLodgeOptions: () => lodgeOptions,
}));

// next/navigation: the panel replaces the URL in an effect and reads search params.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Radix Select needs jsdom polyfills the suite does not provide; stub it out —
// the pricing-mode picker is irrelevant to the release-hold warning under test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

// The contact picker is not rendered while a hold exists; stub it defensively.
vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

// The panel reads the configurable hut-leader label via useClubIdentity, which
// throws outside a ClubIdentityProvider; stub it with the default label.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A general request that HAS a held booking and is in a whitelisted status, so
// the read-only note + "Release hold" action render.
const heldRequest = {
  id: "req-1",
  type: "GENERAL",
  status: "QUOTE_SENT",
  schoolName: null,
  cateringPreference: null,
  teachers: [],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: null,
  pricedAt: null,
  pricedByMemberId: null,
  pricedByMemberName: null,
  reviewedAt: null,
  reviewedByMemberId: null,
  reviewedByMemberName: null,
  declineReason: null,
  convertedBookingId: null,
  attendeesConfirmedAt: null,
  convertedMemberId: null,
  lodgeName: "Lodge Two",
  heldBookingId: "held-1",
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("PublicBookingRequestsPanel lodge identity (#2887)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lodgeOptions = {
      lodges: [
        { id: "lodge-1", name: "Lodge One" },
        { id: "lodge-2", name: "Lodge Two" },
      ],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [heldRequest] }),
    }) as unknown as typeof fetch;
  });

  it("shows the lodge badge for a multi-lodge club", async () => {
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.getByText("Lodge Two")).toBeTruthy();
  });

  it("keeps the badge when the lodge list FAILED — plurality unknown is not one lodge", async () => {
    lodgeOptions = { ...lodgeOptions, lodges: [], failed: true };
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.getByText("Lodge Two")).toBeTruthy();
  });

  it("keeps the badge when the lodge list is FORBIDDEN — the permanent case for two shipped presets", async () => {
    lodgeOptions = { ...lodgeOptions, lodges: [], forbidden: true };
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.getByText("Lodge Two")).toBeTruthy();
  });

  it("still hides it for a club the list says really has one lodge (ADR-002)", async () => {
    // Identity is withheld on EVIDENCE, never on the absence of it.
    lodgeOptions = { ...lodgeOptions, lodges: [{ id: "lodge-1", name: "Lodge One" }] };
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.queryByText("Lodge Two")).toBeNull();
  });
});
