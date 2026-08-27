/**
 * "Something a setup readiness check reads has just been written" (epic #213,
 * child C12).
 *
 * C12 embeds real settings editors inside the wizard, so for the first time a
 * step's own facts can change WITHOUT the operator ever leaving the wizard tab.
 * The shell's only refetch until now was `focus` / `visibilitychange` (C5), and
 * both are deliberately about coming BACK to the tab — neither fires when a
 * panel three nodes down saves successfully. Left there, an operator who types
 * the club's real name into the inline editor, saves it, and looks up would
 * still be reading the readiness detail, the state badge and the rail percentage
 * that were true before they typed, with "Mark this step done" sitting above
 * them. The wizard would be showing a stale answer to the question it just
 * watched being answered.
 *
 * **The direction of the dependency is the whole point.** A panel that called
 * back into the wizard would be a panel that knows the wizard exists, and these
 * panels are shared: `ClubIdentityPanel` renders on
 * `/admin/appearance/identity`, `ClubTimeZonePanel` on `/admin/club-time`, and
 * C13's modules section will render on `/admin/modules`. So the panel announces
 * a FACT about the database — "I persisted something a setup check may read" —
 * which is true on every one of those pages, and anything deriving setup
 * readiness re-reads. Nothing here names the wizard, and a panel emitting into
 * a page with no listener costs one no-op dispatch.
 *
 * It is deliberately NOT keyed by step id. The wizard's read is one request for
 * the whole journey (`GET /api/admin/setup/wizard`) — there is no per-step
 * refetch to target — and a panel does not know which step ids its settings
 * feed. `club-config`'s editor is the club-identity panel, but the club name is
 * also read by checks the panel has never heard of.
 *
 * Same shape and same reasoning as `public-content-settings-events.ts` and
 * `member-onboarding-events.ts`: a window event, because the two sides are
 * siblings with no common client ancestor holding state, and `router.refresh()`
 * re-renders the server tree without touching either side's own fetched state.
 */
export const SETUP_READINESS_INPUT_CHANGED_EVENT =
  "admin:setup-readiness-input-changed";

/**
 * Announce that a setting one of the setup readiness checks reads was just
 * persisted. Safe to call from any admin client component, on any page — with
 * no listener mounted it does nothing.
 *
 * Call it only after the write has SUCCEEDED. Emitting optimistically would have
 * the wizard re-read the same values it already holds and report them as the
 * new truth, which is the stale-answer defect wearing a fresh timestamp.
 */
export function emitSetupReadinessInputChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SETUP_READINESS_INPUT_CHANGED_EVENT));
}
