import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroContactCache: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";

const baseContactSnapshot = {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  streetAddressLine1: "1 Test Street",
  streetAddressLine2: null,
  streetCity: "Wellington",
  streetRegion: "WGN",
  streetPostalCode: "6011",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: null,
  postalCity: "Wellington",
  postalRegion: "WGN",
  postalPostalCode: "6140",
  postalCountry: "NZ",
};

describe("xero-contact-sync helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #2859: the date of birth is now part of what a Xero contact update carries.
  // Before #2859 this payload deliberately dropped it and this test pinned that
  // — which is exactly why a member's date of birth never reached Xero at all.
  it("carries the date of birth through to the Xero contact update payload", () => {
    expect(buildXeroContactUpdatePayload(baseContactSnapshot)).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
      streetAddressLine1: "1 Test Street",
      streetAddressLine2: null,
      streetCity: "Wellington",
      streetRegion: "WGN",
      streetPostalCode: "6011",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 42",
      postalAddressLine2: null,
      postalCity: "Wellington",
      postalRegion: "WGN",
      postalPostalCode: "6140",
      postalCountry: "NZ",
    });
  });

  // #2859: a date-of-birth edit is now a reason to talk to Xero, because the
  // date of birth is now something Xero is told. This test asserted the
  // opposite before #2859.
  it("treats a date-of-birth-only change as a Xero contact change", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        dateOfBirth: new Date("1991-01-15T00:00:00.000Z"),
      })
    ).toBe(true);
  });

  // The comparison is on the calendar DAY, not the instant. Two `Date` objects
  // for the same birthday are never `===`, and a `getTime()` comparison would
  // have reported a change for every member the #2859 migration re-encoded.
  it("does not treat a re-encoded date of birth as a change when the day is the same", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
      })
    ).toBe(false);
  });

  // Clearing a date of birth still queues an update; the writer then sends no
  // `companyNumber` at all, so Xero's copy is left alone rather than blanked.
  it("treats clearing a date of birth as a Xero contact change", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        dateOfBirth: null,
      })
    ).toBe(true);
  });

  it("treats whitespace and null-only differences as unchanged", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        firstName: " Alice ",
        streetAddressLine2: "",
        postalAddressLine2: "",
      })
    ).toBe(false);
  });

  it("ignores name-only changes because Xero names are reviewed through mismatch checks", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        firstName: "Alicia",
        lastName: "Jones",
      })
    ).toBe(false);
  });

  it("detects a mapped field change", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        phoneNumber: "9999999",
      })
    ).toBe(true);
  });

  it("repairs cached Xero names that are clearly last-name first", async () => {
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      name: "Smith, Alice",
      firstName: null,
      lastName: null,
    });

    await expect(
      shouldRepairXeroContactNameOrder({
        ...baseContactSnapshot,
        xeroContactId: "contact_1",
      })
    ).resolves.toBe(true);

    expect(mocks.prisma.xeroContactCache.findUnique).toHaveBeenCalledWith({
      where: { contactId: "contact_1" },
      select: { name: true, firstName: true, lastName: true },
    });
  });

  it("keeps unrelated reviewed Xero names preserved", async () => {
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      name: "The Smith Family",
      firstName: null,
      lastName: null,
    });

    await expect(
      shouldRepairXeroContactNameOrder({
        ...baseContactSnapshot,
        xeroContactId: "contact_1",
      })
    ).resolves.toBe(false);
  });
});
