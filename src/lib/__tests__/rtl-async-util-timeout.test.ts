// @vitest-environment jsdom

/*
  Reads back the repo-wide RTL async window set in `vitest.setup.ts` (#2944).

  The setting is invisible by nature: the 219 suites that depend on it do so by
  NOT failing, so dropping it would silently restore the 1000ms default and with
  it the original symptom — a `TestingLibraryElementError: Unable to find …` that
  reads as a missing element and lands on a different suite each run — while
  nothing went red at the moment the setting was lost. This file is the one place
  that asserts the value exists.

  Why 4,000 and not 5,000, and the measurements behind it, are stated once in
  `vitest.setup.ts` and are not repeated here. The short version of the ceiling:
  it has to stay strictly below vitest's 5,000ms `testTimeout`, because an equal
  window loses the race and the failure is then reported as the opaque "Test
  timed out in 5000ms" rather than RTL's message naming the query and dumping the
  DOM.

  Deliberately a jsdom suite: `vitest.config.ts` defaults the environment to
  `node`, and the setup file only configures RTL when a `document` exists.
*/

// Side-effect import, and load-bearing: `@testing-library/react` calls
// `configure()` itself on load to install its act-aware wrappers. The setup file
// runs before any test file's imports, so this asserts the ordering is safe —
// that RTL's own `configure()` merges into the shared config rather than
// replacing it and taking the window back to the default.
import "@testing-library/react";
import { getConfig } from "@testing-library/dom";
import { describe, expect, it } from "vitest";

describe("RTL async utility timeout (#2944)", () => {
  it("is configured repo-wide rather than left on the 1000ms default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(4_000);
  });
});
