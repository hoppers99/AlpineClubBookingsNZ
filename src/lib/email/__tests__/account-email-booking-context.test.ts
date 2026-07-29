import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2258 — the ACCOUNT-LOCKOUT guarantee, pinned statically.
 *
 * The per-booking "No emails" switch must never be able to withhold a
 * two-factor code, a password reset, a magic-link login or an email-change
 * notice. Withholding those is not a mail preference — it locks a member out of
 * their own account, with no way for them to tell why.
 *
 * That guarantee rests on one thing: every sender in `src/lib/email/account.ts`
 * passes `bookingContext: "none"`, so the gate short-circuits before it ever
 * reads a switch. Nothing else enforces it — the runtime gate tests can only
 * prove that `"none"` short-circuits, not that these senders keep passing it.
 * A single future edit threading a bookingId into one of these senders would
 * silently arm the switch against account mail and no behavioural test in the
 * repo would notice. So assert it on the SOURCE.
 */

const ACCOUNT_SENDER_SOURCE = readFileSync(
  join(process.cwd(), "src/lib/email/account.ts"),
  "utf8",
);

// Every `sendEmail({ ... })` call in the file, as a source slice.
function sendEmailCallBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = "sendEmail({";
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let cursor = index + marker.length - 1;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(index, cursor + 1));
    index = source.indexOf(marker, cursor);
  }
  return bodies;
}

describe("account and security email senders (#2258 account-lockout guarantee)", () => {
  const calls = sendEmailCallBodies(ACCOUNT_SENDER_SOURCE);

  it("finds every account sender (guards against the parser silently matching nothing)", () => {
    // 10 senders today: password reset, magic link, admin password reset,
    // member setup invite, two-factor code, email verification, email-change
    // verification, email-change notification, account-deletion approved and
    // rejected. This number may legitimately grow; it must never collapse to 0.
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('passes bookingContext: "none" on every single send', () => {
    const offenders = calls
      .filter((body) => !/bookingContext:\s*"none"/.test(body))
      .map((body) => /templateName:\s*"([^"]+)"/.exec(body)?.[1] ?? body.slice(0, 80));

    expect(offenders).toEqual([]);
  });

  it("never threads a booking id into an account or security email", () => {
    const offenders = calls
      .filter((body) => /bookingContext:\s*\{/.test(body))
      .map((body) => /templateName:\s*"([^"]+)"/.exec(body)?.[1] ?? body.slice(0, 80));

    expect(offenders).toEqual([]);
  });

  it("covers the four senders whose suppression would be outright account lockout", () => {
    for (const templateName of [
      "two-factor-code",
      "password-reset",
      "magic-link-login",
      "email-change-notification",
    ]) {
      const call = calls.find((body) =>
        new RegExp(`templateName:\\s*"${templateName}"`).test(body),
      );
      expect(call, `no sendEmail call found for ${templateName}`).toBeDefined();
      expect(call).toMatch(/bookingContext:\s*"none"/);
    }
  });
});
