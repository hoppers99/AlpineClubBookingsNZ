// @vitest-environment jsdom

/*
 * `useLodgeOptions` is the single place every lodge selector in the admin tree
 * gets its options, and until #2701 it reported exactly one thing: a list. A
 * failed request, a refused request and a club with no active lodges all
 * arrived as `lodges: []`, so no caller could tell them apart and none of them
 * tried.
 *
 * The hook itself had no test at all — `lodge-select.test.tsx` covers the
 * component. These pin the three outcomes separately, because every page-level
 * error state in this PR is derived from them.
 */

import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLodgeOptions } from "../lodge-select";

function stubFetch(responder: () => unknown) {
  const fetchMock = vi.fn(async (_url: string) => responder());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const OK = (lodges: Array<{ id: string; name: string; active?: boolean }>) => ({
  ok: true,
  status: 200,
  json: async () => ({ lodges }),
});

describe("useLodgeOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a successful list, with neither failure flag set", async () => {
    stubFetch(() => OK([{ id: "lodge-1", name: "Alpine Lodge" }]));

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lodges).toEqual([
      { id: "lodge-1", name: "Alpine Lodge", travelNote: undefined },
    ]);
    expect(result.current.failed).toBe(false);
    expect(result.current.forbidden).toBe(false);
  });

  it("reports an EMPTY club as empty, not as a failure", async () => {
    // The state every caller used to conflate with the two below.
    stubFetch(() => OK([]));

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lodges).toEqual([]);
    expect(result.current.failed).toBe(false);
    expect(result.current.forbidden).toBe(false);
  });

  it("drops inactive lodges without calling it a failure", async () => {
    stubFetch(() =>
      OK([
        { id: "lodge-1", name: "Alpine Lodge", active: true },
        { id: "lodge-2", name: "Closed Lodge", active: false },
      ]),
    );

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lodges.map((lodge) => lodge.id)).toEqual(["lodge-1"]);
    expect(result.current.failed).toBe(false);
  });

  it("reports a server error as FAILED", async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(result.current.forbidden).toBe(false);
    expect(result.current.lodges).toEqual([]);
  });

  it("reports a transport error as FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(result.current.forbidden).toBe(false);
  });

  it("reports a 403 as FORBIDDEN and not as a failure", async () => {
    // A permissions fact, not an outage. `ADMIN_MEMBERSHIP` and
    // `FINANCE_ADMIN` hold no `lodge` permission, so this is the normal answer
    // for them and a retry could only refuse again.
    stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));

    const { result } = renderHook(() => useLodgeOptions("admin"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.lodges).toEqual([]);
  });

  it("re-requests on reload, and clears the failure when the retry succeeds", async () => {
    // The retry has to actually work: an error state with a dead button is
    // worse than no button.
    let attempt = 0;
    const fetchMock = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, status: 500, json: async () => ({}) }
        : OK([{ id: "lodge-1", name: "Alpine Lodge" }]);
    });

    const { result } = renderHook(() => useLodgeOptions("admin"));
    await waitFor(() => expect(result.current.failed).toBe(true));

    act(() => result.current.reload());

    await waitFor(() => expect(result.current.failed).toBe(false));
    expect(result.current.lodges.map((lodge) => lodge.id)).toEqual(["lodge-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks the member endpoint for the member scope", async () => {
    const fetchMock = stubFetch(() => OK([]));

    const { result } = renderHook(() => useLodgeOptions("member"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/lodges");
  });
});
