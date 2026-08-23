import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  /** Set false to simulate a Prisma client generated before this model existed. */
  delegatePresent: { value: true },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "environmentSafetySettings") {
          return h.delegatePresent.value
            ? { findUnique: h.findUnique }
            : undefined;
        }
        return undefined;
      },
    },
  ),
}));

import {
  ENVIRONMENT_SAFETY_SETTINGS_ID,
  ENVIRONMENT_SAFETY_SETTINGS_SELECT,
  getEnvironmentRole,
  resolveEnvironmentRole,
} from "@/lib/environment-role";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";

/**
 * The end-to-end resolver (ENV-SAFETY 1, #3034; epic #2986; INV-CONFIG-003).
 *
 * The twelve-row precedence table is asserted purely in
 * `environment-role-precedence.test.ts`. What is asserted HERE is everything
 * the pure function cannot see: that the declaration really is read from the
 * live process environment, that the database read is guarded and classified the
 * way the table assumes, that a heuristic signal cannot move the answer, and the
 * restore scenarios the issue names.
 *
 * `updatedAt` fixtures sit before the frozen 2026-07-01 clock; nothing here
 * depends on the real calendar.
 */

/** Every signal a lazier implementation might have reached for. */
const HEURISTIC_SIGNALS = [
  "NODE_ENV",
  "APP_RUNTIME_ROLE",
  "VERCEL_ENV",
  "DATABASE_URL",
  "NEXTAUTH_URL",
  "HOSTNAME",
  "DOMAIN",
] as const;

const PRODUCTION_LOOKING: Record<string, string> = {
  NODE_ENV: "production",
  APP_RUNTIME_ROLE: "web-blue",
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://tac:pw@postgres:5432/tacbookings",
  NEXTAUTH_URL: "https://bookings.example-club.org.nz",
  HOSTNAME: "app-blue.prod.internal",
  DOMAIN: "bookings.example-club.org.nz",
};

const NON_PRODUCTION_LOOKING: Record<string, string> = {
  NODE_ENV: "development",
  APP_RUNTIME_ROLE: "staging",
  VERCEL_ENV: "preview",
  DATABASE_URL: "postgresql://tac:pw@localhost:5433/tacbookings",
  NEXTAUTH_URL: "http://localhost:3001",
  HOSTNAME: "staging-box.local",
  DOMAIN: "localhost",
};

const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function declare(value: string | undefined) {
  setEnv(ENVIRONMENT_ROLE_ENV_VAR, value);
}

function overrideRow(forceNonProduction: boolean) {
  return {
    forceNonProduction,
    updatedByMemberId: "member-full-admin",
    updatedAt: new Date("2026-06-15T09:30:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.delegatePresent.value = true;
  h.findUnique.mockResolvedValue(null);
  // Every test starts from an environment that says NOTHING, including through
  // any of the heuristic signals.
  declare(undefined);
  for (const name of HEURISTIC_SIGNALS) setEnv(name, undefined);
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("the declaration is read live from the process environment", () => {
  it("resolves PRODUCTION from APP_ENVIRONMENT_ROLE=production with no override", async () => {
    declare("production");
    await expect(getEnvironmentRole()).resolves.toBe("PRODUCTION");
  });

  it("resolves NON_PRODUCTION from APP_ENVIRONMENT_ROLE=non-production", async () => {
    declare("non-production");
    await expect(getEnvironmentRole()).resolves.toBe("NON_PRODUCTION");
  });

  it("resolves UNKNOWN when nothing is declared", async () => {
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
  });

  it("re-reads on every call rather than freezing at import", async () => {
    declare("production");
    await expect(getEnvironmentRole()).resolves.toBe("PRODUCTION");
    declare("non-production");
    await expect(getEnvironmentRole()).resolves.toBe("NON_PRODUCTION");
    declare(undefined);
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
  });
});

describe("the database override read", () => {
  it("asks for the singleton by primary key, through the one shared projection", async () => {
    declare("production");
    await resolveEnvironmentRole();
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.findUnique).toHaveBeenCalledWith({
      where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
      select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
    });
  });

  it("treats an absent row as no override", async () => {
    declare("production");
    h.findUnique.mockResolvedValue(null);
    const resolution = await resolveEnvironmentRole();
    expect(resolution.databaseOverride).toEqual({ kind: "none" });
    expect(resolution.role).toBe("PRODUCTION");
  });

  it("treats a row with the override off as no override", async () => {
    declare("production");
    h.findUnique.mockResolvedValue(overrideRow(false));
    const resolution = await resolveEnvironmentRole();
    expect(resolution.databaseOverride).toEqual({ kind: "none" });
    expect(resolution.role).toBe("PRODUCTION");
  });

  it("carries who set the override and when, for the operator surface", async () => {
    declare("production");
    h.findUnique.mockResolvedValue(overrideRow(true));
    const resolution = await resolveEnvironmentRole();
    expect(resolution.databaseOverride).toEqual({
      kind: "force-non-production",
      updatedAt: new Date("2026-06-15T09:30:00.000Z"),
      updatedByMemberId: "member-full-admin",
    });
    expect(resolution.role).toBe("NON_PRODUCTION");
    expect(resolution.decidedBy).toBe("database-safer-override");
  });

  it("never creates a row — a read path must not write", async () => {
    declare("non-production");
    await resolveEnvironmentRole();
    // The double exposes findUnique and nothing else, so an upsert/create would
    // have thrown rather than silently succeeded.
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });

  it("still reads the override when the declaration already says non-production", async () => {
    // The answer cannot change, but the operator surface has to be able to
    // report whether the override is on.
    declare("non-production");
    h.findUnique.mockResolvedValue(overrideRow(true));
    const resolution = await resolveEnvironmentRole();
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(resolution.databaseOverride.kind).toBe("force-non-production");
    expect(resolution.decidedBy).toBe("deployment-declaration");
  });
});

describe("an unreadable override fails closed", () => {
  it.each([
    ["a thrown read", () => h.findUnique.mockRejectedValue(new Error("no such table"))],
    ["a missing Prisma delegate", () => { h.delegatePresent.value = false; }],
  ])("resolves UNKNOWN under a declared production (%s)", async (_label, arrange) => {
    declare("production");
    arrange();
    const resolution = await resolveEnvironmentRole();
    expect(resolution.role).toBe("UNKNOWN");
    expect(resolution.decidedBy).toBe("unresolved");
    expect(resolution.databaseOverride).toEqual({ kind: "unreadable" });
    expect(resolution.notes.join(" ")).toContain("could not be read");
  });

  it("resolves UNKNOWN when nothing is declared either", async () => {
    h.findUnique.mockRejectedValue(new Error("connection refused"));
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
  });

  it("leaves a declared non-production intact", async () => {
    declare("non-production");
    h.findUnique.mockRejectedValue(new Error("connection refused"));
    const resolution = await resolveEnvironmentRole();
    expect(resolution.role).toBe("NON_PRODUCTION");
    expect(resolution.decidedBy).toBe("deployment-declaration");
    expect(resolution.databaseOverride).toEqual({ kind: "unreadable" });
  });

  it("does not throw — a configuration reader that throws is a blank page", async () => {
    h.findUnique.mockRejectedValue(new Error("boom"));
    await expect(resolveEnvironmentRole()).resolves.toBeTruthy();
  });
});

describe("nothing is ever inferred", () => {
  it.each(HEURISTIC_SIGNALS)(
    "a production-looking %s does not make an undeclared installation production",
    async (name) => {
      setEnv(name, PRODUCTION_LOOKING[name]);
      const resolution = await resolveEnvironmentRole();
      expect(resolution.role).toBe("UNKNOWN");
      expect(resolution.decidedBy).toBe("unresolved");
    },
  );

  it("all the production-looking signals together still resolve UNKNOWN", async () => {
    for (const name of HEURISTIC_SIGNALS) setEnv(name, PRODUCTION_LOOKING[name]);
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
  });

  it("all the non-production-looking signals together still resolve UNKNOWN", async () => {
    // UNKNOWN is NOT the same as confirmed non-production (#3036 must not treat
    // it as a licence to transform a Xero contact), so this leg matters as much
    // as the production-looking one.
    for (const name of HEURISTIC_SIGNALS) {
      setEnv(name, NON_PRODUCTION_LOOKING[name]);
    }
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
  });

  it.each([...HEURISTIC_SIGNALS])(
    "a non-production-looking %s cannot demote a declared production",
    async (name) => {
      declare("production");
      setEnv(name, NON_PRODUCTION_LOOKING[name]);
      await expect(getEnvironmentRole()).resolves.toBe("PRODUCTION");
    },
  );

  /*
    APP_RUNTIME_ROLE gets its own case because it is the mistake an operator will
    actually make: it already exists, it sits in the same Compose environment
    block, and on the staging stack it literally holds the word "staging". It
    must not be an input, in either direction.
  */
  it.each(["staging", "web-blue", "web-green", "cron-leader", "production"])(
    "ignores APP_RUNTIME_ROLE=%s entirely",
    async (value) => {
      setEnv("APP_RUNTIME_ROLE", value);
      await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
    },
  );
});

describe("restore scenarios", () => {
  /*
    The scenario epic #2986 exists for: somebody restores last night's production
    dump onto a copy so they can rehearse something. The dump brings the club's
    real member records, real email addresses and real Xero references with it.
  */
  it("a production database restored onto an instance declared non-production is NON_PRODUCTION", async () => {
    declare("non-production");
    // The restored dump can bring any EnvironmentSafetySettings row it likes —
    // including none, which is what production would have.
    h.findUnique.mockResolvedValue(null);
    await expect(getEnvironmentRole()).resolves.toBe("NON_PRODUCTION");
  });

  it("a production database restored onto an instance with NO declaration is UNKNOWN, not production", async () => {
    declare(undefined);
    h.findUnique.mockResolvedValue(null);
    const resolution = await resolveEnvironmentRole();
    expect(resolution.role).toBe("UNKNOWN");
    expect(resolution.role).not.toBe("PRODUCTION");
  });

  it("a restored row cannot carry a production claim, because there is no such column", async () => {
    // Whatever the dump held, the only field that reaches the resolver is the
    // safer-only boolean. A `true` makes the copy safer; a `false` hands the
    // decision back to the declaration, which here says nothing.
    declare(undefined);
    h.findUnique.mockResolvedValue(overrideRow(false));
    await expect(getEnvironmentRole()).resolves.toBe("UNKNOWN");
    h.findUnique.mockResolvedValue(overrideRow(true));
    await expect(getEnvironmentRole()).resolves.toBe("NON_PRODUCTION");
  });
});

describe("no caching", () => {
  it("re-reads the database on every call, so switching the override takes effect at once", async () => {
    declare("production");
    h.findUnique.mockResolvedValue(null);
    await expect(getEnvironmentRole()).resolves.toBe("PRODUCTION");

    // The administrator presses the switch.
    h.findUnique.mockResolvedValue(overrideRow(true));
    await expect(getEnvironmentRole()).resolves.toBe("NON_PRODUCTION");
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });
});
