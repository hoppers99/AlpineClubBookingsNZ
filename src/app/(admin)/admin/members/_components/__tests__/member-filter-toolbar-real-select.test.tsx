// @vitest-environment jsdom

/**
 * The members filter toolbar rendered against the REAL `@/components/ui/select`,
 * and a repo-wide guard on the component that broke it.
 *
 * WHY THIS FILE EXISTS, and why the other toolbar suites could not do its job.
 * `member-type-tier.test.tsx` and `access-role-ui.test.tsx` both mock
 * `@/components/ui/select` wholesale, swapping every part for a plain `<div>`.
 * That is reasonable for asserting on options without fighting Radix in jsdom —
 * but it means no unit test ever rendered the real component, and when #2978
 * added a `<SelectLabel>` directly inside `<SelectContent>` those suites stayed
 * green while `/admin/members` threw on every render:
 *
 *     `SelectLabel` must be used within `SelectGroup`
 *
 * Radix's `Select.Label` reads a context that only `Select.Group` provides, and
 * that context is created with no default, so the consumer throws rather than
 * degrading. Playwright caught it — one spec, all three retries — because it is
 * the only place the real component runs.
 *
 * This is the incomplete-mock-factory hazard in `AGENTS.md` running BACKWARDS.
 * There the mock was missing an export the tree needed and the file died at
 * import; here the mock was *given* an export whose real implementation refuses
 * the way it was used, so the mock made a broken render look fine. The lesson is
 * the same: a mocked component tree proves nothing about the component.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Only the role-options fetch is stubbed; every Radix part below is real.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

import { MemberFilterToolbar } from "../member-filter-toolbar";
import { emptyFilters } from "../../_utils";

beforeAll(() => {
  // Radix measures and scrolls; jsdom implements none of it. These are the
  // standard shims, and none of them affects whether a render throws.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => cleanup());

function renderRealToolbar() {
  return render(
    <MemberFilterToolbar
      search=""
      filters={emptyFilters}
      xeroFeatures={{ liveMemberGroupLookups: false, autoLoadContactGroups: false }}
      xeroContactGroupsList={[]}
      membershipTypes={[
        { id: "mt-full", key: "FULL", name: "Full", isActive: true },
        { id: "mt-old", key: "OLD", name: "Retired", isActive: false },
      ]}
      onSearchChange={vi.fn()}
      onSetFilter={vi.fn()}
      resetDisabled
      onReset={vi.fn()}
    />,
  );
}

describe("members filter toolbar against the real Radix select (#2978)", () => {
  it("mounts without throwing", () => {
    // The whole regression in one assertion. A throw here is not a test detail:
    // it is /admin/members failing to render for every officer.
    expect(() => renderRealToolbar()).not.toThrow();
  });

  it("still shows the filter's own trigger once mounted", () => {
    renderRealToolbar();

    // Proof the render actually produced the control, so the assertion above
    // cannot pass by rendering nothing at all.
    expect(
      screen.getByLabelText("Filter by membership type"),
    ).toBeInTheDocument();
  });
});

/**
 * The same defect, guarded everywhere rather than only on the file that hit it.
 * Cheap, and it covers the two existing correct call sites plus every future one.
 */
describe("every SelectLabel sits inside a SelectGroup", () => {
  function tsxFilesUnder(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(full);
          continue;
        }
        if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          found.push(full);
        }
      }
    };
    walk(root);
    return found.sort();
  }

  it("nobody renders a bare <SelectLabel>", () => {
    const offenders: string[] = [];
    for (const file of tsxFilesUnder(path.resolve(process.cwd(), "src"))) {
      // The wrapper that DEFINES SelectLabel legitimately names it.
      if (file.endsWith(path.join("components", "ui", "select.tsx"))) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<SelectLabel")) continue;
      // A file that renders one must also render the group that provides its
      // context. Deliberately coarse — a per-occurrence parse would be a JSX
      // parser, and every real misuse so far has been a file with no group at
      // all.
      if (!source.includes("<SelectGroup")) {
        offenders.push(path.relative(process.cwd(), file).split(path.sep).join("/"));
      }
    }

    expect(
      offenders,
      "Radix's Select.Label reads a context only Select.Group provides, and it " +
        "throws rather than degrading — so a bare <SelectLabel> takes the whole " +
        "page down the moment the select renders. Wrap it in <SelectGroup>.",
    ).toEqual([]);
  });
});
