type EnvMap = Record<string, string | undefined>;

type EmailDeliveryMode = "aws-ses" | "smtp-relay";

/**
 * How the delivery mode was chosen (ENV-SAFETY 2, #3035).
 *
 * `implicit-legacy-default` is the one that matters: with NEITHER `USE_AWS_SES`
 * nor `USE_SMTP_RELAY` set, this parser resolves live AWS SES for backward
 * compatibility. That is a real hazard on anything that is not the club's live
 * site — a copy would connect to the club's live mail provider with the club's
 * live credentials — so the delivery boundary refuses it outside confirmed
 * production. It is reported as a FIELD rather than inferred from the warning
 * text, because a safety rule keyed on a string somebody may reword is a rule
 * that stops holding the day somebody rewords it.
 *
 * This module deliberately does NOT resolve the environment role itself. It is a
 * pure parser over an injected environment; the role belongs to
 * `resolveEnvironmentRole()` (INV-CONFIG-003), and a second reader of that
 * answer is what INV-CONFIG-003 forbids. The rule is applied by
 * {@link refuseAmbiguousImplicitSesDefault}, whose caller holds the role.
 */
export type EmailDeliveryModeSource =
  | "explicit-flag"
  | "implicit-legacy-default"
  | "unresolved";

/** Whether the legacy implicit AWS SES default may be used at all. */
export type ImplicitSesDefault = "permitted" | "refused";

interface EmailTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface ResolvedEmailDeliveryConfig {
  ok: boolean;
  mode: EmailDeliveryMode | "invalid";
  modeSource: EmailDeliveryModeSource;
  modeLabel: string;
  issues: string[];
  warnings: string[];
  transportOptions: EmailTransportOptions | null;
}

function readEnv(env: EnvMap, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBooleanFlag(
  env: EnvMap,
  name: string,
  issues: string[],
): boolean | undefined {
  const raw = readEnv(env, name);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.push(`${name} must be true or false`);
  return undefined;
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

export function resolveEmailDeliveryConfigFromEnv(
  env: EnvMap,
): ResolvedEmailDeliveryConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const useAwsSes = parseBooleanFlag(env, "USE_AWS_SES", issues);
  const useSmtpRelay = parseBooleanFlag(env, "USE_SMTP_RELAY", issues);

  const selectedModes =
    Number(useAwsSes === true) + Number(useSmtpRelay === true);

  let mode: EmailDeliveryMode | "invalid" = "invalid";
  let modeSource: EmailDeliveryModeSource = "unresolved";
  if (selectedModes === 1) {
    mode = useAwsSes === true ? "aws-ses" : "smtp-relay";
    modeSource = "explicit-flag";
  } else if (selectedModes === 0) {
    // Backward compatibility: if both flags are omitted, use legacy SES mode.
    if (useAwsSes === undefined && useSmtpRelay === undefined) {
      mode = "aws-ses";
      modeSource = "implicit-legacy-default";
      warnings.push(
        "USE_AWS_SES/USE_SMTP_RELAY are not set. The club's live site still defaults to AWS SES for backward compatibility, but any other installation now refuses to open a mail transport at all — including the health check and the setup wizard's provider test — because a copy must never connect to the club's live mail provider by default. Set exactly one of them explicitly.",
      );
    } else {
      issues.push(
        "Exactly one email provider flag must be true (USE_AWS_SES or USE_SMTP_RELAY)",
      );
    }
  } else {
    issues.push("USE_AWS_SES and USE_SMTP_RELAY cannot both be true");
  }

  const emailFrom = readEnv(env, "EMAIL_FROM");
  if (!emailFrom) {
    issues.push("EMAIL_FROM is missing");
  }

  if (mode === "aws-ses") {
    const host =
      readEnv(env, "SMTP_HOST") ?? "email-smtp.ap-southeast-2.amazonaws.com";
    const portRaw = readEnv(env, "SMTP_PORT");
    const port = parsePort(portRaw) ?? 587;
    const user = readEnv(env, "AWS_SES_ACCESS_KEY_ID");
    const pass = readEnv(env, "AWS_SES_SECRET_ACCESS_KEY");

    if (!user) issues.push("AWS_SES_ACCESS_KEY_ID is missing");
    if (!pass) issues.push("AWS_SES_SECRET_ACCESS_KEY is missing");
    if (portRaw && parsePort(portRaw) === null) {
      issues.push("SMTP_PORT must be a valid port number");
    }
    if (!readEnv(env, "SES_SNS_TOPIC_ARN")) {
      warnings.push(
        "SES_SNS_TOPIC_ARN is not set; SES bounce/complaint topic allowlisting is disabled",
      );
    }

    return {
      ok: issues.length === 0,
      mode,
      modeSource,
      modeLabel: "AWS SES",
      issues,
      warnings,
      transportOptions:
        user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  if (mode === "smtp-relay") {
    const host = readEnv(env, "EMAIL_SERVER_HOST");
    const portRaw = readEnv(env, "EMAIL_SERVER_PORT");
    const port = parsePort(portRaw);
    const user = readEnv(env, "EMAIL_SERVER_USER");
    const pass = readEnv(env, "EMAIL_SERVER_PASSWORD");

    if (!host) issues.push("EMAIL_SERVER_HOST is missing");
    if (!portRaw) {
      issues.push("EMAIL_SERVER_PORT is missing");
    } else if (port === null) {
      issues.push("EMAIL_SERVER_PORT must be a valid port number");
    }
    if (!user) issues.push("EMAIL_SERVER_USER is missing");
    if (!pass) issues.push("EMAIL_SERVER_PASSWORD is missing");

    return {
      ok: issues.length === 0,
      mode,
      modeSource,
      modeLabel: "SMTP Relay",
      issues,
      warnings,
      transportOptions:
        host && port !== null && user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  return {
    ok: false,
    mode,
    modeSource,
    modeLabel: "Not configured",
    issues,
    warnings,
    transportOptions: null,
  };
}

/**
 * The one issue the ambiguous-configuration hole in #3035 names: with neither
 * provider flag set this parser resolves LIVE AWS SES, so an installation that
 * is not the club's live site would open a transport to the club's own mail
 * provider using the club's own credentials.
 *
 * Confirmed production keeps the legacy default, because "production stays
 * behaviourally equivalent" is one of this issue's acceptance criteria and every
 * existing deployment relies on it. Everything else — a declared copy, and an
 * installation whose role nobody has declared — is refused, and the refusal
 * names the two flags so the repair is one line of deployment configuration.
 *
 * WHERE THIS ACTUALLY BITES, stated plainly rather than overclaimed. On the SEND
 * path the delivery policy has already suppressed or blocked before any transport
 * is asked for, so this refusal is defence in depth there — it is what stops a
 * future sender that somehow reached the transport. On the VERIFY path
 * (`verifyEmailTransport`, used by the health check and the setup wizard's
 * provider test) it is the operative rule: a `verify()` is a real connection to a
 * real provider with real credentials, and that is exactly what a copy must not
 * make by default.
 */
export function refuseAmbiguousImplicitSesDefault(
  config: ResolvedEmailDeliveryConfig,
  implicitSesDefault: ImplicitSesDefault,
): ResolvedEmailDeliveryConfig {
  if (
    implicitSesDefault === "permitted" ||
    config.modeSource !== "implicit-legacy-default"
  ) {
    return config;
  }
  return {
    ok: false,
    mode: "invalid",
    modeSource: config.modeSource,
    modeLabel: "Not configured",
    issues: [
      "Neither USE_AWS_SES nor USE_SMTP_RELAY is set. This installation is not confirmed to be the club's live site, so it will not fall back to live AWS SES. Set exactly one of USE_AWS_SES or USE_SMTP_RELAY (a copy usually wants USE_SMTP_RELAY pointed at a local capture mailbox), or declare APP_ENVIRONMENT_ROLE=production if this really is the club's live installation.",
      ...config.issues,
    ],
    warnings: config.warnings,
    transportOptions: null,
  };
}

export function resolveEmailDeliveryConfig(
  implicitSesDefault: ImplicitSesDefault,
): ResolvedEmailDeliveryConfig {
  return refuseAmbiguousImplicitSesDefault(
    resolveEmailDeliveryConfigFromEnv(process.env),
    implicitSesDefault,
  );
}
