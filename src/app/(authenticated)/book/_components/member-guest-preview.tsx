import type { GuestData } from "@/components/guest-form";
import type { MemberGuestConsentColumns } from "@/lib/member-guest-consent";

/**
 * Turn a wizard guest row's display-only consent PREVIEW into the column shape
 * the shared badge function reads (MG3 #2308).
 *
 * WHY A TRANSLATION EXISTS AT ALL, rather than the wizard carrying the five
 * consent columns directly. Nothing has been persisted while the wizard is open —
 * the booking does not exist — so there is no `BookingGuest` row and no real
 * `consentRequestedAt` or `consentExpiresAt` to carry. What the wizard knows is
 * one thing: whether the club will ASK this person or TELL them, which follows
 * from `MemberGuestSettings.approvalRequired`. Everything else is invented, and
 * inventing timestamps to satisfy a type is how a fake expiry date ends up on
 * screen.
 *
 * So exactly two shapes are constructed, and both are LEGAL sub-states of the
 * eight-shape table in `member-guest-consent.ts` rather than approximations:
 *
 *   * `PENDING` → the `AWAITING_TARGET` shape. `consentExpiresAt` is deliberately
 *     null: the wizard badge does not show a date (see the WIZARD audience note
 *     in `member-guest-consent-card.ts`), and a null here cannot leak into a
 *     rendered deadline the way a made-up date could. The PENDING branch of the
 *     badge function does not classify, so this is never mis-classified.
 *   * `NOTIFY_ONLY` → the `NOTIFY_ONLY_AUTO_CONFIRMED` shape exactly: CONFIRMED
 *     with a null `requestedAt` AND a null `respondedBy`, which is that
 *     sub-state's signature and classifies correctly.
 *
 * Any guest with no preview — every family add, every non-member guest, every
 * row that predates this feature — returns `null` and gets no badge at all,
 * which keeps the overwhelming majority of guest rows byte-identical to before.
 */
export function memberGuestConsentPreviewColumns(
  guest: Pick<GuestData, "memberGuestConsentPreview">,
): MemberGuestConsentColumns | null {
  if (guest.memberGuestConsentPreview === "PENDING") {
    return {
      consentStatus: "PENDING",
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
    };
  }
  if (guest.memberGuestConsentPreview === "NOTIFY_ONLY") {
    return {
      consentStatus: "CONFIRMED",
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
    };
  }
  return null;
}

/**
 * What adding THIS person will actually do — the wizard's consent prediction.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it is easy to write the version
 * without it and it looks right. D-9 makes ANY active member resolvable by
 * email, which includes the booker's own family: a parent can perfectly well
 * type their child's household address into the finder rather than using the
 * quick-add row above it. But a family-scope add is consent-FREE (D-6) — the
 * server writes `FAMILY_OR_LEGACY`, nobody is asked and nobody is told — so
 * predicting "Waiting for Mia to approve" over it would promise the booker an
 * email that is never sent and a hold that does not exist.
 *
 * The boundary is computed from the SAME family list the quick-add row is built
 * from (`/api/members/family`, which carries the booker's own row as
 * `relationship: "self"`), so the client's idea of "my family" cannot disagree
 * with the row it already renders. It is still only a prediction: the server
 * recomputes the boundary from `getAllowedGuestMemberIds` and is the only thing
 * that decides what is persisted.
 *
 * Returns `undefined` for a family-scope add, which is what leaves the guest row
 * badge-free and byte-identical to a quick-add.
 *
 * AND `undefined` WHEN THE FAMILY LIST IS UNKNOWN, which is the failure mode the
 * correctness review asked for a guard on. If `/api/members/family` errors, the
 * list is empty for a reason that has nothing to do with who is in the booker's
 * family — and an empty list makes EVERY candidate look beyond-family, so the
 * bug this function exists to prevent comes straight back in the one situation
 * where the booker is most likely to use the finder for their own household (the
 * quick-add row is empty too, because it reads the same list).
 *
 * Predicting nothing is the safer of the two wrong answers. A missing badge
 * under-informs: the booker is not told the person will be asked, and the
 * server still asks them, and the booking page shows the true state the moment
 * it is created. A wrong PENDING badge actively misinforms: it promises an email
 * that is never sent and a held bed that does not exist, and it drags the whole
 * review-step explainer about a stranger seeing the booking onto a row that is
 * the booker's own child.
 */
export function predictMemberGuestConsent(params: {
  candidateMemberId: string;
  /** The booker's own family list, including their own row. */
  familyMemberIds: readonly string[];
  /** False until `/api/members/family` has actually answered — see above. */
  familyMembersLoaded: boolean;
  /** `MemberGuestSettings.approvalRequired` — D-3, true is the shipped default. */
  approvalRequired: boolean;
}): GuestData["memberGuestConsentPreview"] {
  if (!params.familyMembersLoaded) {
    return undefined;
  }
  if (params.familyMemberIds.includes(params.candidateMemberId)) {
    return undefined;
  }
  return params.approvalRequired ? "PENDING" : "NOTIFY_ONLY";
}

/**
 * The one explanatory sentence under a guest row the finder added.
 *
 * WHY THIS EXISTS (UX review of MG3 #2308, finding F3). `GuestForm` prints
 * "Linked family members keep their member details and member pricing." for
 * every row carrying a `memberId`, which until MG3 could only ever BE a family
 * member. The finder now puts people on that row who are emphatically not
 * family, so a PENDING Sam Whittaker was being told he was the booker's linked
 * family member — the single explanatory sentence under the person they had just
 * added, and it was false.
 *
 * DECLARED DIVERGENCE FROM THE SIGNED-OFF MOCKUP, recorded there with a dated
 * note per that file's own amendment rule. Panel 11 draws the PENDING helper as
 * "Sam has been emailed and their bed is held until they answer." In the WIZARD
 * that is not true yet: no booking exists, so nothing has been sent and no bed is
 * held until the booker confirms. The tense is corrected and nothing else.
 *
 * Returns `null` for every other row — family adds, non-member guests, and every
 * booking that predates this feature — which leaves `GuestForm`'s existing
 * sentence exactly where it was.
 */
export function describeMemberGuestWizardHelper(
  guest: Pick<GuestData, "memberGuestConsentPreview" | "firstName">,
): string | null {
  if (guest.memberGuestConsentPreview === "PENDING") {
    const name = guest.firstName.trim() || "They";
    return `${name} will be emailed when you confirm this booking, and their bed is held until they answer.`;
  }
  if (guest.memberGuestConsentPreview === "NOTIFY_ONLY") {
    return "Your club adds member guests straight away and emails them to say so.";
  }
  return null;
}

/** The first names of everyone in the party whose answer is still awaited. */
export function pendingMemberGuestFirstNames(
  guests: readonly GuestData[],
): string[] {
  return guests
    .filter((guest) => guest.memberGuestConsentPreview === "PENDING")
    .map((guest) => guest.firstName);
}
