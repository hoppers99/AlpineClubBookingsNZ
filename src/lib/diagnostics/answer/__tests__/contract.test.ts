/**
 * THE REFUSAL COPY NEVER INVITES A RELOAD (#2378; #2804, owner decision 12 Aug 2026).
 *
 * The conversation lives only in the browser (owner decision Q5 — nothing is
 * persisted), so "refresh the page" is the one suggestion that costs the operator
 * their whole investigation. `contract.ts` calls the rule "a requirement rather
 * than a style choice" over the whole blocked-copy table, and the contract review
 * (13 Aug 2026) found it enforced by nothing — in a PR that built derived censuses
 * for smaller claims, a new reason shipping with "refresh the page and try again"
 * would have passed every gate.
 *
 * The census is derived: it walks whatever entries the table HAS, so a new refusal
 * reason is covered the moment it exists. The client's own transport/session
 * sentences (the ones no server copy exists for) are held to the same rule.
 */

import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_ASK_BLOCKED_COPY } from "../contract";
import {
  DIAGNOSTICS_NETWORK_FAILURE_COPY,
  DIAGNOSTICS_RATE_LIMITED_COPY,
  DIAGNOSTICS_SESSION_FAILURE_COPY,
  DIAGNOSTICS_UNAVAILABLE_COPY,
} from "@/components/help-widget/use-diagnostics-chat";

const INVITES_RELOAD = /reload|refresh|f5|start (the page )?again/i;

describe("no diagnostics refusal invites a reload (#2804)", () => {
  it("holds for every entry in the server's blocked-copy table", () => {
    const entries = Object.entries(DIAGNOSTICS_ASK_BLOCKED_COPY);
    // Non-vacuity: the table exists and is the size the contract module declares.
    expect(entries.length).toBeGreaterThan(0);
    for (const [reason, copy] of entries) {
      const text = JSON.stringify(copy);
      // "you do not need to reload" states the rule and is the one permitted use.
      const stripped = text.replace(/do not need to reload( the page)?/gi, "");
      expect(stripped, `blocked copy for "${reason}" invites a reload`).not.toMatch(
        INVITES_RELOAD,
      );
    }
  });

  it("holds for the client's own transport and session sentences", () => {
    for (const copy of [
      DIAGNOSTICS_NETWORK_FAILURE_COPY,
      DIAGNOSTICS_RATE_LIMITED_COPY,
      DIAGNOSTICS_SESSION_FAILURE_COPY,
      DIAGNOSTICS_UNAVAILABLE_COPY,
    ]) {
      const stripped = copy.replace(/do not need to reload( the page)?/gi, "");
      expect(stripped, copy).not.toMatch(INVITES_RELOAD);
    }
  });
});
