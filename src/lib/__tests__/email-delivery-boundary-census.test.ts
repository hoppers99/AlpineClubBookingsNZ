import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  composeFiles,
  composeServices,
  readRepoFile,
} from "@/lib/__tests__/helpers/compose";

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

// ---------------------------------------------------------------------------
// Configuration BLOCKS, for the capture-declaration case below.
// ---------------------------------------------------------------------------

/** One place a transport can be configured, with an id a reader can act on. */
type ConfigBlock = { id: string; text: string };

/**
 * Comments stripped the way this repository's own dotenv reader strips them:
 * a whole-line `#`, and an inline `#` preceded by whitespace.
 *
 * Needed because `.env.example` and `.env.staging.example` both EXPLAIN the
 * mutually-exclusive rule in prose containing `USE_LOCAL_CAPTURE=true`, and a
 * guard satisfied by its own documentation is a guard that has stopped working.
 */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

/** `NAME: "true"` / `NAME='TRUE'` / `NAME=true`, quoting and case normalised. */
function flagIsTrue(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*[:=]\\s*["']?\\s*true\\s*["']?`, "i").test(text);
}

/** A relay host this repository's own configuration files use as a capture. */
const CAPTURE_HOST = /\bEMAIL_SERVER_HOST\s*[:=]\s*["']?(mailpit|mailhog)\b/i;

/**
 * Every discovered block in which a transport could be configured: each tracked
 * dotenv file, each workflow env heredoc, and — per Compose file — the shared
 * anchor plus every individual service.
 *
 * DISCOVERED, NOT LISTED. A hardcoded four-element array of stacks left a fifth
 * unguarded, and iterating whole FILES let one correct block excuse a sibling.
 */
function captureCandidateBlocks(): ConfigBlock[] {
  const root = process.cwd();
  const blocks: ConfigBlock[] = [];

  for (const name of readdirSync(root).sort()) {
    if (!/^\.env($|\.)/.test(name)) continue;
    blocks.push({ id: name, text: withoutComments(readRepoFile(name)) });
  }

  const workflows = path.join(root, ".github", "workflows");
  for (const name of readdirSync(workflows).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(path.join(workflows, name), "utf8");
    const opener = /cat > ([^\s]+) <<'?EOF'?/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = opener.exec(text)) !== null) {
      index += 1;
      const rest = text.slice(match.index + match[0].length);
      const end = rest.indexOf("\nEOF");
      blocks.push({
        id: `.github/workflows/${name} -> ${match[1]} #${index}`,
        text: withoutComments(end === -1 ? rest : rest.slice(0, end)),
      });
    }
  }

  for (const file of composeFiles) {
    const text = readRepoFile(file);
    const anchor = text.indexOf("x-app-environment:");
    if (anchor > -1) {
      const rest = text.slice(anchor);
      const end = rest.search(/\n[^\s#]/);
      blocks.push({
        id: `${file} -> x-app-environment`,
        text: withoutComments(end === -1 ? rest : rest.slice(0, end)),
      });
    }
    for (const [service, body] of composeServices(file)) {
      blocks.push({ id: `${file} -> ${service}`, text: withoutComments(body) });
    }
  }

  return blocks;
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
    /*
      `\.emailInvoice\s*\(` rather than `accountingApi\.emailInvoice\s*\(`. The
      narrower form was defeated by three ORDINARY tidy-ups, all measured:
      `const api = xero.accountingApi; api.emailInvoice(...)`,
      `const { emailInvoice } = xero.accountingApi`, and
      `xero.accountingApi["emailInvoice"](...)`. Aliasing a long provider
      accessor is exactly the kind of edit nobody thinks twice about. Widening is
      free: all twenty `accountingApi` accesses under `src/` use the literal
      `xero.accountingApi` receiver today, so the wider pattern still resolves to
      exactly this wrapper.
    */
    expect(
      filesMatching(/\.emailInvoice\s*\(/),
      "Asking Xero to email an invoice is a send to a real member's real " +
        `address, and it must go through ${XERO_EMAIL_MODULE}, which requires ` +
        "a DeliveryClearance. Three workflows raise invoices (booking, group " +
        "settlement, membership subscription) and all three call the wrapper; " +
        "a fourth call site here would be an ungated provider send " +
        "(INV-CONFIG-004).",
    ).toEqual([XERO_EMAIL_MODULE]);
  });

  /**
   * Every BLOCK that points the app at a capture container must DECLARE it a
   * capture.
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
   *
   * THREE THINGS A PROBE BROKE IN THE FIRST VERSION, all fixed here:
   *
   * 1. It tested WHOLE-FILE text, so one correct declaring block satisfied a
   *    file holding several. Reproduced on a synthetic two-heredoc file: it
   *    PASSED. Both `e2e.yml` heredocs happen to be right today, but either one
   *    being right satisfied the file.
   * 2. It iterated a hardcoded four-element list of stacks, so a fifth stack was
   *    unguarded. The blocks are now DISCOVERED.
   * 3. It matched only double quotes and only lower case, so
   *    `USE_SMTP_RELAY: 'true'` evaded the mutual-exclusion check — the UNSAFE
   *    direction — while `USE_LOCAL_CAPTURE: 'true'` was a false positive.
   *    `parseBooleanFlag` is case-insensitive, so the guard and the application
   *    now normalise the same way.
   *
   * The RENDERED plumbing — whether a container is given the variable at all —
   * is a different question and is asserted in `env-delivery-census.test.ts`.
   * This one is about what the tracked files SAY.
   */
  it("declares USE_LOCAL_CAPTURE in every block that relays to a capture container", () => {
    const blocks = captureCandidateBlocks();

    // Anti-vacuity: discovery must actually find the blocks that exist today,
    // or this case judges nothing while passing. Named rather than counted, so a
    // block disappearing is a failure rather than a smaller number.
    const declaring = blocks
      .filter((block) => CAPTURE_HOST.test(block.text))
      .map((block) => block.id)
      .sort();
    expect(blocks.length, "no configuration blocks were discovered").toBeGreaterThan(6);
    expect(declaring).toEqual([
      ".env.staging.example",
      ".github/workflows/e2e.yml -> .env.staging #1",
      ".github/workflows/e2e.yml -> .env.staging #2",
      "measurement/stack/docker-compose.measure.yml -> app",
    ]);

    const offenders: string[] = [];
    for (const block of blocks) {
      if (!CAPTURE_HOST.test(block.text)) continue;
      if (!flagIsTrue(block.text, "USE_LOCAL_CAPTURE")) {
        offenders.push(`${block.id}: relays to a capture container without USE_LOCAL_CAPTURE=true`);
      }
      if (flagIsTrue(block.text, "USE_SMTP_RELAY")) {
        offenders.push(
          `${block.id}: sets USE_SMTP_RELAY=true, which is a LIVE provider mode and is mutually exclusive with the capture mode`,
        );
      }
      if (flagIsTrue(block.text, "USE_AWS_SES")) {
        offenders.push(
          `${block.id}: sets USE_AWS_SES=true, which is a LIVE provider mode and is mutually exclusive with the capture mode`,
        );
      }
    }
    expect(
      offenders,
      "A block pointed at a capture container must declare USE_LOCAL_CAPTURE=true " +
        "and no live provider flag. Without it a non-production installation " +
        "suppresses every send (#3035), the capture sees nothing, and every " +
        "browser spec that reads mail back — including the two-factor email code " +
        "— fails with an empty mailbox and no explanation (INV-CONFIG-004).",
    ).toEqual([]);
  });

  /**
   * Neither withheld-email renderer may blame one state for the other (#3035).
   *
   * Both render under TWO states — a confirmed copy, and an installation nobody
   * has declared — because both hold delivery back. "because it is treated as a
   * copy" is therefore false half the time, and false in the expensive direction:
   * the operator of an undeclared LIVE site goes looking for the safer override
   * instead of the missing declaration.
   *
   * A SOURCE census rather than a rendering test because
   * `environment-safety-panel.tsx` has no test harness at all, and inventing a
   * React suite to assert one sentence would be a worse trade than reading the
   * two functions. The readiness renderer's behaviour is separately exercised in
   * `setup-readiness.test.ts`, which drives the real check under both roles.
   */
  it("blames neither state for the other in the withheld-email renderers", () => {
    const RENDERERS = [
      "src/lib/setup-readiness.ts",
      "src/components/admin/environment-safety-panel.tsx",
    ];
    const offenders: string[] = [];
    for (const file of RENDERERS) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      /*
        COMMENTS ARE STRIPPED FIRST, and the region is bounded by the NEXT
        top-level declaration rather than by the next `}` on its own line. Both
        halves were learned from a probe: the first version sliced to the next
        newline-brace, which in the panel lands on the end of that function's own
        multi-line RETURN TYPE — so the slice was the signature alone, held none of
        the sentences, and the guard was VACUOUSLY GREEN for that file. Restoring
        the panel's old wording did not fail it. Docblocks are excluded because
        they deliberately QUOTE the wrong sentence in order to explain why it is
        wrong.
      */
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      const start = stripped.indexOf("function describeWithheldEmail");
      expect(start, `${file} should still define describeWithheldEmail`).toBeGreaterThan(-1);
      const rest = stripped.slice(start + 1);
      const nextDeclaration = rest.search(/\n(?:export )?function /);
      const body = nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
      // The assertion that stops this guard going vacuous again: the extracted
      // region must actually contain the sentences being judged.
      expect(
        body,
        `${file}: the extracted describeWithheldEmail body holds no wording to check — this guard would be vacuous`,
      ).toMatch(/held back on this installation|steady and recent count/);
      if (/treated as a copy|because it is a copy/i.test(body)) {
        offenders.push(`${file}: attributes the withholding to being a copy`);
      }
      if (/declared a copy/i.test(body) !== /undeclared/i.test(body)) {
        offenders.push(
          `${file}: names one of the two reasons without the other`,
        );
      }
    }
    expect(
      offenders,
      "Both of these render under a confirmed copy AND an undeclared " +
        "installation. A sentence naming one reason is wrong half the time, and " +
        "on an undeclared LIVE site it sends the operator to the safer override " +
        "instead of the missing declaration. Name both reasons or neither; the " +
        "surrounding surface already says which state applies (INV-CONFIG-004).",
    ).toEqual([]);
  });

  it("mints or casts a delivery clearance in exactly one module", () => {
    /*
      The cast shapes that defeat the brand: `as DeliveryClearance` and
      `<DeliveryClearance>`. The TYPE NAME alone is deliberately not matched —
      every consumer names it in a parameter type, which is the whole point of
      the design — so this looks for the assertion syntax only.

      BOTH BRANDS, and the second one is the important one. The first version
      matched `DeliveryClearance` only, so `as unknown as LiveProviderClearance`,
      `as LiveProviderClearance` and `<LiveProviderClearance>` were all MISSED
      (probed) — and that is the NARROWER, stronger token, the only one that opens
      the Xero invoice-email path to a real member's real inbox. The expectation
      is unchanged at `[POLICY_MODULE]`, so the alternation costs nothing.
    */
    const casts = filesMatching(
      /\bas\s+(?:unknown\s+as\s+)?(?:Delivery|LiveProvider)Clearance\b|<(?:Delivery|LiveProvider)Clearance>/,
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
