"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Derives the Xero setup wizard's server truth (#2080) — the `context` the
 * reusable shell verifies each step against. Everything here is LIVE server
 * state (credential metadata, connection status, connected org name), so step
 * gating can never be faked by a stale persisted cursor.
 */

export interface XeroCredentialFieldMeta {
  set: boolean;
  setAt: string | null;
}

/**
 * Why the connected-organisation read did not produce a name (#2394).
 *
 * The first three kinds mirror `XeroOrganisationReadFailure` on the server
 * (`src/lib/xero-organisation.ts`) — they are the three things an operator can
 * do something DIFFERENT about: reconnect, wait, or try again now. The fourth
 * is client-only: this site refused the read outright because the admin's role
 * has no finance access, which no amount of retrying or waiting will change.
 *
 * Kept as a hand-written mirror rather than importing the server type: this
 * module is a client component, and `xero-organisation.ts` pulls in the Xero
 * client and Prisma. `normaliseOrgFailure` below is the one place the wire
 * shape is trusted, so an unknown kind degrades rather than rendering nothing.
 */
export type XeroOrgReadErrorKind =
  | "disconnected"
  | "rate_limited"
  | "unavailable"
  | "forbidden";

export interface XeroOrgReadError {
  kind: XeroOrgReadErrorKind;
  /** Which Xero limit was hit, for `rate_limited` (else null). */
  rateLimit: "minute" | "day" | null;
  /** Seconds Xero asked us to wait, when it said (else null). */
  retryAfterSeconds: number | null;
}

export type XeroCredentialKey = "client_id" | "client_secret" | "webhook_key";

export interface XeroWizardContext {
  /** Resolved OAuth redirect URI (from NEXTAUTH_URL, server-provided). */
  redirectUri: string;
  /** Company URL suggestion — the deployment origin behind the redirect URI. */
  companyUrl: string;
  /** Legacy XERO_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /** Metadata-only credential status (never a value). */
  credentials: Record<XeroCredentialKey, XeroCredentialFieldMeta>;
  /**
   * Whether the viewer may write credentials (Full Admin only). Tri-state
   * (#2065 / #2324): `undefined` while the session resolves, so a step neither
   * flashes "Only a Full Admin can…" at a Full Admin nor flashes an enabled
   * control at anyone else. Treat only `true` as permission.
   */
  isFullAdmin: boolean | undefined;
  /** Xero OAuth connection state. */
  connected: boolean;
  /** Stored tokens exist but no longer decrypt (auth secret changed). */
  needsReentry: boolean;
  /** Connected organisation name for the right-org confirmation, when known. */
  orgName: string | null;
  /**
   * Why {@link orgName} is missing, or null while it is fine / still coming
   * (#2394). The connect step shows the "Confirming the organisation name…"
   * placeholder only while this is null and a read is in flight; any settled
   * failure replaces it with an explanation and a Try again control.
   */
  orgError: XeroOrgReadError | null;
  /**
   * True while a context load — which performs the organisation read when
   * connected — is in flight. Set for the WHOLE load rather than just the org
   * fetch: the load starts with three parallel reads before it even knows
   * whether Xero is connected, and a Try again button that stays idle-looking
   * for that first round-trip reads as a dead button.
   */
  orgLoading: boolean;
  /** Webhook delivery URL to paste into the Xero portal ({origin}/api/webhooks/xero). */
  webhookDeliveryUrl: string;
  /**
   * Whether this deployment can actually verify webhooks: a public HTTPS origin
   * (not localhost / not plain HTTP). When false the step explains why and
   * defaults to Skip.
   */
  webhooksVerifiable: boolean;
  /** Persistent webhook verification (marker matches the current key). */
  webhookVerified: boolean;
}

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials?provider=xero";
const STATUS_ENDPOINT = "/api/admin/xero/status";
const ORG_ENDPOINT = "/api/admin/xero/organisation";
const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

const EMPTY_META: XeroCredentialFieldMeta = { set: false, setAt: null };

interface CredentialsResponse {
  credentials?: Record<string, { set?: boolean; setAt?: string }>;
}
interface StatusResponse {
  connected?: boolean;
  needsReentry?: boolean;
}
interface OrgResponse {
  name?: string | null;
  readFailure?: {
    kind?: string;
    rateLimit?: string | null;
    retryAfterSeconds?: number | null;
  } | null;
}

/** The three server kinds, as a runtime set for the wire-shape check below. */
const SERVER_ORG_FAILURE_KINDS = new Set([
  "disconnected",
  "rate_limited",
  "unavailable",
]);

/** Trust nothing off the wire: an unrecognised shape degrades to "try again". */
function normaliseOrgFailure(
  raw: OrgResponse["readFailure"],
): XeroOrgReadError {
  const kind =
    typeof raw?.kind === "string" && SERVER_ORG_FAILURE_KINDS.has(raw.kind)
      ? (raw.kind as XeroOrgReadErrorKind)
      : "unavailable";
  const rateLimit =
    raw?.rateLimit === "minute" || raw?.rateLimit === "day"
      ? raw.rateLimit
      : null;
  const retryAfterSeconds =
    typeof raw?.retryAfterSeconds === "number" &&
    Number.isFinite(raw.retryAfterSeconds) &&
    raw.retryAfterSeconds > 0
      ? Math.ceil(raw.retryAfterSeconds)
      : null;
  return { kind, rateLimit, retryAfterSeconds };
}

const UNAVAILABLE: XeroOrgReadError = {
  kind: "unavailable",
  rateLimit: null,
  retryAfterSeconds: null,
};
interface WebhookStatusResponse {
  verified?: boolean;
}

export interface XeroWizardServerConfig {
  redirectUri: string;
  companyUrl: string;
  legacyEnvVars: string[];
  /** {origin}/api/webhooks/xero, or "" when no NEXTAUTH_URL origin is resolvable. */
  webhookDeliveryUrl: string;
  /** Public-HTTPS, non-localhost origin (webhooks can actually validate here). */
  webhooksVerifiable: boolean;
}

export function useXeroWizardContext(serverConfig: XeroWizardServerConfig): {
  context: XeroWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  const { data: session, status: sessionStatus } = useSession();
  // Tri-state: `undefined` until the session resolves (#2324). Reading an
  // unresolved session as `false` made every step's Full-Admin notice appear
  // and then vanish for an actual Full Admin.
  const isFull =
    sessionStatus === "loading"
      ? undefined
      : session
        ? isFullAdmin({ accessRoles: session.user?.accessRoles ?? [] })
        : false;

  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<
    Record<XeroCredentialKey, XeroCredentialFieldMeta>
  >({
    client_id: EMPTY_META,
    client_secret: EMPTY_META,
    webhook_key: EMPTY_META,
  });
  const [connected, setConnected] = useState(false);
  const [needsReentry, setNeedsReentry] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<XeroOrgReadError | null>(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [webhookVerified, setWebhookVerified] = useState(false);

  const load = useCallback(async (forceOrgRefresh = false) => {
    setOrgLoading(true);
    try {
      const [credRes, statusRes, webhookRes] = await Promise.all([
        fetch(CREDENTIALS_ENDPOINT, { credentials: "same-origin" }),
        fetch(STATUS_ENDPOINT, { credentials: "same-origin" }),
        fetch(WEBHOOK_STATUS_ENDPOINT, { credentials: "same-origin" }),
      ]);

      if (credRes.ok) {
        const data = (await credRes.json()) as CredentialsResponse;
        const rows = data.credentials ?? {};
        setCredentials({
          client_id: {
            set: Boolean(rows.client_id?.set),
            setAt: rows.client_id?.setAt ?? null,
          },
          client_secret: {
            set: Boolean(rows.client_secret?.set),
            setAt: rows.client_secret?.setAt ?? null,
          },
          webhook_key: {
            set: Boolean(rows.webhook_key?.set),
            setAt: rows.webhook_key?.setAt ?? null,
          },
        });
      }

      let isConnected = false;
      // Whether the status read ANSWERED, as distinct from what it answered.
      // Without the distinction a failed status read looks exactly like
      // "disconnected", which then clears the organisation name and leaves the
      // step waiting on a read it decided not to make (#2394).
      let connectionKnown = false;
      if (statusRes.ok) {
        const data = (await statusRes.json()) as StatusResponse;
        isConnected = Boolean(data.connected);
        connectionKnown = true;
        setConnected(isConnected);
        setNeedsReentry(Boolean(data.needsReentry));
      }

      if (webhookRes.ok) {
        const data = (await webhookRes.json()) as WebhookStatusResponse;
        setWebhookVerified(Boolean(data.verified));
      }

      // Only read the org (a Xero API call) when actually connected. An explicit
      // refresh (post-connect return, post-credential save, the Try again
      // control) forces a fresh read (?refresh=1) so a just-reconnected
      // DIFFERENT org can never show the old cached name — belt-and-braces over
      // the server-side cache reset (#2080 F1) — and so a manual retry is never
      // answered out of the 60-second NEGATIVE cache a failure just wrote
      // (#2394). A Try again that re-serves the failure it was pressed to clear
      // is worse than no button at all.
      if (isConnected) {
        const orgUrl = forceOrgRefresh
          ? `${ORG_ENDPOINT}?refresh=1`
          : ORG_ENDPOINT;
        const orgRes = await fetch(orgUrl, { credentials: "same-origin" });
        if (orgRes.ok) {
          const data = (await orgRes.json()) as OrgResponse;
          const name = data.name ?? null;
          setOrgName(name);
          if (name) {
            // A name is a name, even one served from cache behind a failed
            // refresh: the step's job is confirming the RIGHT org, and it can
            // do that. Nothing to report.
            setOrgError(null);
          } else if (data.readFailure) {
            setOrgError(normaliseOrgFailure(data.readFailure));
          } else {
            // The read genuinely succeeded and Xero reported no name at all.
            // Vanishingly rare, but it must not fall back into an endless
            // "Confirming…" — that is the bug this issue is about.
            setOrgError(UNAVAILABLE);
          }
        } else if (orgRes.status === 401 || orgRes.status === 403) {
          // THIS SITE refused, not Xero: the signed-in admin has no finance
          // access. Retrying and waiting are both useless, so this is its own
          // case rather than a mislabelled "temporarily unavailable".
          setOrgName(null);
          setOrgError({
            kind: "forbidden",
            rateLimit: null,
            retryAfterSeconds: null,
          });
        } else {
          setOrgName(null);
          setOrgError(UNAVAILABLE);
        }
      } else if (connectionKnown) {
        // Positively not connected: there is no organisation to name and
        // nothing to report.
        setOrgName(null);
        setOrgError(null);
      } else {
        // The status read failed, so we never learned whether Xero is
        // connected — and therefore never even attempted the organisation
        // read. Keep whatever name we already had (it is the last thing we
        // knew) and say the check did not happen, rather than blanking the
        // name into a "Confirming…" that nothing will ever resolve.
        setOrgError(UNAVAILABLE);
      }
    } catch {
      // The load itself failed (offline, a dropped connection, unparseable
      // JSON). Everything else degrades to "not verified", which still leaves
      // the operator a control to press — but the organisation confirmation
      // degrades to a message that never resolves, so it has to say so and
      // offer the retry (#2394). Before this, the bare `catch {}` here meant a
      // single blip pinned the step permanently with nothing shown and nothing
      // logged.
      setOrgError(UNAVAILABLE);
    } finally {
      setLoading(false);
      setOrgLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A user-triggered refresh always forces a fresh org read: post-connect and
  // post-credential-save the org identity may have just changed, and the Try
  // again control on the connect step (#2394) must escape the 60-second
  // negative cache a failed read leaves behind. The initial mount load uses the
  // cache, so an ordinary page load still costs no live Xero call.
  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const context: XeroWizardContext = {
    redirectUri: serverConfig.redirectUri,
    companyUrl: serverConfig.companyUrl,
    legacyEnvVars: serverConfig.legacyEnvVars,
    credentials,
    isFullAdmin: isFull,
    connected,
    needsReentry,
    orgName,
    orgError,
    orgLoading,
    webhookDeliveryUrl: serverConfig.webhookDeliveryUrl,
    webhooksVerifiable: serverConfig.webhooksVerifiable,
    webhookVerified,
  };

  return { context, loading, refresh };
}
