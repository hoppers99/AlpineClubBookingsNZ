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

  it("offers the support-only tools to an admin holding support:view, and withholds the cross-area ones", () => {
    // AID-6A (#2375) is the first pack to register tools requiring MORE than
    // `support`: each domain correlation entry requires `support:view` AND the
    // affected domain's own area. So `support:view` alone must offer the system
    // evidence and the system correlation — and must NOT offer the booking,
    // membership, finance or lodge correlations.
    const support = matrix({ support: "view" });
    const offered = listDiagnosticsToolDefinitions(support).map(
      (definition) => definition.name,
    );
    expect(offered).toContain(DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID);
    expect(offered).toEqual(SUPPORT_ONLY_TOOL_IDS);
    expect(SUPPORT_ONLY_TOOL_IDS.length).toBeGreaterThan(1);

    expect(CROSS_AREA_TOOL_IDS.length).toBeGreaterThan(0);
    expect(listWithheldDiagnosticsToolIds(support)).toEqual(CROSS_AREA_TOOL_IDS);
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
    const finance = matrix({ finance: "edit" });
    expect(listDiagnosticsToolDefinitions(finance)).toEqual([]);
    expect(listWithheldDiagnosticsToolIds(finance)).toEqual(
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
    const withholding = matrix({ finance: "edit" });
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
