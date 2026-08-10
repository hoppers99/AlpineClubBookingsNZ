import { NextResponse } from "next/server";

import {
  HOSTING_COVERAGE_RETRY_BODY,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";

/**
 * Convert only the stable participant-fence retry signal into its one public
 * interactive response. Automated callers deliberately do not use this helper:
 * they must throw so their cron/webhook/outbox retry contract remains intact.
 */
export function hostingCoverageParticipantRetryResponse(
  error: unknown,
  recovery?: Readonly<Record<string, unknown>>,
): NextResponse | null {
  return isHostingCoverageParticipantRetry(error)
    ? NextResponse.json(
        { ...(recovery ?? {}), ...HOSTING_COVERAGE_RETRY_BODY },
        { status: 409 },
      )
    : null;
}
