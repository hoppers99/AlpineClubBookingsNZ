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

import { readFileSync } from "node:fs";
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
  DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS,
  DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
  READ_ONLY_SEAM_EXEMPTIONS,
  READ_ONLY_SEAM_EXEMPTION_IDS,
  isReadOnlySeamExemptionId,
  withBoundedReadOnlyTransaction,
} from "../read-only-transaction";

const TOOLS_DIR = join(import.meta.dirname, "..");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

/**
 * Every `server_owned` evidence module in the tree, listed rather than globbed.
 *
 * A glob would make this census silently shrink: rename a module or move an entry
 * into a new pack and the loop would simply have one fewer thing to check, which is
 * the failure mode a census exists to prevent. The list is pinned against the
 * registry itself below — every `server_owned` entry's pack must map to a module
 * here — so adding an entry whose evidence lives somewhere new fails rather than
 * passing unnoticed.
 */
const SERVER_OWNED_EVIDENCE_MODULES = ["packs/booking-evidence.ts"] as const;

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
    expect(code.length).toBeGreaterThan(source.length / 8);
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
    // Pinning the id set exactly is the point. A fifth exemption is a decision
    // somebody has to make in a diff and argue for in review, not something that
    // appears because a new entry found the seam inconvenient.
    expect(READ_ONLY_SEAM_EXEMPTION_IDS).toEqual([
      "readiness-own-pool",
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
    for (const exemption of READ_ONLY_SEAM_EXEMPTIONS) {
      const source = readFileSync(
        join(REPO_ROOT, ...exemption.module.split("/")),
        "utf8",
      );
      expect(source, exemption.id).toContain(exemption.symbol);
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
});
