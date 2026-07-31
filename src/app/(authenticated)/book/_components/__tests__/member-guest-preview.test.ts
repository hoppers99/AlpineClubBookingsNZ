// MG3 (#2308) — the wizard's consent PREVIEW, and the family-scope trap.
//
// The wizard shows a badge before anything is persisted, so what it shows is a
// prediction. The prediction has one non-obvious case that is easy to get wrong:
// D-9 makes any active member resolvable by email, INCLUDING the booker's own
// family, so the finder can perfectly well produce a family-scope add — which is
// consent-free (D-6) and must carry no badge at all.
import { describe, expect, it } from "vitest";

import type { GuestData } from "@/components/guest-form";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";
import {
  memberGuestConsentPreviewColumns,
  pendingMemberGuestFirstNames,
  describeMemberGuestWizardHelper,
  predictMemberGuestConsent,
} from "@/app/(authenticated)/book/_components/member-guest-preview";

const FAMILY = ["m-self", "m-partner", "m-child"];

describe("predictMemberGuestConsent", () => {
  it("predicts nothing at all for the booker's own family, whatever the policy", () => {
    for (const approvalRequired of [true, false]) {
      for (const memberId of FAMILY) {
        expect(
          predictMemberGuestConsent({
            candidateMemberId: memberId,
            familyMemberIds: FAMILY,
            familyMembersLoaded: true,
            approvalRequired,
          }),
        ).toBeUndefined();
      }
    }
  });

  it("predicts an ask for a beyond-family member under the shipped default", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: FAMILY,
        familyMembersLoaded: true,
        approvalRequired: true,
      }),
    ).toBe("PENDING");
  });

  it("predicts NOTHING at all when the family list never loaded", () => {
    // The guard the correctness review asked for. A failed `/api/members/family`
    // leaves an empty list, which makes every candidate look beyond-family — and
    // the booker is MOST likely to reach for the finder in exactly that state,
    // because the quick-add row is empty too. A missing badge under-informs; a
    // wrong PENDING badge promises an email that is never sent.
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-child",
        familyMemberIds: [],
        familyMembersLoaded: false,
        approvalRequired: true,
      }),
    ).toBeUndefined();
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: [],
        familyMembersLoaded: false,
        approvalRequired: true,
      }),
    ).toBeUndefined();
  });

  it("predicts a notice for a beyond-family member under the notify-only opt-down", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: FAMILY,
        familyMembersLoaded: true,
        approvalRequired: false,
      }),
    ).toBe("NOTIFY_ONLY");
  });
});

describe("memberGuestConsentPreviewColumns", () => {
  it("builds shapes that are LEGAL sub-states, not approximations", () => {
    const pending = memberGuestConsentPreviewColumns({
      memberGuestConsentPreview: "PENDING",
    })!;
    // The PENDING branch of the badge function does not classify, so a null
    // expiry here is safe — and it is what stops an invented deadline reaching
    // the screen. What must NOT happen is a shape that classifies as something
    // else entirely.
    expect(pending.consentStatus).toBe("PENDING");
    expect(pending.consentExpiresAt).toBeNull();

    const notifyOnly = memberGuestConsentPreviewColumns({
      memberGuestConsentPreview: "NOTIFY_ONLY",
    })!;
    expect(classifyMemberGuestConsent(notifyOnly, "m-stranger")).toBe(
      "NOTIFY_ONLY_AUTO_CONFIRMED",
    );
  });

  it("gives every other guest row no columns at all, so it renders exactly as before", () => {
    expect(memberGuestConsentPreviewColumns({})).toBeNull();
    expect(
      memberGuestConsentPreviewColumns({ memberGuestConsentPreview: undefined }),
    ).toBeNull();
  });
});

describe("pendingMemberGuestFirstNames", () => {
  it("names only the guests whose answer is genuinely still awaited", () => {
    const guests = [
      { firstName: "Jordan", memberGuestConsentPreview: undefined },
      { firstName: "Sam", memberGuestConsentPreview: "PENDING" },
      { firstName: "Daniel", memberGuestConsentPreview: "NOTIFY_ONLY" },
      { firstName: "Anna", memberGuestConsentPreview: "PENDING" },
    ] as GuestData[];
    expect(pendingMemberGuestFirstNames(guests)).toEqual(["Sam", "Anna"]);
  });

  it("is empty for an ordinary family booking, so the explainer never renders", () => {
    const guests = [
      { firstName: "Jordan" },
      { firstName: "Mia" },
    ] as GuestData[];
    expect(pendingMemberGuestFirstNames(guests)).toEqual([]);
  });
});

describe("describeMemberGuestWizardHelper", () => {
  it("replaces the family sentence for somebody who is emphatically not family", () => {
    // `GuestForm`'s default sentence — "Linked family members keep their member
    // details and member pricing." — is printed for every row carrying a
    // memberId, which until MG3 could only ever BE family. A PENDING Sam
    // Whittaker was being told he was the booker's linked family member.
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Sam",
        memberGuestConsentPreview: "PENDING",
      }),
    ).toBe(
      "Sam will be emailed when you confirm this booking, and their bed is held until they answer.",
    );
  });

  it("does not claim an email has already been sent, because none has", () => {
    // Declared divergence from mockup panel 11, recorded there with a dated
    // note: in the wizard no booking exists yet, so nothing has been sent and no
    // bed is held until the booker confirms.
    const helper = describeMemberGuestWizardHelper({
      firstName: "Sam",
      memberGuestConsentPreview: "PENDING",
    });
    expect(helper).not.toContain("has been emailed");
  });

  it("describes the notify-only world in the club's terms", () => {
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Daniel",
        memberGuestConsentPreview: "NOTIFY_ONLY",
      }),
    ).toBe("Your club adds member guests straight away and emails them to say so.");
  });

  it("leaves every other row's sentence exactly where it was", () => {
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Mia",
        memberGuestConsentPreview: undefined,
      }),
    ).toBeNull();
  });
});
