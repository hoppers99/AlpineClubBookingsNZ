/**
 * Withholding a definition is a usability property, not a security one. These
 * tests pin both halves: the filter really does withhold, AND the substrate is
 * documented and structured so that withholding is never the only thing standing
 * between a caller and a tool. The security half is asserted in `invoke.test.ts`,
 * which invokes a WITHHELD tool id and gets a fresh server-side denial.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// Only the MATRIX READER is stubbed. `hasAllAreaViews` and `missingAreaViews` stay
// real, which is the point of the end-to-end test below: one matrix has to drive
// both the withholding filter and the server-side verdict through the same
// predicate, so a divergence between them would fail here.
vi.mock("../../page-context/authorize", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../page-context/authorize")>();
  return { ...actual, readFreshAdminPermissionMatrix: vi.fn() };
});

import { readFreshAdminPermissionMatrix } from "../../page-context/authorize";
import { authorizeDiagnosticsToolCall } from "../authorize";
import {
  DIAGNOSTICS_NO_TOOLS_AVAILABLE_NOTICE,
  listDiagnosticsToolDefinitions,
  listWithheldDiagnosticsToolIds,
} from "../definitions";
import { DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID, DIAGNOSTICS_TOOLS } from "../registry";

function matrix(
  overrides: Partial<Record<keyof AdminPermissionMatrix, AdminPermissionLevel>> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as AdminPermissionMatrix;
  return { ...base, ...overrides };
}

describe("diagnostics tool definitions offered to the model (#2374, ADR-002 §2)", () => {
  /** Every registered tool whose declared areas are exactly `support`. */
  const SUPPORT_ONLY_TOOL_IDS = DIAGNOSTICS_TOOLS.filter(
    (tool) => tool.requiredAreas.length === 1 && tool.requiredAreas[0] === "support",
  ).map((tool) => tool.id);

  /** Every registered tool that declares `support` PLUS at least one other area. */
  const CROSS_AREA_TOOL_IDS = DIAGNOSTICS_TOOLS.filter(
    (tool) => tool.requiredAreas.length > 1,
  ).map((tool) => tool.id);

  /**
   * Every registered tool a `support:view`-only administrator must NOT be offered.
   *
   * This used to be `CROSS_AREA_TOOL_IDS`, and that was only correct while every
   * registered tool declared `support`. AID-6C (#2377) is the first pack whose
   * entries declare a DOMAIN area alone — `finance:view`, with no `support` — which
   * is exactly what #2375's owner decision requires of a domain pack, so the
   * withheld set is now "everything that is not support-only" rather than "the
   * multi-area ones". A support-only administrator is still offered nothing outside
   * their own area either way; the old expression simply stopped enumerating it.
   */
  const NOT_SUPPORT_ONLY_TOOL_IDS = DIAGNOSTICS_TOOLS.filter(
    (tool) => !SUPPORT_ONLY_TOOL_IDS.includes(tool.id),
  ).map((tool) => tool.id);

  /** Every registered tool whose declared areas are exactly `finance`. */
  const FINANCE_ONLY_TOOL_IDS = DIAGNOSTICS_TOOLS.filter(
    (tool) => tool.requiredAreas.length === 1 && tool.requiredAreas[0] === "finance",
  ).map((tool) => tool.id);

  it("offers the support-only tools to an admin holding support:view, and withholds everything else", () => {
    // AID-6A (#2375) is the first pack to register tools requiring MORE than
    // `support`: each domain correlation entry requires `support:view` AND the
    // affected domain's own area. So `support:view` alone must offer the system
    // evidence and the system correlation — and must NOT offer the booking,
    // membership, finance or lodge correlations, nor any of AID-6C's finance
    // entries, which need `finance:view` instead.
    const support = matrix({ support: "view" });
    const offered = listDiagnosticsToolDefinitions(support).map(
      (definition) => definition.name,
    );
    expect(offered).toContain(DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID);
    expect(offered).toEqual(SUPPORT_ONLY_TOOL_IDS);
    expect(SUPPORT_ONLY_TOOL_IDS.length).toBeGreaterThan(1);

    expect(CROSS_AREA_TOOL_IDS.length).toBeGreaterThan(0);
    expect(listWithheldDiagnosticsToolIds(support)).toEqual(
      NOT_SUPPORT_ONLY_TOOL_IDS,
    );
  });

  it("offers the finance-only tools to an admin holding finance:view WITHOUT support:view", () => {
    // #2377 acceptance criterion 1, at the courtesy layer: a Finance Officer must be
    // able to investigate a payment without also holding a support permission. The
    // executor's own check is pinned in the finance pack's permission-contract test;
    // this pins that the model is OFFERED them, so the operator is not told the
    // feature is unavailable when it is not.
    const finance = matrix({ finance: "view" });
    const offered = listDiagnosticsToolDefinitions(finance).map(
      (definition) => definition.name,
    );
    expect(FINANCE_ONLY_TOOL_IDS.length).toBeGreaterThan(0);
    expect(offered).toEqual(FINANCE_ONLY_TOOL_IDS);
    // …and not the combined ones, which need a second area each.
    expect(offered).not.toContain("diagnostics.booking_finance_state");
    expect(offered).not.toContain("diagnostics.xero_contact_linkage");
    expect(offered).not.toContain("diagnostics.finance_event_correlation");
  });

  it("offers them at `edit` too — `view` is a floor, not an exact level", () => {
    const definitions = listDiagnosticsToolDefinitions(matrix({ support: "edit" }));
    // Not `toHaveLength(SUPPORT_ONLY_TOOL_IDS.length)` alone: that comparison is
    // satisfied by 0 === 0 and would pass even if the filter withheld everything.
    expect(definitions.map((definition) => definition.name)).toEqual(
      SUPPORT_ONLY_TOOL_IDS,
    );
    expect(definitions.length).toBeGreaterThan(0);
  });

  it("offers EVERY tool to an admin holding view on every area", () => {
    const all = Object.fromEntries(
      ADMIN_PERMISSION_AREAS.map((area) => [area.key, "view"]),
    ) as AdminPermissionMatrix;
    expect(listDiagnosticsToolDefinitions(all).map((entry) => entry.name)).toEqual(
      DIAGNOSTICS_TOOLS.map((tool) => tool.id),
    );
    expect(listWithheldDiagnosticsToolIds(all)).toEqual([]);
  });

  it("withholds a cross-area tool from an admin holding only ONE of its areas", () => {
    // The AND rule, at the courtesy layer. A Booking Officer without `support:view`
    // gets no booking correlation, and a support admin without `bookings:view` gets
    // none either — the two halves are not interchangeable.
    for (const areas of [
      { bookings: "view" } as const,
      { support: "view" } as const,
    ]) {
      const offered = listDiagnosticsToolDefinitions(matrix(areas)).map(
        (definition) => definition.name,
      );
      for (const id of CROSS_AREA_TOOL_IDS) {
        expect(offered, `${id} offered on ${JSON.stringify(areas)}`).not.toContain(
          id,
        );
      }
    }
  });

  it("withholds every tool from an admin holding no relevant area", () => {
    // `lodge:edit` and nothing else. It was `finance:edit` until AID-6C (#2377)
    // registered tools that `finance` alone satisfies — at which point the matrix
    // stopped meaning "no relevant area" and the assertion would have been testing
    // the opposite of its name. `lodge` is the remaining area no tool declares on
    // its own: the lodge correlation entry needs `support:view` beside it.
    const lodgeOnly = matrix({ lodge: "edit" });
    expect(listDiagnosticsToolDefinitions(lodgeOnly)).toEqual([]);
    expect(listWithheldDiagnosticsToolIds(lodgeOnly)).toEqual(
      DIAGNOSTICS_TOOLS.map((tool) => tool.id),
    );
  });

  it("withholds everything from an empty matrix", () => {
    expect(listDiagnosticsToolDefinitions(matrix())).toEqual([]);
  });

  it("hands the provider a closed schema and server-owned text only", () => {
    const [definition] = listDiagnosticsToolDefinitions(matrix({ support: "view" }));
    expect(definition.input_schema.additionalProperties).toBe(false);
    // The name IS the registry key, so an accepted tool call maps back to exactly
    // one server-owned entry with no normalisation step in between.
    const tool = DIAGNOSTICS_TOOLS.find((entry) => entry.id === definition.name);
    expect(tool).toBeDefined();
    expect(definition.description).toBe(tool?.description);
    expect(definition.input_schema).toBe(tool?.inputSchema);
  });

  it("withholding and DENYING come from the same matrix and the same predicate", async () => {
    // The claim "withholding is courtesy, the server check is the control" is only
    // true if the two agree. Here ONE matrix is used twice: it withholds every
    // definition, and the executor's authorizer independently denies the same tool
    // when handed that matrix by the (stubbed) fresh reader. A filter that widened
    // relative to the authorizer — or an authorizer that widened relative to the
    // filter — fails this test.
    // `lodge:edit`, for the reason recorded above: no registered tool declares
    // `lodge` alone, so this matrix really does withhold everything.
    const withholding = matrix({ lodge: "edit" });
    vi.mocked(readFreshAdminPermissionMatrix).mockResolvedValue({
      ok: true,
      matrix: withholding,
    });

    const probe = DIAGNOSTICS_TOOLS.find(
      (tool) => tool.id === DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
    );
    expect(probe).toBeDefined();
    if (!probe) return;

    expect(listDiagnosticsToolDefinitions(withholding)).toEqual([]);
    expect(listWithheldDiagnosticsToolIds(withholding)).toContain(probe.id);

    const verdict = await authorizeDiagnosticsToolCall({
      actingMemberId: "member-1",
      requiredAreas: probe.requiredAreas,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("permission_denied");
      expect(verdict.missingAreas).toEqual([...probe.requiredAreas]);
    }
  });

  it("explains the empty case without naming tools the operator cannot run", () => {
    expect(DIAGNOSTICS_NO_TOOLS_AVAILABLE_NOTICE).toContain("admin access");
    for (const tool of DIAGNOSTICS_TOOLS) {
      expect(DIAGNOSTICS_NO_TOOLS_AVAILABLE_NOTICE).not.toContain(tool.id);
    }
  });
});
