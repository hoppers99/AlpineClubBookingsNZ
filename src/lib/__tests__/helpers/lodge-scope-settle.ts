// Settle-before-interact for a lodge-scoped admin page whose calendar is mocked
// (#2944, investigated under #2885).
//
// THIS IS AN ORDERING FIX, NOT A TIMEOUT FIX. It exists precisely so that the
// suites using it do NOT depend on the repo-wide RTL async window in
// `vitest.setup.ts`. Widening a window around the bug below turns it into a slow
// pass; the failure it produces is a synchronous assertion, which no window can
// reach. Both halves of that are measured — see the numbers at the bottom.
//
// The bug
// -------
// `/admin/hut-leaders` and `/admin/roster` render their date controls and their
// occupancy calendar together, behind the same `lodgeScopeReady` gate, and both
// pages reset workspace state in a `useEffect` keyed on the settled lodge:
//
//     useEffect(() => { …; setSelection({ startDate: "", endDate: "" }); … },
//               [scopedLodgeId]);
//
// In the browser those two things cannot collide. React flushes pending passive
// effects before dispatching a discrete input event, so by the time a real click
// on a calendar day is handled, the reset has already run.
//
// In a suite that MOCKS the calendar they can. The mock's "Pick …" button is in
// the DOM the moment that gated branch first commits, so `findByRole` can resolve
// on the very commit whose passive effects have not run yet, and `fireEvent`
// dispatches straight away. The page then applies the picked range, the pending
// reset effect fires immediately after, and the date inputs go back to empty. The
// test reads:
//
//     expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10")
//     → expected element to have value "2099-07-10", got ""
//
// on `/admin/hut-leaders` the damage is wider than one input, because step 2 of
// the assignment form ("Any member", "Select") only renders once dates are
// chosen. Losing the selection removes those controls entirely, and the suite
// then fails as `Unable to find role="button" and name "Any member"` — which
// reads like a missing element and got this filed as flake.
//
// Why the margin is so thin, and why load decides it: `@testing-library/react`'s
// `asyncWrapper` drains exactly one `setTimeout(0)` after an async utility's
// callback succeeds, which is normally enough for React's Scheduler to land the
// passive effects first. Under contention the Scheduler yields and reschedules,
// the single drain is no longer enough, and the click goes in early. The same
// one-turn library-internal margin is documented from the other side in
// `./focus.ts` (#2635).
//
// Product-side conclusion, confirmed under #2885: this is TEST-ONLY. Both pages
// gate the real date inputs behind nested `lodgeScopeReady` checks, and a probe
// against the real page with a deferred lodges API showed the pre-settle DOM is
// 563 characters — header and notice only. There is nothing for a user to click
// early.
//
// Measured for #2944, on `occupancy-calendar-pages.test.tsx` under 12 competing
// CPU burners, with the RTL async window already widened to 4,000ms and
// `testTimeout` raised to 60,000ms so that neither ceiling could be the cause:
// 1 failure in 30 runs, on the synchronous `toHaveValue` assertion. With the
// settle below and the RTL window put BACK to its 1,000ms default: 30/30 green.
import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";

type FetchCallRecorder = { mock?: { calls?: unknown[][] } };

/**
 * Wait until a lodge-scoped admin page has finished settling its lodge scope,
 * before the test interacts with a mocked calendar.
 *
 * The signal is the page's own first lodge-scoped read. Both pages issue it from
 * an effect declared AFTER the reset effect above, and React runs a commit's
 * effects in declaration order, so observing the read is proof the reset has
 * already happened and cannot still be queued behind the interaction.
 *
 * @param scopedReadUrlPrefix the start of the URL the page fetches once its lodge
 *   is settled — for example `"/api/admin/hut-leaders?lodgeId="`. Matched against
 *   the calls recorded on the suite's `vi.stubGlobal("fetch", …)` mock.
 */
export async function settleLodgeScopedPage(
  scopedReadUrlPrefix: string,
): Promise<void> {
  const calls = (globalThis.fetch as unknown as FetchCallRecorder)?.mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(
      "settleLodgeScopedPage: global fetch is not a vitest mock. Stub it with " +
        "vi.stubGlobal(\"fetch\", vi.fn(…)) before rendering the page, so the " +
        "page's lodge-scoped read can be observed.",
    );
  }

  await waitFor(() => {
    expect(
      calls.some(([input]) => String(input).startsWith(scopedReadUrlPrefix)),
      `the page has not issued its lodge-scoped read (${scopedReadUrlPrefix}…) ` +
        "yet, so its lodge scope has not settled",
    ).toBe(true);
  });

  // The read proves the effects of the settling commit have run. This lets
  // anything they queued in turn — a `setTimeout(0)`, a Scheduler task — land as
  // well, so the interaction that follows starts from a quiet page rather than
  // from whichever instant the previous poll happened to catch.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}
