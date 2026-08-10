// @vitest-environment jsdom

// #2733: the audit-log member filter used to carry `memberName` and
// `memberEmail` in the page's own URL, so a member's name and email address
// reached browser history, every reverse-proxy/CDN access log, and the `Referer`
// of anything the page links out to — places the log/Sentry redactor of
// INV-PRIV-011 cannot reach. These tests pin the replacement contract: the URL
// round-trip carries `memberId` and nothing else, and an id-only URL still
// renders the right chip label because the label is resolved from the id.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => currentSearchParams,
}));

const JANE = {
  id: "member-jane",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.test",
  role: "MEMBER",
};

const emptyAuditPage = {
  data: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  facets: {
    eventTypes: [],
    categories: [],
    entityTypes: [],
    outcomes: [],
    severities: [],
  },
};

let requestedUrls: string[] = [];
let membersLookupStatus = 200;

function stubFetch() {
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("/api/admin/audit-log?")) {
      return { ok: true, json: async () => emptyAuditPage } as Response;
    }
    if (url.startsWith("/api/admin/members?")) {
      if (membersLookupStatus !== 200) {
        return {
          ok: false,
          status: membersLookupStatus,
          json: async () => ({ error: "Unauthorized" }),
        } as Response;
      }
      return { ok: true, json: async () => ({ members: [JANE] }) } as Response;
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

async function renderAuditLogPage() {
  const AuditLogPage = (await import("@/app/(admin)/admin/audit-log/page")).default;
  render(<AuditLogPage />);
}

/** Every address this page put in front of the browser, decoded for assertions. */
function replacedPaths() {
  return replace.mock.calls.map(([path]) => decodeURIComponent(String(path)));
}

function expectNoPersonFields(values: string[]) {
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).not.toContain("memberName");
    expect(value).not.toContain("memberEmail");
    expect(value).not.toContain(JANE.firstName);
    expect(value).not.toContain(JANE.lastName);
    expect(value).not.toContain(JANE.email);
    expect(value).not.toContain("@");
  }
}

beforeEach(() => {
  requestedUrls = [];
  membersLookupStatus = 200;
  currentSearchParams = new URLSearchParams();
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin audit log member filter URL (#2733)", () => {
  it("resolves the chip label from an id-only URL and keeps the URL id-only", async () => {
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();

    // The label came from the authorized members lookup, keyed by the id.
    expect(
      requestedUrls.some((url) => url === `/api/admin/members?q=${JANE.id}&pageSize=8`),
    ).toBe(true);

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    expectNoPersonFields(paths);
    expectNoPersonFields(
      requestedUrls.filter((url) => url.startsWith("/api/admin/audit-log?")),
    );
  });

  it("rewrites a bookmarked pre-#2733 URL without its name and email params", async () => {
    currentSearchParams = new URLSearchParams({
      memberId: JANE.id,
      memberName: "Jane Doe",
      memberEmail: JANE.email,
      page: "2",
    });

    await renderAuditLogPage();

    await waitFor(() => expect(replace).toHaveBeenCalled());

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    // Unrelated URL context still survives the rewrite.
    expect(paths.every((path) => path.includes("page=2"))).toBe(true);
    expectNoPersonFields(paths);
    expectNoPersonFields(
      requestedUrls.filter((url) => url.startsWith("/api/admin/audit-log?")),
    );
  });

  it("puts only the id in the URL when a member is picked from the search box", async () => {
    await renderAuditLogPage();

    // The picker debounces by 250ms before it fetches, well inside RTL's default
    // 1000ms findBy* timeout.
    fireEvent.change(screen.getByPlaceholderText("Name, email, or ID"), {
      target: { value: "Jane" },
    });

    fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));

    await waitFor(() =>
      expect(
        replacedPaths().some((path) => path.includes(`memberId=${JANE.id}`)),
      ).toBe(true),
    );

    expectNoPersonFields(replacedPaths());
    expectNoPersonFields(
      requestedUrls.filter((url) => url.startsWith("/api/admin/audit-log?")),
    );
  });

  it("keeps a neutral label when the member lookup is refused, and still filters by id", async () => {
    // An audit reader holds `support:view`; the members search is gated on
    // `membership:view`. Resolving the label must never widen that, so a refusal
    // leaves the fallback label and a working id filter.
    membersLookupStatus = 401;
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    expect(await screen.findByText("Selected member")).toBeInTheDocument();

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    expectNoPersonFields(paths);
  });
});
