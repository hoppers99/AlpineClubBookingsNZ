import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * INV-CONFIG-004: every application-controlled send goes through ONE
 * environment-aware boundary (ENV-SAFETY 2, #3035; epic #2986).
 *
 * WHAT THIS ADDS THAT THE TYPE SYSTEM DOES NOT. The primary guarantee is a type:
 * `getEmailTransporter` and `sendXeroInvoiceEmail` require a `DeliveryClearance`,
 * which only `environment-delivery-policy.ts` can mint and only when the
 * environment role resolved PRODUCTION, so a new sender cannot obtain a transport
 * without asking the policy. That is stronger than any census, because it is not
 * a list of the senders that exist today.
 *
 * It has exactly three holes, and this file closes all three:
 *
 * 1. **A new `nodemailer.createTransport` call.** Nothing stops a future module
 *    building its own transport from scratch, which is precisely what
 *    `cron-email-retry.ts` did before this issue — and why "one common boundary"
 *    was not the state of the tree.
 * 2. **A new `accountingApi.emailInvoice` call.** Asking Xero to email a member
 *    reaches no transport at all, so no clearance type stands in its way.
 * 3. **A cast.** `{} as unknown as DeliveryClearance` type-checks. The policy
 *    module refuses a forged token at runtime, so the cast fails closed rather
 *    than working — but it fails closed by throwing in production, and a source
 *    census catches it in review instead.
 *
 * `test:related` CANNOT select this file: it reads `src/` from disk with `fs`, so
 * it has no import edge to the files it scans. Run it explicitly, and expect CI
 * to be the backstop (`docs/TESTING.md`).
 */

const SRC = path.resolve(process.cwd(), "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);

const TRANSPORT_MODULE = "src/lib/email/internal.ts";
const POLICY_MODULE = "src/lib/environment-delivery-policy.ts";
const XERO_EMAIL_MODULE = "src/lib/xero-invoice-email.ts";

/**
 * The two modules that may hold a live delivery transport, and why each one is
 * allowed to rather than merely observed to.
 *
 * `email/core.ts` is `sendEmail`, the funnel every application message goes
 * through. `cron-email-retry.ts` is the replay job, which cannot go through
 * `sendEmail` because it re-transmits a body rendered by an earlier process
 * rather than rendering a new one. Anything else asking for a transport is a
 * third boundary, which is the thing this issue exists to prevent.
 */
const TRANSPORT_CONSUMERS = [
  "src/lib/cron-email-retry.ts",
  "src/lib/email/core.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (
      EXTENSIONS.has(path.extname(name)) &&
      !/\.test\.tsx?$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** Every production file under `src/` whose text matches, repo-relative, sorted. */
function filesMatching(pattern: RegExp): string[] {
  return walk(SRC)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map(repoRelative)
    .sort();
}

describe("email delivery boundary census (INV-CONFIG-004)", () => {
  it("creates a mail transport in exactly one module", () => {
    expect(
      filesMatching(/createTransport\s*\(/),
      "A mail transport may only be created in " +
        `${TRANSPORT_MODULE}, which requires a DeliveryClearance for the ` +
        "sending accessor and offers verifyEmailTransport() for a diagnostic " +
        "that must not be able to send. A transport built anywhere else is a " +
        "second delivery boundary that the environment-safety policy cannot " +
        "see — exactly what cron-email-retry.ts was before #3035. Call " +
        "getEmailTransporter(clearance) or verifyEmailTransport() instead " +
        "(INV-CONFIG-004).",
    ).toEqual([TRANSPORT_MODULE]);
  });

  it("hands a sending transport to exactly the two modules that funnel sends", () => {
    const consumers = filesMatching(/getEmailTransporter\s*\(/).filter(
      (file) => file !== TRANSPORT_MODULE,
    );
    expect(
      consumers,
      "Only the mailer and the retry cron may hold a sending transport. A new " +
        "caller means a new send path: put the message through sendEmail() so " +
        "it gets the EmailLog row, the placeholder/booking/suppression gates " +
        "and the environment-safety gate, rather than reaching for a transport " +
        "of its own (INV-CONFIG-004).",
    ).toEqual(TRANSPORT_CONSUMERS);
  });

  it("calls transporter.sendMail in exactly those two modules", () => {
    expect(
      filesMatching(/\.sendMail\s*\(/),
      "A message may only be handed to a provider from the mailer or the retry " +
        "cron (INV-CONFIG-004).",
    ).toEqual(TRANSPORT_CONSUMERS);
  });

  it("asks Xero to email an invoice in exactly one module", () => {
    expect(
      filesMatching(/accountingApi\.emailInvoice\s*\(/),
      "Asking Xero to email an invoice is a send to a real member's real " +
        `address, and it must go through ${XERO_EMAIL_MODULE}, which requires ` +
        "a DeliveryClearance. Three workflows raise invoices (booking, group " +
        "settlement, membership subscription) and all three call the wrapper; " +
        "a fourth call site here would be an ungated provider send " +
        "(INV-CONFIG-004).",
    ).toEqual([XERO_EMAIL_MODULE]);
  });

  /**
   * Every stack that points the app at mailpit must DECLARE it a capture.
   *
   * This guard exists because the defect it catches is invisible until the
   * browser suite runs. Since #3035 a non-production installation suppresses
   * every send unless its transport is declared to be a capture mailbox, so a
   * stack relaying to mailpit as an ordinary `USE_SMTP_RELAY` captures NOTHING —
   * and `e2e/two-factor-email.spec.ts` reads a real two-factor code back over
   * mailpit's HTTP API, so it and every other mail-reading spec fail with an
   * empty mailbox rather than with anything that names the cause.
   *
   * It is deliberately keyed on `EMAIL_SERVER_HOST=mailpit` — the only place in
   * this repository where a host name is allowed to imply anything, because this
   * is a test over the repository's own tracked configuration files and not a
   * runtime inference. The application itself never infers capture mode from a
   * host name; see `email-delivery.ts`.
   */
  it("declares USE_LOCAL_CAPTURE in every stack that relays to mailpit", () => {
    const STACKS = [
      "docker-compose.staging.yml",
      ".env.staging.example",
      ".github/workflows/e2e.yml",
      "measurement/stack/docker-compose.measure.yml",
    ];
    const offenders: string[] = [];
    for (const stack of STACKS) {
      const text = readFileSync(path.resolve(process.cwd(), stack), "utf8");
      const relaysToMailpit = /EMAIL_SERVER_HOST[:=]\s*"?mailpit"?/.test(text);
      if (!relaysToMailpit) continue;
      if (!/USE_LOCAL_CAPTURE[:=]\s*"?true"?/.test(text)) {
        offenders.push(`${stack}: relays to mailpit without USE_LOCAL_CAPTURE=true`);
      }
      if (/USE_SMTP_RELAY[:=]\s*"?true"?/.test(text)) {
        offenders.push(
          `${stack}: sets USE_SMTP_RELAY=true, which is a LIVE provider mode and is mutually exclusive with the capture mode`,
        );
      }
    }
    expect(
      offenders,
      "A stack pointed at mailpit must declare USE_LOCAL_CAPTURE=true. Without " +
        "it a non-production installation suppresses every send (#3035), mailpit " +
        "captures nothing, and every browser spec that reads mail back — " +
        "including the two-factor email code — fails with an empty mailbox and no " +
        "explanation (INV-CONFIG-004).",
    ).toEqual([]);
  });

  it("mints or casts a delivery clearance in exactly one module", () => {
    /*
      The cast shapes that defeat the brand: `as DeliveryClearance` and
      `<DeliveryClearance>`. The TYPE NAME alone is deliberately not matched —
      every consumer names it in a parameter type, which is the whole point of
      the design — so this looks for the assertion syntax only.
    */
    const casts = filesMatching(
      /\bas\s+(?:unknown\s+as\s+)?DeliveryClearance\b|<DeliveryClearance>/,
    );
    expect(
      casts,
      "A DeliveryClearance may only be produced inside " +
        `${POLICY_MODULE}, and only on the branch where the environment role ` +
        "resolved PRODUCTION. Casting one elsewhere forges the proof that this " +
        "installation is the club's live site. The policy module still refuses " +
        "a forged token at runtime, so such a cast throws rather than sends — " +
        "but it must not reach review at all. Call resolveDeliveryPolicy() and " +
        "use the clearance from its allow branch (INV-CONFIG-004).",
    ).toEqual([POLICY_MODULE]);
  });
});
