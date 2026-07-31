import { describe, expect, it } from "vitest";
import { shouldShowMemberOnboarding, type MemberOnboardingProfile } from "@/lib/member-onboarding";
import {
  MEMBER_LEVEL_ROLE_VALUES,
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  ROLE_VALUES,
  type AppRole,
  accountCanHoldMembership,
  canAdminRequestMembershipCancellation,
  isMemberLevelRole,
  isOperationalRole,
} from "@/lib/member-roles";
import { effectiveSubscriptionBehavior } from "@/lib/membership-types";

function onboardingProfile(role: string): MemberOnboardingProfile {
  const accessRoles = ["USER", "ADMIN", "LODGE"].includes(role)
    ? [{ role }]
    : [];

  return {
    id: `member-${role.toLowerCase()}`,
    active: true,
    canLogin: true,
    role,
    accessRoles,
    forcePasswordChange: false,
    firstName: "Taylor",
    lastName: "Member",
    email: "taylor@example.org",
    phoneCountryCode: "",
    phoneAreaCode: "",
    phoneNumber: "",
    dateOfBirth: null,
    streetAddressLine1: "",
    streetCity: "",
    streetRegion: "",
    streetPostalCode: "",
    streetCountry: "",
    postalAddressLine1: "",
    postalCity: "",
    postalRegion: "",
    postalPostalCode: "",
    postalCountry: "",
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
  };
}

describe("member role categories", () => {
  it("treats USER as the ordinary member-facing access role", () => {
    expect(MEMBER_LEVEL_ROLE_VALUES).toEqual(["USER"]);
    expect(isMemberLevelRole("USER")).toBe(true);
    expect(isMemberLevelRole("MEMBER")).toBe(false);
    expect(isMemberLevelRole("ASSOCIATE")).toBe(false);
    expect(isMemberLevelRole("LIFE")).toBe(false);
    expect(isMemberLevelRole("ADMIN")).toBe(false);
    expect(isMemberLevelRole("LODGE")).toBe(false);
  });

  it("keeps only ADMIN and LODGE as operational roles", () => {
    expect(OPERATIONAL_ROLE_VALUES).toEqual(["ADMIN", "LODGE"]);
    expect(isOperationalRole("ADMIN")).toBe(true);
    expect(isOperationalRole("LODGE")).toBe(true);
    // #2149: role carries no exemption of its own — operational accounts are
    // exempt only because they resolve to a NOT_REQUIRED built-in type, while
    // USER resolves to FULL (REQUIRED).
    expect(effectiveSubscriptionBehavior(null, "ADMIN")).toBe("NOT_REQUIRED");
    expect(effectiveSubscriptionBehavior(null, "LODGE")).toBe("NOT_REQUIRED");
    expect(effectiveSubscriptionBehavior(null, "USER")).toBe("REQUIRED");
  });

  it("runs onboarding for users but not membership type category strings", () => {
    expect(shouldShowMemberOnboarding(onboardingProfile("USER"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("ASSOCIATE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LIFE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("ADMIN"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LODGE"))).toBe(false);
  });
});

describe("non-member booking-request roles", () => {

  it("grants them no member-level or operational access", () => {
    for (const role of NON_MEMBER_ROLE_VALUES) {
      expect(isMemberLevelRole(role)).toBe(false);
      expect(isOperationalRole(role)).toBe(false);
      // Non-login records, so onboarding never applies even before the role check.
      expect(shouldShowMemberOnboarding(onboardingProfile(role))).toBe(false);
    }
  });

  it("exempts them from membership subscriptions via their default type", () => {
    // #2149: exemption flows from the NON_MEMBER/SCHOOL built-in NOT_REQUIRED
    // types, not from the login role.
    expect(effectiveSubscriptionBehavior(null, "NON_MEMBER")).toBe(
      "NOT_REQUIRED",
    );
    expect(effectiveSubscriptionBehavior(null, "SCHOOL")).toBe("NOT_REQUIRED");
  });
});

describe("account-holder classification (#2383)", () => {
  // Every legacy Role value, so adding one to the enum forces a deliberate
  // decision here rather than silently landing in the cancellable default.
  const EXPECTED_BY_ROLE: Record<
    AppRole,
    { canLogin: boolean; canHoldMembership: boolean; why: string }[]
  > = {
    USER: [
      { canLogin: true, canHoldMembership: true, why: "ordinary member" },
      {
        canLogin: false,
        canHoldMembership: true,
        why: "dependant / non-login adult (#2354)",
      },
    ],
    ADMIN: [
      {
        canLogin: true,
        canHoldMembership: true,
        why: "Full Admin is a fee-paying member like anyone else (#2383)",
      },
    ],
    LODGE: [
      { canLogin: true, canHoldMembership: false, why: "kiosk device login" },
    ],
    NON_MEMBER: [
      {
        canLogin: false,
        canHoldMembership: false,
        why: "booking-request guest record",
      },
    ],
    SCHOOL: [
      {
        canLogin: true,
        canHoldMembership: true,
        why: "organisation account (User Type Organisation)",
      },
      {
        canLogin: false,
        canHoldMembership: false,
        why: "school booking-request contact / teacher record",
      },
    ],
  };

  it("classifies every legacy role value", () => {
    for (const role of ROLE_VALUES) {
      for (const scenario of EXPECTED_BY_ROLE[role]) {
        expect(
          accountCanHoldMembership({ role, canLogin: scenario.canLogin }),
          `${role} (canLogin=${scenario.canLogin}): ${scenario.why}`,
        ).toBe(scenario.canHoldMembership);
      }
    }
  });

  it("refuses a kiosk identified only by its LODGE access-role row", () => {
    expect(
      accountCanHoldMembership({
        role: "USER",
        canLogin: true,
        accessRoles: ["LODGE"],
      }),
    ).toBe(false);
  });

  it("never uses access roles to allow, only to block", () => {
    // Access roles are cleared for anyone who cannot log in (#2354), so an
    // empty set must never be read as "not an account holder".
    expect(
      accountCanHoldMembership({
        role: "USER",
        canLogin: false,
        accessRoles: [],
      }),
    ).toBe(true);
    // A scoped admin (Membership Officer et al) stores role USER; it was always
    // cancellable, and stays so.
    expect(
      accountCanHoldMembership({
        role: "USER",
        canLogin: true,
        accessRoles: ["ADMIN_MEMBERSHIP"],
      }),
    ).toBe(true);
  });

  it("treats an unknown or missing role as an account holder", () => {
    // Fail-open is right for the two refusals: they are narrow, named record
    // classes, and a member with odd legacy data is still a person.
    for (const role of [null, undefined, "MEMBER", "LIFE"]) {
      expect(accountCanHoldMembership({ role, canLogin: true })).toBe(true);
    }
  });
});

describe("admin membership-cancellation eligibility", () => {
  const base = {
    role: "USER",
    canLogin: true,
    active: true,
    cancelledAt: null,
    archivedAt: null,
  };

  it("offers cancellation for a dependant / non-login adult", () => {
    // The #2354 regression: the page gated on hasAccessRole(member, "USER"),
    // which is always false once canLogin is false (access roles are cleared
    // for anyone who cannot log in), hiding the action for every dependant
    // while the API accepted them. The extra fields here are the ones the old
    // gate consulted — carried deliberately to document that eligibility
    // ignores them. See membership-cancellation-gate-contract.test.ts for the
    // call site, which is what a revert would break.
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        canLogin: false,
        accessRoles: [],
      }),
    ).toBe(true);
    expect(canAdminRequestMembershipCancellation(base)).toBe(true);
  });

  it("offers cancellation whatever admin access the member holds (#2383)", () => {
    // The rule this replaced refused legacy role ADMIN — the Full Admin bundle
    // only — forcing an admin's access to be destroyed before their membership
    // could be cancelled, which the member page cannot undo.
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        role: "ADMIN",
        accessRoles: ["ADMIN", "USER"],
      }),
    ).toBe(true);
    // Scoped and custom-role admins store role USER and were never refused.
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        accessRoles: ["ADMIN_MEMBERSHIP"],
      }),
    ).toBe(true);
  });

  it("offers cancellation for an organisation account (#2383)", () => {
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        role: "SCHOOL",
        accessRoles: ["ORG"],
      }),
    ).toBe(true);
  });

  it("refuses only the records that are not account holders", () => {
    // The lodge kiosk device login...
    expect(
      canAdminRequestMembershipCancellation({ ...base, role: "LODGE" }),
    ).toBe(false);
    // ...and the booking-request contact records: a public-booking guest, and
    // the school owner contact / teacher records minted by the school flow,
    // which carry role SCHOOL but are always non-login.
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        role: "NON_MEMBER",
        canLogin: false,
      }),
    ).toBe(false);
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        role: "SCHOOL",
        canLogin: false,
      }),
    ).toBe(false);
  });

  it("refuses inactive, already-cancelled, and archived members", () => {
    expect(
      canAdminRequestMembershipCancellation({ ...base, active: false }),
    ).toBe(false);
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        cancelledAt: new Date(),
      }),
    ).toBe(false);
    expect(
      canAdminRequestMembershipCancellation({
        ...base,
        archivedAt: new Date(),
      }),
    ).toBe(false);
  });
});
