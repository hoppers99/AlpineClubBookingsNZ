/**
 * Client-only wire contract for #2576's officer hosting-coverage override.
 *
 * Keep this module free of Prisma, Node crypto and server-only imports. The server
 * owns the digest; browser surfaces only validate and return the opaque versioned
 * correlator with the exact rejected mutation.
 */

export interface HostingCoverageStrandedBooking {
  bookingId: string;
  reference: string;
  lodgeName: string;
  nights: string[];
}

export interface HostingCoverageOverridePromptData {
  message: string;
  strandedStateKey: string;
  strandedBookings: HostingCoverageStrandedBooking[];
}

const STATE_KEY_PATTERN = /^v1:[0-9a-f]{64}$/;
const LODGE_NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Fail closed unless the complete typed 409 body is present. */
export function readHostingCoverageOverridePrompt(
  value: unknown,
): HostingCoverageOverridePromptData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.code !== "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED" ||
    record.requiresOverrideReason !== true ||
    typeof record.error !== "string" ||
    record.error.trim().length === 0 ||
    typeof record.strandedStateKey !== "string" ||
    !STATE_KEY_PATTERN.test(record.strandedStateKey) ||
    !Array.isArray(record.strandedBookings) ||
    record.strandedBookings.length === 0
  ) {
    return null;
  }

  const strandedBookings: HostingCoverageStrandedBooking[] = [];
  for (const value of record.strandedBookings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.bookingId !== "string" ||
      row.bookingId.length === 0 ||
      typeof row.reference !== "string" ||
      row.reference.trim().length === 0 ||
      typeof row.lodgeName !== "string" ||
      row.lodgeName.trim().length === 0 ||
      !Array.isArray(row.nights) ||
      row.nights.length === 0 ||
      !row.nights.every(
        (night) => typeof night === "string" && LODGE_NIGHT_PATTERN.test(night),
      )
    ) {
      return null;
    }
    strandedBookings.push({
      bookingId: row.bookingId,
      reference: row.reference,
      lodgeName: row.lodgeName,
      nights: row.nights as string[],
    });
  }

  return {
    message: record.error,
    strandedStateKey: record.strandedStateKey,
    strandedBookings,
  };
}

/**
 * Stable browser-side identity for the exact mutation that received the prompt.
 * This is not authority or a security token; it only retires a prompt as soon as
 * any proposal field or notification choice changes.
 */
export function hostingCoverageMutationSignature(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return input;
  }
  return JSON.stringify(canonical(value));
}
