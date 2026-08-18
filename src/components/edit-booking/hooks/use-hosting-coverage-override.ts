"use client";

import { useEffect, useState } from "react";
import {
  hostingCoverageMutationSignature,
  type HostingCoverageOverridePromptData,
} from "@/lib/hosting-coverage-override-client";

/**
 * The refused save's hosting-coverage prompt, bound to the proposal it refused.
 */
export interface HostingOverrideState {
  prompt: HostingCoverageOverridePromptData;
  proposalSignature: string;
  notifyMemberChoice: boolean | undefined;
}

/**
 * Hold an officer's hosting-coverage override only while it still describes the
 * edit on screen.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690). The render-time comparison,
 * the derived `activeHostingOverrideState`, the effect's guard and its dependency
 * array are unchanged, and the hook owns all three slots the effect clears.
 *
 * `buildSavePayload` is called during RENDER, never from a dependency array, so
 * its identity is irrelevant and it is deliberately not memoised — exactly as it
 * was when both sat in the same component body.
 */
export function useHostingCoverageOverride(
  buildSavePayload: (notifyMemberChoice?: boolean) => Record<string, unknown>,
) {
  const [hostingOverrideState, setHostingOverrideState] =
    useState<HostingOverrideState | null>(null);
  const [hostingOverrideConfirmed, setHostingOverrideConfirmed] = useState(false);
  const [hostingOverrideReason, setHostingOverrideReason] = useState("");

  const hostingOverrideProposalStillCurrent = Boolean(
    hostingOverrideState &&
      hostingOverrideState.proposalSignature ===
        hostingCoverageMutationSignature(
          buildSavePayload(hostingOverrideState.notifyMemberChoice),
        ),
  );
  const activeHostingOverrideState = hostingOverrideProposalStillCurrent
    ? hostingOverrideState
    : null;

  useEffect(() => {
    if (hostingOverrideState && !hostingOverrideProposalStillCurrent) {
      setHostingOverrideState(null);
      setHostingOverrideConfirmed(false);
      setHostingOverrideReason("");
    }
  }, [hostingOverrideProposalStillCurrent, hostingOverrideState]);

  return {
    // `hostingOverrideState` itself is deliberately NOT returned: the panel must
    // read `activeHostingOverrideState`, which is null the moment the prompt
    // stops describing the edit on screen. Handing out the raw slot would let a
    // caller render a retired prompt.
    setHostingOverrideState,
    hostingOverrideConfirmed,
    setHostingOverrideConfirmed,
    hostingOverrideReason,
    setHostingOverrideReason,
    activeHostingOverrideState,
  };
}
