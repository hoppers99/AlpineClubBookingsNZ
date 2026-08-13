/**
 * THE UNTRUSTED-WRAPPER CENSUS (AID-8 §3, #2379).
 *
 * The frozen system prompt (`answer/prompt.ts`) tells the model that everything
 * inside a named set of wrapper blocks is UNTRUSTED DATA. That protection is only
 * as good as the list being COMPLETE and CORRECT: a wrapper a renderer emits but
 * the prompt does not name is a channel the model was never told to distrust.
 *
 * The prompt-injection lens found exactly that drift — the prompt named a
 * `diagnostics_source` block that NO renderer emits, while the real source wrapper
 * (`deployed_source_evidence`, the channel with the weakest defusal at the time)
 * went unnamed. This census makes the two impossible to drift again: it imports the
 * wrapper token EACH renderer actually emits (not a re-typed copy of the string)
 * and asserts the frozen prompt names every one. Rename a wrapper in its renderer
 * without updating the prompt and this test goes red at the new name.
 */

import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_SYSTEM_PROMPT, CONVERSATION_TAG, QUESTION_TAG } from "../answer/prompt";
import { SOURCE_EVIDENCE_TAG } from "../knowledge/retrieve";
import { PAGE_CONTEXT_EVIDENCE_TAG } from "../page-context/render";
import { TOOL_RESULT_EVIDENCE_TAG } from "../tools/render";

/**
 * Every untrusted-evidence wrapper any diagnostics renderer emits, taken from the
 * renderer's OWN exported constant so a rename travels here automatically. Keyed by
 * the module so a failure names the renderer whose wrapper the prompt forgot.
 */
const EMITTED_WRAPPERS: ReadonlyArray<readonly [module: string, tag: string]> = [
  ["answer/prompt.ts (conversation)", CONVERSATION_TAG],
  ["answer/prompt.ts (question)", QUESTION_TAG],
  ["knowledge/retrieve.ts (source evidence)", SOURCE_EVIDENCE_TAG],
  ["page-context/render.ts", PAGE_CONTEXT_EVIDENCE_TAG],
  ["tools/render.ts", TOOL_RESULT_EVIDENCE_TAG],
];

describe("the system prompt names every emitted untrusted wrapper (#2379)", () => {
  it.each(EMITTED_WRAPPERS)(
    "%s emits a wrapper the frozen prompt lists as untrusted data",
    (_module, tag) => {
      expect(DIAGNOSTICS_SYSTEM_PROMPT).toContain(tag);
    },
  );

  it("guards against a wrapper the prompt does not name", () => {
    // The failure mode this census exists to catch, spelled out: a wrapper string
    // the prompt does not contain must fail. `diagnostics_source` — the phantom the
    // prompt named until #2379 — is now precisely such a string, so it must NOT
    // appear in the prompt.
    expect(DIAGNOSTICS_SYSTEM_PROMPT).not.toContain("diagnostics_source");
  });
});
