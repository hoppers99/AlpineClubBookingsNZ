import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn() },
    xeroSandboxContactContainment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
  getAuthenticatedXeroClient: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    // The metering wrapper is exercised by its own suites; here it must simply
    // not swallow or retry, so the assertions below are about the containment
    // decisions rather than about the retry ladder.
    callXeroApi: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  };
});

import {
  applyXeroContactEmailPolicy,
  decideXeroContactEmailPolicy,
  ensureXeroContactContained,
  resolveXeroContactEmailPolicy,
  XeroContactContainmentError,
  XeroContactEmailPolicyError,
  XeroContactEnvironmentUnknownError,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";
import {
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const REAL = "member@example.com";
const CONTACT = "contact-1";

function xeroClient(storedEmail: string | undefined) {
  const getContact = vi.fn().mockResolvedValue({
    body: { contacts: [{ contactID: CONTACT, emailAddress: storedEmail }] },
  });
  const updateContact = vi.fn().mockResolvedValue({ body: {} });
  return { accountingApi: { getContact, updateContact } };
}

/** A production policy, obtained the only way a policy can be obtained. */
async function productionPolicy(): Promise<XeroContactEmailPolicy> {
  declareEnvironmentRole("production");
  mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
  await expectEnvironmentRolePremise("PRODUCTION");
  return (await resolveXeroContactEmailPolicy()).policy;
}

/** A confirmed-copy policy. */
async function copyPolicy(): Promise<XeroContactEmailPolicy> {
  declareEnvironmentRole("non-production");
  await expectEnvironmentRolePremise("NON_PRODUCTION");
  return (await resolveXeroContactEmailPolicy()).policy;
}

/**
 * INV-CONFIG-005: Xero contact containment (ENV-SAFETY 3, #3036; epic #2986).
 *
 * The role resolver answers UNKNOWN by default in this suite — the declaration
 * is unset and `prisma.environmentSafetySettings` is a mock whose `findUnique`
 * returns `undefined` until a test says otherwise — so every test declares the
 * installation it means to be, and `expectEnvironmentRolePremise` fails with a
 * sentence rather than letting an assertion pass for the wrong reason.
 */
describe("Xero contact containment (INV-CONFIG-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
  });

  describe("the pure decision", () => {
    it("maps each role to exactly one answer", () => {
      expect(decideXeroContactEmailPolicy("PRODUCTION")).toEqual({
        kind: "verbatim",
      });
      expect(decideXeroContactEmailPolicy("NON_PRODUCTION")).toEqual({
        kind: "contain",
      });
      expect(decideXeroContactEmailPolicy("UNKNOWN")).toEqual({
        kind: "block_environment_unknown",
      });
    });

    it("mints nothing, so nobody can ask it for a token", async () => {
      // It takes caller-supplied input. #3035's review found a pure function
      // that minted was a function anybody could hand `{ role: "PRODUCTION" }`
      // to and receive a genuine token from. The shape assertion is that the
      // returned object carries NO usable policy: handing it to the applier
      // must be refused.
      const outcome = decideXeroContactEmailPolicy("PRODUCTION");
      expect(Object.keys(outcome)).toEqual(["kind"]);
      expect(() =>
        applyXeroContactEmailPolicy(
          outcome as unknown as XeroContactEmailPolicy,
          REAL,
        ),
      ).toThrow(XeroContactEmailPolicyError);
    });
  });

  describe("PRODUCTION is behaviourally unchanged", () => {
    it("passes the address through untouched", async () => {
      const policy = await productionPolicy();
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(REAL);
      expect(applyXeroContactEmailPolicy(policy, "")).toBe("");
      // Even an address that already looks contained is passed through, because
      // on the live site this function has no opinion at all.
      const contained = toXeroSandboxContactEmail(REAL);
      expect(applyXeroContactEmailPolicy(policy, contained)).toBe(contained);
    });

    it("does no containment work: no evidence read, no provider call, no row", async () => {
      const policy = await productionPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(
        mocks.prisma.xeroSandboxContactContainment.findUnique,
      ).not.toHaveBeenCalled();
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });
  });

  describe("UNKNOWN refuses, and transforms nothing", () => {
    it("throws a named error naming the variable to set", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        XeroContactEnvironmentUnknownError,
      );
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        /APP_ENVIRONMENT_ROLE/,
      );
    });

    it("refuses under an UNREADABLE override even with production declared", async () => {
      // The half a suite forgets. A declared production plus an unreadable
      // override resolves UNKNOWN (#3034), and Xero writing must fail closed
      // there too.
      declareEnvironmentRole("production");
      mocks.prisma.environmentSafetySettings.findUnique.mockRejectedValue(
        new Error("boom"),
      );
      await expectEnvironmentRolePremise("UNKNOWN");
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        XeroContactEnvironmentUnknownError,
      );
    });

    it("mints no policy at all, so no caller can transform or contain", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");
      const thrown = await resolveXeroContactEmailPolicy().catch((error) => error);
      expect(thrown).toBeInstanceOf(XeroContactEnvironmentUnknownError);
      // There is no third variant to ignore: the only way past this function is
      // a policy, and on UNKNOWN it does not return one.
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });
  });

  describe("a forged policy fails closed", () => {
    it("refuses a cast object at runtime", () => {
      const forged = {} as unknown as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(forged, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
    });

    it("refuses an object that merely names the mode", () => {
      // A forged token that guesses the shape must not work either — the witness
      // is a module-private Symbol, which nothing outside the module can spell
      // and nothing can deserialize.
      const forged = { mode: "verbatim" } as unknown as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(forged, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
      const serialized = JSON.parse(
        JSON.stringify({ verbatim: true }),
      ) as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(serialized, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
    });
  });

  describe("a confirmed copy contains", () => {
    it("replaces the address in a payload", async () => {
      const policy = await copyPolicy();
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(
        toXeroSandboxContactEmail(REAL),
      );
      expect(applyXeroContactEmailPolicy(policy, "")).toBe("");
    });

    it("contains regardless of transport mode: a capture mailbox is no exemption", async () => {
      // The one thing that must NOT be reused here. #3035's delivery policy lets
      // a confirmed copy with USE_LOCAL_CAPTURE transmit, because a capture
      // catches everything this application sends. Xero emails an invoice from
      // its own servers, so a capture catches nothing — and a copy with a
      // capture declared still needs every contact contained.
      declareEnvironmentRole("non-production");
      vi.stubEnv("USE_LOCAL_CAPTURE", "true");
      vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
      await expectEnvironmentRolePremise("NON_PRODUCTION");
      const { kind, policy } = await resolveXeroContactEmailPolicy();
      expect(kind).toBe("contain");
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(
        toXeroSandboxContactEmail(REAL),
      );
    });

    it("rewrites a contact that is holding a real address, and records the proof", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledWith(
        "tenant-1",
        CONTACT,
      );
      expect(xero.accountingApi.updateContact).toHaveBeenCalledTimes(1);
      const [tenantId, contactId, payload, idempotencyKey] =
        xero.accountingApi.updateContact.mock.calls[0];
      expect(tenantId).toBe("tenant-1");
      expect(contactId).toBe(CONTACT);
      expect(payload).toEqual({
        contacts: [
          {
            contactID: CONTACT,
            emailAddress: toXeroSandboxContactEmail(REAL),
          },
        ],
      });
      // The key is derived from the contact and the address being written, so a
      // retry of the same containment cannot produce a second write.
      expect(idempotencyKey).toContain(CONTACT);
      expect(idempotencyKey).toContain(toXeroSandboxContactEmail(REAL));
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith({
        where: { xeroContactId: CONTACT },
        create: {
          xeroContactId: CONTACT,
          containedEmail: xeroSandboxContainmentTarget(REAL),
          rewroteAddress: true,
        },
        update: {
          containedEmail: xeroSandboxContainmentTarget(REAL),
          rewroteAddress: true,
        },
      });
    });

    it("sends NO name, phone or address on the containment write", async () => {
      // Xero merges the fields present. Sending an empty `phones: []` or
      // `addresses: []` here would WIPE the contact's real phone and address on
      // a copy, which is a destructive edit nobody asked for.
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      const contact = (
        xero.accountingApi.updateContact.mock.calls[0][2] as {
          contacts: Record<string, unknown>[];
        }
      ).contacts[0];
      expect(Object.keys(contact).sort()).toEqual([
        "contactID",
        "emailAddress",
      ]);
    });

    it("writes nothing to the provider when the contact is already unreachable", async () => {
      const policy = await copyPolicy();
      for (const stored of [
        undefined,
        "",
        "walk-in-abc@no-email.invalid",
        toXeroSandboxContactEmail(REAL),
      ]) {
        vi.clearAllMocks();
        mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
          null,
        );
        mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
        const xero = xeroClient(stored);
        await ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        });
        expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
        expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
        expect(
          mocks.prisma.xeroSandboxContactContainment.upsert,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ rewroteAddress: false }),
          }),
        );
      }
    });

    it("contains what XERO is holding, not what the member holds", async () => {
      // A linked contact can carry somebody else's address — matched by email or
      // exact name, or linked wholesale by the member import. Containing the
      // member's address instead would leave the real one on the contact.
      const policy = await copyPolicy();
      const xero = xeroClient("someone.else@example.com");
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      const contact = (
        xero.accountingApi.updateContact.mock.calls[0][2] as {
          contacts: { emailAddress: string }[];
        }
      ).contacts[0];
      expect(contact.emailAddress).toBe(
        toXeroSandboxContactEmail("someone.else@example.com"),
      );
      // …while the PROOF is fingerprinted on the member's address, because that
      // is what the fast path compares against next time.
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            containedEmail: xeroSandboxContainmentTarget(REAL),
          }),
        }),
      );
    });
  });

  describe("the steady state costs no provider call", () => {
    it("returns on the evidence alone when the proof still matches", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue({
        containedEmail: xeroSandboxContainmentTarget(REAL),
      });
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("takes no Xero client at all on the fast path, so no token is refreshed", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue({
        containedEmail: xeroSandboxContainmentTarget(REAL),
      });
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
      });
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    });

    it("re-verifies when the member's address has moved", async () => {
      // The proof describes the address this application WOULD write. When the
      // member's address changes, the proof no longer describes it, so the
      // contact is read from Xero again rather than trusted on a claim made
      // before the change.
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue({
        containedEmail: xeroSandboxContainmentTarget("old@example.com"),
      });
      const xero = xeroClient(toXeroSandboxContactEmail("old@example.com"));
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
      // Already unreachable, so no provider write — but the proof is refreshed
      // so the next document writer takes the fast path again.
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            containedEmail: xeroSandboxContainmentTarget(REAL),
          }),
        }),
      );
    });

    it("is one indexed read per contact, so a batch of many is not an N+1", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockImplementation(
        async ({ where }: { where: { xeroContactId: string } }) => ({
          containedEmail: xeroSandboxContainmentTarget(`${where.xeroContactId}@example.com`),
        }),
      );
      const xero = xeroClient(REAL);
      for (let index = 0; index < 25; index += 1) {
        await ensureXeroContactContained({
          policy,
          xeroContactId: `contact-${index}`,
          sourceEmail: `contact-${index}@example.com`,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        });
      }
      expect(
        mocks.prisma.xeroSandboxContactContainment.findUnique,
      ).toHaveBeenCalledTimes(25);
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
    });
  });

  describe("containment that cannot be established is a refusal", () => {
    it("throws when the containment table cannot be read", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockRejectedValue(
        new Error("relation does not exist"),
      );
      const xero = xeroClient(REAL);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
    });

    it("throws when the contact cannot be read from Xero", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      xero.accountingApi.getContact.mockRejectedValue(new Error("503"));
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("throws when the containment write to Xero fails, and records no proof", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      xero.accountingApi.updateContact.mockRejectedValue(new Error("400"));
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("throws when the proof cannot be written", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.upsert.mockRejectedValue(
        new Error("read only"),
      );
      const xero = xeroClient(REAL);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
    });

    it("throws when the containment table does not exist on this database", async () => {
      // An un-migrated copy. A missing delegate must be a refusal, not a
      // silently skipped containment — the direction this module is never
      // allowed to guess in.
      const policy = await copyPolicy();
      const withoutDelegate = mocks.prisma
        .xeroSandboxContactContainment as unknown;
      try {
        (
          mocks.prisma as unknown as Record<string, unknown>
        ).xeroSandboxContactContainment = undefined;
        await expect(
          ensureXeroContactContained({
            policy,
            xeroContactId: CONTACT,
            sourceEmail: REAL,
            workflow: "test",
            xero: xeroClient(REAL),
            tenantId: "tenant-1",
          }),
        ).rejects.toThrow(/prisma migrate deploy/);
      } finally {
        (
          mocks.prisma as unknown as Record<string, unknown>
        ).xeroSandboxContactContainment = withoutDelegate;
      }
    });

    it("throws when Xero cannot be authenticated at all", async () => {
      const policy = await copyPolicy();
      mocks.getAuthenticatedXeroClient.mockRejectedValue(
        new Error("no connection"),
      );
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
    });
  });
});
