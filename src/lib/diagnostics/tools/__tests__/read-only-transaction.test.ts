/**
 * The shared read-only database seam (#2786) — the contract tests for it.
 *
 * TWO KINDS OF ASSERTION LIVE HERE and they prove different things.
 *
 * The BEHAVIOURAL ones drive `withBoundedReadOnlyTransaction` against a doubled
 * Prisma client and pin what reaches PostgreSQL: the isolation level, the two
 * control statements in their required order, the bound parameter carrying the
 * timeout, and the ordering of the three bounds. They can prove what the seam DOES.
 *
 * The SOURCE-LEVEL ones read the modules as text, because the behavioural ones
 * structurally cannot see the failure this seam exists to prevent. A stray
 * `prisma.booking.findMany(...)` written inside a callback is not a collaborator, so
 * no argument assertion sees it; it calls the same doubled function the transaction
 * client does, so no call-count assertion distinguishes it; and it would run outside
 * the snapshot AND outside the statement timeout while every test stayed green. The
 * only thing that can see it is a census over the source. That was #2376's own
 * conclusion (`booking-evidence.ts` says so in its docblock, and the pack census
 * carried the pin); #2786 moves the pin here and widens it from one module to every
 * `server_owned` evidence module.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMock = vi.fn();
const executeRawMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";
import {
  READ_ONLY_SEAM_EXEMPTIONS,
  READ_ONLY_SEAM_EXEMPTION_IDS,
  isReadOnlySeamExemptionId,
} from "../read-only-seam-exemptions";
import {
  DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS,
  DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
  withBoundedReadOnlyTransaction,
} from "../read-only-transaction";

const TOOLS_DIR = join(import.meta.dirname, "..");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

/**
 * EVERY pack module on disk, discovered rather than listed — and the anchor that
 * stops the discovery from silently finding nothing.
 *
 * A hand-written list was the first attempt and it failed in the way hand-written
 * lists fail: it named `booking-evidence.ts` and `finance-evidence.ts` and simply
 * omitted `packs/support-evidence.ts`, which holds the evidence functions for four
 * of the eight `server_owned` entries. The comment above it claimed the list was
 * "pinned against the registry itself below". It was not, and the cross-check it
 * promised would have caught the omission on the diff that introduced it.
 *
 * So the census reads the directory. The objection to a glob is real — a glob can
 * silently shrink — and `PACK_CENSUS_ANCHORS` is the answer to it: the discovered
 * set must CONTAIN these, so renaming or moving a module out of `packs/` fails here
 * rather than quietly leaving the loop with one fewer thing to check. Discovery
 * handles the other direction, which is the one that actually bit: a NEW module
 * cannot escape by not being added to a list.
 */
const PACK_MODULES: readonly string[] = readdirSync(join(TOOLS_DIR, "packs"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `packs/${name}`)
  .sort();

/** Modules whose absence would mean the discovery above found the wrong place. */
const PACK_CENSUS_ANCHORS = [
  "packs/booking-evidence.ts",
  "packs/finance-evidence.ts",
  "packs/support-evidence.ts",
] as const;

/**
 * The three modules holding `server_owned` evidence functions. These are the ones
 * that must IMPORT the seam; the prisma census below covers every pack module,
 * because a pack module has no business reaching the global client whatever its
 * entries' source is.
 */
const SERVER_OWNED_EVIDENCE_MODULES = PACK_CENSUS_ANCHORS;

function toolsSource(relativePath: string): string {
  return readFileSync(join(TOOLS_DIR, relativePath), "utf8");
}

/**
 * The source with its comments removed.
 *
 * The docblocks discuss `prisma` by name on purpose — at length, because the whole
 * point of the seam is explained there — so a census that counted prose would break
 * on every wording change and teach the next author to widen it until it counted
 * nothing. Stripping first is what lets the assertion be exact.
 */
function strippedCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the seam opens ONE bounded read-only transaction (#2786)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeRawMock.mockResolvedValue(0);
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) =>
        run({ $executeRaw: executeRawMock }),
    );
  });

  it("runs the caller's work at REPEATABLE READ, read-only, with a bounded wait", async () => {
    const result = await withBoundedReadOnlyTransaction(async () => "answer");

    expect(result).toBe("answer");
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        // Not the Prisma default. READ COMMITTED takes a fresh snapshot per
        // STATEMENT, so an evidence row assembled across several statements could
        // mix instants — which is exactly what these entries promise they do not.
        isolationLevel: "RepeatableRead",
        maxWait: 2_000,
        timeout: DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
      }),
    );
  });

  it("tells PostgreSQL READ ONLY before anything else, then sets the timeout", async () => {
    await withBoundedReadOnlyTransaction(async () => null);

    expect(executeRawMock).toHaveBeenCalledTimes(2);
    // Order is the property, not merely presence: a read issued before the refusal
    // is established would run in a transaction that still permits writes.
    expect(executeRawMock.mock.calls[0]?.[0]?.[0]).toBe(
      "SET TRANSACTION READ ONLY",
    );
    expect(executeRawMock.mock.calls[1]?.[0]?.[0]).toContain(
      "set_config('statement_timeout', ",
    );
  });

  it("binds the timeout as a PARAMETER rather than building it into the SQL", async () => {
    await withBoundedReadOnlyTransaction(async () => null);

    // `SET LOCAL statement_timeout = $1` is not valid PostgreSQL — `SET` takes no
    // placeholders — so the seam uses `set_config(..., is_local => true)`, whose
    // value IS an ordinary bound parameter. The tagged template's static strings
    // therefore end at the parameter slot, and the value arrives beside them.
    expect(executeRawMock.mock.calls[1]?.[0]?.[1]).toBe(", true)");
    expect(executeRawMock.mock.calls[1]?.[1]).toBe(
      String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS),
    );
  });

  it("hands the caller the TRANSACTION client, not the global one", async () => {
    const tx = { $executeRaw: executeRawMock, marker: Symbol("tx") };
    transactionMock.mockImplementation(
      async (run: (client: unknown) => Promise<unknown>) => run(tx),
    );

    const received = await withBoundedReadOnlyTransaction(async (client) => client);

    // Identity, as #2376 established: a collaborator that received anything else
    // would be reading outside both the snapshot and the timeout.
    expect(received).toBe(tx);
  });

  it("lets a rejection out rather than converting it into a row", async () => {
    const failure = new Error("the database stopped answering");
    await expect(
      withBoundedReadOnlyTransaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("derives both database bounds from the ONE existing source, in order", () => {
    // The statement timeout is not a second literal beside `DIAGNOSTICS_TOOL_BOUNDS`
    // — it IS that value. Two names for one bound is how the SELECT-only executor's
    // timeout and the server-owned one silently diverged before this PR.
    expect(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS).toBe(
      DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
    );
    // And the ceiling sits strictly above it, so PostgreSQL's own cancellation is
    // what a slow read hits: the operator gets the specific `57014 query_canceled`
    // refusal rather than a generic Prisma transaction timeout.
    expect(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS).toBeLessThan(
      DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
    );
  });
});

describe("the seam is the ONLY place the global client is reached (#2786)", () => {
  it("reaches exactly one property on the global Prisma client", () => {
    const source = toolsSource("read-only-transaction.ts");
    const code = strippedCode(source);

    expect(code.match(/prisma\.[A-Za-z$]+/g)).toEqual(["prisma.$transaction"]);
    // Non-vacuous: the stripped code still holds the import the census is about, so
    // a single match means "one reference", never "the strip ate the file".
    expect(code).toContain('import { prisma } from "@/lib/prisma"');
    // And it still holds the RUNTIME BODY. This was a `length > source/8` ratio,
    // which is a proxy for the property rather than the property — and a brittle
    // one: moving the exemption table to its own module (#2786) left a file that is
    // mostly docblock by design, so the ratio failed while nothing it existed to
    // protect had changed. Naming the code that must survive the strip says what is
    // actually meant and does not move when the prose does.
    expect(code).toContain("export async function withBoundedReadOnlyTransaction");
    expect(code).toContain("isolationLevel");
  });

  it("executes exactly the two control statements and nothing unsafe", () => {
    const code = strippedCode(toolsSource("read-only-transaction.ts"));

    expect(code.match(/\$executeRaw`/g)).toHaveLength(2);
    expect(code).not.toContain("$executeRawUnsafe");
    expect(code).not.toContain("$queryRawUnsafe");
    // A literal beside a constant of the same name is how the two diverge: narrow
    // the constant and PostgreSQL keeps cancelling at the old value while the
    // transaction ceiling drops below it, inverting which bound fires first.
    expect(code).not.toContain("statement_timeout = '");
  });

  it("does not nest a second transaction inside the callback", () => {
    const code = strippedCode(toolsSource("read-only-transaction.ts"));

    // One `$transaction` call, and it is the one that opens the seam. A nested
    // interactive transaction would take a second pool connection and a second
    // snapshot — the starvation shape `docs/CONCURRENCY_AND_LOCKING.md` forbids.
    expect(code.match(/\$transaction\(/g)).toHaveLength(1);
  });

  it("is server-only, like every module holding the application's client", () => {
    expect(toolsSource("read-only-transaction.ts")).toContain(
      'import "server-only"',
    );
  });
});

describe("what the seam cannot cover is DECLARED, not assumed (#2786)", () => {
  it("is a closed world: exactly these rows, in this order", () => {
    // Pinning the id set exactly is the point. A sixth exemption is a decision
    // somebody has to make in a diff and argue for in review, not something that
    // appears because a new entry found the seam inconvenient.
    //
    // The fifth row is here because the definition-time check FOUND it: the AID-7
    // plan predicted four, and making the readiness entry answer for itself
    // surfaced a module-flags read on the global client that no row named.
    expect(READ_ONLY_SEAM_EXEMPTION_IDS).toEqual([
      "readiness-own-pool",
      "readiness-module-flags-fault-tolerant",
      "deployment-no-database",
      "usage-summary-no-tx-client",
      "cron-runs-own-budget",
    ]);
  });

  it("gives every row a real module, symbol and reason", () => {
    for (const exemption of READ_ONLY_SEAM_EXEMPTIONS) {
      expect(exemption.id.trim().length, exemption.id).toBeGreaterThan(0);
      expect(exemption.module, exemption.id).toMatch(/^src\/.+\.ts$/);
      expect(exemption.symbol.trim().length, exemption.id).toBeGreaterThan(0);
      // A one-word reason is not a reviewed reason. The row has to say what makes
      // the code STRUCTURALLY unable to run inside the seam.
      expect(exemption.reason.length, exemption.id).toBeGreaterThan(80);
    }
  });

  it("names code that actually exists, at the module and symbol it claims", () => {
    // The reason a table like this rots is that the code moves and the row does
    // not, leaving a declaration that reads as a reviewed decision while pointing
    // at nothing. Reading the file is what stops that.
    //
    // COMMENTS ARE STRIPPED FIRST (#2786 review). Searching the raw source would
    // accept a symbol that survives only in a docblock discussing the function
    // somebody deleted — which is precisely the rot this test exists to catch, and
    // the deletion is the moment it most needs to fire.
    for (const exemption of READ_ONLY_SEAM_EXEMPTIONS) {
      const source = readFileSync(
        join(REPO_ROOT, ...exemption.module.split("/")),
        "utf8",
      );
      expect(strippedCode(source), exemption.id).toContain(exemption.symbol);
    }
  });

  it("states the residual wherever the reason does not already contain it", () => {
    // Two rows carry one. The module-flags row, whose first draft claimed a fault
    // marker the operator does not always get; and the cron-runs row, which is a
    // design choice rather than a structural impossibility and now says so. A
    // residual is optional because the other three genuinely have none — a read
    // that touches no database is simply outside the seam's subject. What is NOT
    // optional is that a row which has one states it at length rather than in
    // passing, which is how the first one went wrong.
    const withResidual = READ_ONLY_SEAM_EXEMPTIONS.filter(
      (exemption) => exemption.residual !== undefined,
    );
    expect(withResidual.map((exemption) => exemption.id)).toEqual([
      "readiness-module-flags-fault-tolerant",
      "cron-runs-own-budget",
    ]);
    for (const exemption of withResidual) {
      expect(exemption.residual!.length, exemption.id).toBeGreaterThan(120);
    }
  });

  it("has no duplicate ids, and recognises exactly its own", () => {
    expect(new Set(READ_ONLY_SEAM_EXEMPTION_IDS).size).toBe(
      READ_ONLY_SEAM_EXEMPTION_IDS.length,
    );
    for (const id of READ_ONLY_SEAM_EXEMPTION_IDS) {
      expect(isReadOnlySeamExemptionId(id), id).toBe(true);
    }
    expect(isReadOnlySeamExemptionId("readiness-own-pools")).toBe(false);
    expect(isReadOnlySeamExemptionId("")).toBe(false);
  });
});

describe("the modules the seam exists for (#2786)", () => {
  it.each(SERVER_OWNED_EVIDENCE_MODULES)(
    "%s imports the seam and is server-only",
    (relativePath) => {
      const source = toolsSource(relativePath);
      expect(source).toContain('import "server-only"');
      expect(source).toContain("read-only-transaction");
    },
  );

  it("discovered the pack directory, and all of it", () => {
    // The guard on the guard. If `readdirSync` ever pointed somewhere else, every
    // assertion below would pass over an empty list and this file would report a
    // tree-wide census while checking nothing — which is the exact failure this
    // whole block was written to correct.
    for (const anchor of PACK_CENSUS_ANCHORS) {
      expect(PACK_MODULES, `${anchor} is not in the discovered set`).toContain(
        anchor,
      );
    }
    expect(PACK_MODULES.length).toBeGreaterThanOrEqual(
      PACK_CENSUS_ANCHORS.length,
    );
  });

  it.each(PACK_MODULES)("%s names the global Prisma client nowhere", (relativePath) => {
    // THE GUARD THE UNIT DOUBLES CANNOT BE, APPLIED TREE-WIDE.
    //
    // `booking-membership-pack.test.ts` has made this assertion about
    // `booking-evidence.ts` since #2786's first commit, and both that file and the
    // seam module's own docblock described a tree-wide version of it living here.
    // It did not exist: this block checked only that two named modules imported the
    // seam. So `support-evidence.ts` — threaded by this very PR — had no census at
    // all, and a read written on the global client there would have compiled,
    // linted, passed knip and passed all 1957 diagnostics tests while running on
    // the application's full-privilege connection, outside the READ ONLY fence and
    // outside the statement timeout.
    //
    // The Proxy escape recorders in the pack tests do not close this. They record
    // only while a transaction callback is OPEN, so a read placed BEFORE the seam
    // is invisible to them — and that pre-seam shape is precisely what produced
    // exemption five. A source census is the only thing that sees it.
    //
    // It covers every pack module rather than only the evidence ones, because a
    // pack module has no business reaching the global client whatever its entries'
    // source is, and "which modules count" is one more thing nobody then has to
    // remember.
    const source = toolsSource(relativePath);
    const code = strippedCode(source);

    expect(code.match(/prisma\.[A-Za-z$]+/g)).toBeNull();
    expect(code).not.toContain('from "@/lib/prisma"');
    // Non-vacuous: the strip left real code behind, so a null match means "reaches
    // the client nowhere" rather than "the strip ate the file".
    expect(code.trim().length, `${relativePath} stripped to nothing`).toBeGreaterThan(0);
    expect(code, relativePath).toContain('import "server-only"');
  });
});
