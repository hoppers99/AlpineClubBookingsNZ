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
        approvalRequired: true,
      }),
    ).toBe("PENDING");
  });

  it("predicts a notice for a beyond-family member under the notify-only opt-down", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: FAMILY,
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
