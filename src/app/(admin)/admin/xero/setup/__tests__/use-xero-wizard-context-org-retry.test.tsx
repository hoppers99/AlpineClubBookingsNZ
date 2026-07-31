// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useXeroWizardContext,
  type XeroWizardServerConfig,
} from "../use-xero-wizard-context";

/*
  #2394 — the wizard context must report a failed organisation read, and its
  refresh must genuinely re-read.

  The bug had two halves, and only fixing the second one matters here: the
  server route answered 200 with a null name (the read failed inside
  `getXeroConnectedOrganisation`, which never throws), so nothing the client
  could see said "this failed". These tests drive the real hook against a
  scripted route and pin that (a) a failure becomes a reportable error rather
  than an endless wait, (b) a refresh asks with ?refresh=1, which is what
  escapes the server's 60-second NEGATIVE cache and makes Try again real, and
  (c) an ordinary first load still uses the cache, so no extra Xero quota is
  spent unless a human presses the button.
*/

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { accessRoles: ["FULL_ADMIN"] } },
    status: "authenticated",
  }),
}));

const SERVER_CONFIG: XeroWizardServerConfig = {
  redirectUri: "https://club.example.test/api/admin/xero/callback",
  companyUrl: "https://club.example.test",
  legacyEnvVars: [],
  webhookDeliveryUrl: "https://club.example.test/api/webhooks/xero",
  webhooksVerifiable: true,
};

type RouteReply = { ok: boolean; status?: number; body: unknown } | Error;

/**
 * Scripted fetch: credentials/status/webhook always succeed, and the
 * organisation route hands back the next reply in `orgReplies` (repeating the
 * last one), so a test can say "fail, then succeed" without racing.
 */
function stubFetch(options: {
  connected?: boolean;
  orgReplies: RouteReply[];
}) {
  const orgUrls: string[] = [];
  let orgCall = 0;
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("/api/admin/integrations/credentials")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentials: {
            client_id: { set: true, setAt: null },
            client_secret: { set: true, setAt: null },
          },
        }),
      };
    }
    if (url.startsWith("/api/admin/xero/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          connected: options.connected ?? true,
          needsReentry: false,
        }),
      };
    }
    if (url.startsWith("/api/admin/xero/webhook/verify-status")) {
      return { ok: true, status: 200, json: async () => ({ verified: false }) };
    }
    if (url.startsWith("/api/admin/xero/organisation")) {
      orgUrls.push(url);
      const reply =
        options.orgReplies[Math.min(orgCall, options.orgReplies.length - 1)];
      orgCall += 1;
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.ok,
        status: reply.status ?? (reply.ok ? 200 : 500),
        json: async () => reply.body,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, orgUrls };
}

const okOrg = (name: string | null): RouteReply => ({
  ok: true,
  body: { name, financialYearEndMonth: 3, shortCode: "!abc12", readFailure: null },
});

const failedOrg = (
  readFailure: Record<string, unknown>,
): RouteReply => ({
  ok: true,
  body: { name: null, financialYearEndMonth: null, shortCode: null, readFailure },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useXeroWizardContext: a successful read is unchanged (#2394)", () => {
  it("reports the organisation name, no error, and does not force a refresh", async () => {
    const { orgUrls } = stubFetch({ orgReplies: [okOrg("Alpine Sports Club")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgError).toBeNull();
    expect(result.current.context.orgLoading).toBe(false);
    // An ordinary page load rides the server's 12-hour cache — it must not
    // spend a live Xero call just by being opened.
    expect(orgUrls).toEqual(["/api/admin/xero/organisation"]);
  });

  it("makes no organisation call at all while Xero is disconnected", async () => {
    const { orgUrls } = stubFetch({ connected: false, orgReplies: [okOrg("X")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(orgUrls).toEqual([]);
    expect(result.current.context.orgError).toBeNull();
  });
});

describe("useXeroWizardContext: a failed read is surfaced (#2394)", () => {
  it("carries the server's failure class through instead of waiting for ever", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "rate_limited", rateLimit: "day", retryAfterSeconds: 7200 }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());
    expect(result.current.context.orgError).toEqual({
      kind: "rate_limited",
      rateLimit: "day",
      retryAfterSeconds: 7200,
    });
    expect(result.current.context.orgName).toBeNull();
  });

  it("reports a reconnect-class failure as its own thing", async () => {
    stubFetch({
      orgReplies: [failedOrg({ kind: "disconnected", rateLimit: null, retryAfterSeconds: null })],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("disconnected"),
    );
  });

  it("treats a refused fetch as temporarily unavailable", async () => {
    // The exact CI repro from #2302: the mock harness's loopback was refused,
    // which used to be swallowed by the bare `catch {}`.
    stubFetch({ orgReplies: [new Error("fetch failed: ECONNREFUSED")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );
  });

  it("separates 'this site refused you' from 'Xero is unavailable'", async () => {
    stubFetch({ orgReplies: [{ ok: false, status: 403, body: {} }] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("forbidden"),
    );
  });

  it("does not sit on 'Confirming…' when the read succeeds with no name at all", async () => {
    stubFetch({ orgReplies: [okOrg(null)] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );
  });

  it("degrades an unrecognised failure kind rather than dropping it", async () => {
    stubFetch({ orgReplies: [failedOrg({ kind: "something-new-from-a-newer-server" })] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError).toEqual({
        kind: "unavailable",
        rateLimit: null,
        retryAfterSeconds: null,
      }),
    );
  });
});

describe("useXeroWizardContext: Try again really re-reads (#2394)", () => {
  it("asks with ?refresh=1 — the only way past the 60-second negative cache", async () => {
    const { orgUrls } = stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        okOrg("Alpine Sports Club"),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgError).toBeNull();
    expect(orgUrls).toEqual([
      "/api/admin/xero/organisation",
      "/api/admin/xero/organisation?refresh=1",
    ]);
  });

  it("keeps reporting the failure when the retry fails too", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        failedOrg({ kind: "rate_limited", rateLimit: "minute", retryAfterSeconds: 30 }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );

    await act(async () => {
      result.current.refresh();
    });

    // The second attempt hit a rate limit: still an error, and now a more
    // specific one — never a silent return to "Confirming…".
    await waitFor(() =>
      expect(result.current.context.orgError).toEqual({
        kind: "rate_limited",
        rateLimit: "minute",
        retryAfterSeconds: 30,
      }),
    );
    expect(result.current.context.orgName).toBeNull();
    expect(result.current.context.orgLoading).toBe(false);
  });
});
