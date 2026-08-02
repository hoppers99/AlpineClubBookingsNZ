/**
 * The #2525 execution seam for booking-policy exception requests.
 *
 * #2524 (this lane) builds only request CREATION and the member cancel/supersede
 * transitions. It deliberately does NOT reserve provisional capacity for a held
 * request, and it never touches the live booking or creates a booking on
 * approval. Those are #2525 (TLR-8B), which must make the two canonical booking
 * services transaction-aware and then implement the functions declared here.
 *
 * They exist NOW, as throwing stubs with their final signatures, so that:
 *   - the request-creation service can name the exact boundary it stops at
 *     (see `booking-exception-request-service.ts`), and
 *   - #2525 has a compile-checked contract to fill in rather than a prose TODO.
 *
 * Every function here is a no-op that throws `ExceptionExecutionNotImplementedError`.
 * Nothing in the request-creation path calls them; they are the forward contract.
 */

import type { PolicyExceptionRequestStatus } from "@/lib/booking-exception-requests";

/**
 * Thrown by every #2525 boundary stub. A distinct class (not a bare Error) so a
 * caller — or a test — can assert precisely that it reached the unimplemented
 * seam and not some other failure.
 */
export class ExceptionExecutionNotImplementedError extends Error {
  /** The issue that owns the implementation. */
  readonly issue = "#2525";
  constructor(seam: string) {
    super(
      `${seam} is the #2525 approve-and-execute seam and is not implemented by #2524 (request creation only).`,
    );
    this.name = "ExceptionExecutionNotImplementedError";
  }
}

/**
 * Reserve the provisional per-night capacity a HELD request holds while pending.
 * #2525 composes `computeProposalReservation` (already pure in
 * `booking-exception-requests.ts`) with the canonical capacity ledger under the
 * global -> per-lodge lock order. The new-booking flavour reserves the FULL
 * proposal; the modification flavour reserves only the incremental beds.
 */
export function reserveExceptionRequestProposalCapacity(args: {
  requestId: string;
  source: "NEW_BOOKING" | "MODIFICATION";
}): Promise<never> {
  return Promise.reject(
    new ExceptionExecutionNotImplementedError(
      `reserveExceptionRequestProposalCapacity(${args.source}:${args.requestId})`,
    ),
  );
}

/**
 * Approve a NEW-booking exception request and, atomically in one transaction,
 * revalidate every hard constraint + current policy versions against the frozen
 * proposal, claim the request with its guarded `version` token, and invoke the
 * canonical booking-creation service — overriding ONLY the reviewed soft
 * violations that still trip unchanged (see `classifyPolicyExceptionDrift`).
 * Sets the request's `createdBookingId` and NULLs its `openStateKey`.
 */
export function approveAndExecuteNewBookingExceptionRequest(args: {
  requestId: string;
  reviewedByMemberId: string;
  expectedVersion: number;
}): Promise<never> {
  return Promise.reject(
    new ExceptionExecutionNotImplementedError(
      `approveAndExecuteNewBookingExceptionRequest(${args.requestId})`,
    ),
  );
}

/**
 * Approve a MODIFICATION exception request (a POLICY_EXCEPTION BookingChangeRequest)
 * and, atomically, revalidate hard constraints + drift against the frozen base and
 * proposed snapshots, claim the request, and invoke the canonical modification
 * service. The live booking is untouched until this runs. NULLs `openStateKey`.
 */
export function approveAndExecuteModificationExceptionRequest(args: {
  requestId: string;
  reviewedByMemberId: string;
  expectedVersion: number;
}): Promise<never> {
  return Promise.reject(
    new ExceptionExecutionNotImplementedError(
      `approveAndExecuteModificationExceptionRequest(${args.requestId})`,
    ),
  );
}

/**
 * The terminal status an approval settles a request to once #2525 executes it.
 * Declared here (rather than inlined) so the request-creation lane and #2525
 * agree that APPROVED is the execution outcome, distinct from the releasing
 * terminals this lane owns.
 */
export const EXECUTION_APPROVED_STATUS: PolicyExceptionRequestStatus = "APPROVED";
