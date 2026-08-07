// @vitest-environment jsdom

// The focus contract of `FocusedActionError`, and the ordering constraint that
// makes it work (#2597, #2635).
//
// Every consuming surface asserts "the permanently mounted recovery alert holds
// focus" through `expectRecoveryAlertToHoldFocus`. This file pins the guarantee
// itself once, on the shared component, including the case that dictates WHEN the
// focus is allowed to move — a failure raised from inside a closing dialog.

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FocusedActionError } from "@/components/focused-action-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const FAILURE = "The booking could not be confirmed. Reload before retrying.";

/**
 * Mirrors how the plain surfaces drive this component: an async action rejects,
 * and the same resumption both records the message and re-enables the control the
 * user pressed.
 */
function FailingAction({ attentionKey }: { attentionKey?: number }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <FocusedActionError
        id="recovery-alert"
        error={error}
        attentionKey={attentionKey}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void (async () => {
            setBusy(true);
            setError("");
            try {
              await Promise.reject(new Error(FAILURE));
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Failed.");
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        Confirm booking
      </button>
    </div>
  );
}

/**
 * The shape the deletion-request, member-Xero and booking-approval surfaces
 * actually have: the officer confirms in a dialog, the dialog closes, and the
 * failure lands on an alert OUTSIDE it. Radix traps focus inside an open dialog
 * and, on close, restores focus to whatever was focused when it opened —
 * `document.body` here, because clicking a button does not focus it. So this alert
 * is only allowed to take focus once that release has happened.
 */
function FailingDialogAction() {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  return (
    <div>
      <FocusedActionError id="recovery-alert" error={error} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve deletion request</DialogTitle>
            <DialogDescription>
              This cannot be undone once it completes.
            </DialogDescription>
          </DialogHeader>
          <textarea id="review-note" aria-label="Review note" />
          <button
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  await Promise.reject(new Error(FAILURE));
                } catch (caught) {
                  // Closing the dialog and raising the failure in the SAME
                  // resumption is what the real surfaces do (see
                  // `deletion-requests-client.tsx`, where `setReviewDialog(null)`
                  // and `setDeletionRecovery(...)` sit in one block). React
                  // batches them into one commit, so the dialog content is still
                  // mounted — focus trap and all — while this alert is populated.
                  setOpen(false);
                  setError(caught instanceof Error ? caught.message : "Failed.");
                }
              })();
            }}
          >
            Approve &amp; delete account
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

describe("FocusedActionError focus contract (#2635)", () => {
  it("takes focus when a failure arrives, and keeps it", async () => {
    render(<FailingAction />);
    const alert = document.getElementById("recovery-alert");
    expect(alert).not.toBeNull();
    expect(alert).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));

    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent(FAILURE);
    // The control the user pressed is usable again, and re-enabling it did not
    // take focus back off the explanation.
    expect(
      screen.getByRole("button", { name: "Confirm booking" }),
    ).toBeEnabled();
  });

  it("takes focus back when the same failure repeats", async () => {
    // A repeat of an identical message changes no rendered text, so the surfaces
    // bump `attentionKey` to re-run the effect. `rerender` settles the commit and
    // the effect, so focus is back on the alert with no further wait.
    const { rerender } = render(<FailingAction attentionKey={0} />);
    const alert = document.getElementById("recovery-alert");
    const button = screen.getByRole("button", { name: "Confirm booking" });

    fireEvent.click(button);
    await expectRecoveryAlertToHoldFocus(alert);

    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(<FailingAction attentionKey={1} />);
    expect(document.activeElement).toBe(alert);
  });

  it("wins the focus when the failure comes from a closing dialog", async () => {
    // The regression guard for the ordering constraint documented on the
    // component: focus must move only after the closing dialog has released its
    // focus scope. Make this a layout effect and the trap steals the focus back
    // and the release drops it on `<body>` — this test goes red, deterministically.
    render(<FailingDialogAction />);
    const alert = document.getElementById("recovery-alert");

    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & delete account" }),
    );

    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent(FAILURE);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByLabelText("Review note")).not.toBeInTheDocument();
  });
});
