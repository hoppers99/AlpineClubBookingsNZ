import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ambiguous-configuration hole (ENV-SAFETY 2, #3035; epic #2986;
 * INV-CONFIG-004).
 *
 * With NEITHER `USE_AWS_SES` nor `USE_SMTP_RELAY` set, the delivery parser has
 * always resolved LIVE AWS SES with only a warning. On the club's own site that
 * is a deliberate backward-compatibility default and this issue's acceptance
 * criteria require it to stay. Anywhere else it means a copy opening a connection
 * to the club's real mail provider with the club's real credentials.
 *
 * WHERE IT ACTUALLY BITES, because a test that overclaims is worse than none.
 * On the SEND path the delivery policy has already suppressed or blocked before
 * any transport is asked for, so this rule is defence in depth there. On the
 * VERIFY path — the health check and the setup wizard's provider test — it is the
 * operative rule, because `transporter.verify()` really does connect.
 */

const mocks = vi.hoisted(() => ({
  environmentSafetyFindUnique: vi.fn(),
  createTransport: vi.fn(),
  verify: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: mocks.environmentSafetyFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

import {
  refuseAmbiguousImplicitSesDefault,
  resolveEmailDeliveryConfigFromEnv,
} from "@/lib/email-delivery";
import { verifyEmailTransport } from "@/lib/email/internal";
import {
  declareEnvironmentRole,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const CREDENTIALLED_ENV = {
  EMAIL_FROM: "club@club.test",
  AWS_SES_ACCESS_KEY_ID: "key",
  AWS_SES_SECRET_ACCESS_KEY: "secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true);
  mocks.createTransport.mockReturnValue({ verify: mocks.verify });
});

describe("resolveEmailDeliveryConfigFromEnv reports HOW the mode was chosen", () => {
  it("marks the flagless legacy fallback, so the rule is not keyed on a warning string", () => {
    const config = resolveEmailDeliveryConfigFromEnv(CREDENTIALLED_ENV);
    expect(config.mode).toBe("aws-ses");
    expect(config.modeSource).toBe("implicit-legacy-default");
  });

  it("marks an explicit flag as explicit", () => {
    expect(
      resolveEmailDeliveryConfigFromEnv({
        ...CREDENTIALLED_ENV,
        USE_AWS_SES: "true",
      }).modeSource,
    ).toBe("explicit-flag");
    expect(
      resolveEmailDeliveryConfigFromEnv({
        EMAIL_FROM: "club@club.test",
        USE_SMTP_RELAY: "true",
        EMAIL_SERVER_HOST: "mailpit",
        EMAIL_SERVER_PORT: "1025",
        EMAIL_SERVER_USER: "u",
        EMAIL_SERVER_PASSWORD: "p",
      }).modeSource,
    ).toBe("explicit-flag");
  });
});

describe("refuseAmbiguousImplicitSesDefault", () => {
  const flagless = () => resolveEmailDeliveryConfigFromEnv(CREDENTIALLED_ENV);

  it("leaves confirmed production exactly as it was", () => {
    const config = flagless();
    expect(refuseAmbiguousImplicitSesDefault(config, "permitted")).toBe(config);
  });

  it("refuses the fallback everywhere else, and names both flags in the repair", () => {
    const refused = refuseAmbiguousImplicitSesDefault(flagless(), "refused");
    expect(refused.ok).toBe(false);
    expect(refused.transportOptions).toBeNull();
    expect(refused.issues[0]).toContain("USE_AWS_SES");
    expect(refused.issues[0]).toContain("USE_SMTP_RELAY");
    // It never echoes a credential back at the operator, even though it holds
    // one at this point.
    expect(refused.issues.join(" ")).not.toContain("secret");
  });

  it("does not touch an explicitly-flagged configuration, whatever the role", () => {
    /*
      A copy pointed at a local capture mailbox is a legitimate, useful setup and
      must keep working — this rule is about the SILENT fallback to the club's live
      provider, not about non-production sending at all.
    */
    const explicit = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_SMTP_RELAY: "true",
      EMAIL_SERVER_HOST: "mailpit",
      EMAIL_SERVER_PORT: "1025",
      EMAIL_SERVER_USER: "u",
      EMAIL_SERVER_PASSWORD: "p",
    });
    expect(refuseAmbiguousImplicitSesDefault(explicit, "refused")).toBe(explicit);
    expect(explicit.ok).toBe(true);
  });
});

describe("verifyEmailTransport", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_FROM", "club@club.test");
    vi.stubEnv("AWS_SES_ACCESS_KEY_ID", "key");
    vi.stubEnv("AWS_SES_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("USE_AWS_SES", "");
    vi.stubEnv("USE_SMTP_RELAY", "");
  });

  it("verifies on the club's live site, where the legacy default still stands", async () => {
    declareEnvironmentRole("production");
    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "AWS SES",
    });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it("opens no connection at all on a declared copy with no provider flag set", async () => {
    declareEnvironmentRole("non-production");
    await expect(verifyEmailTransport()).rejects.toThrow(
      /Email delivery config invalid/,
    );
    // The point of the whole rule: no transport was constructed, so no
    // credential was presented to the club's live provider.
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("opens no connection when nobody has said what this installation is", async () => {
    undeclareEnvironmentRole();
    await expect(verifyEmailTransport()).rejects.toThrow(
      /Email delivery config invalid/,
    );
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("hands back no transport, so a diagnostic cannot become a sender", async () => {
    /*
      A structural property, not a behavioural one: the return type is
      `{ modeLabel }`. If a future edit returned the `Transporter` instead, the
      health check and the provider-test route would silently gain the ability to
      send from an installation the delivery policy has refused.
    */
    declareEnvironmentRole("production");
    const result = await verifyEmailTransport();
    expect(Object.keys(result)).toEqual(["modeLabel"]);
    expect(result).not.toHaveProperty("transporter");
  });

  it("verifies a copy that has been pointed at a capture mailbox explicitly", async () => {
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_SMTP_RELAY", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "u");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "p");

    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "SMTP Relay",
    });
  });
});
