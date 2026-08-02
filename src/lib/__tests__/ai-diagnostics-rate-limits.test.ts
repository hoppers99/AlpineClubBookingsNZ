import { beforeEach, describe, expect, it } from "vitest";

import {
  checkRateLimitInMemory,
  rateLimiters,
  _testStore,
} from "@/lib/rate-limit";

// The AI Diagnostics abuse throttles (AID-2, #2371) are a SEPARATE set from the
// page-help aiChat* limiters. The real spend control is the concurrency-safe
// monthly reservation gate; these caps stop bursts and abuse, and are
// auth-sensitive so a degraded shared-store fallback cannot be used to multiply
// paid-call budget across replicas.

beforeEach(() => {
  _testStore.clear();
});

describe("diagnostics rate limiters exist and are auth-sensitive", () => {
  it("registers per-admin, per-IP, and global diagnostics limiters", () => {
    expect(rateLimiters.aiDiagnosticsAdmin.id).toBe("ai-diagnostics-admin");
    expect(rateLimiters.aiDiagnosticsIp.id).toBe("ai-diagnostics-ip");
    expect(rateLimiters.aiDiagnosticsGlobal.id).toBe("ai-diagnostics-global");
  });

  it("marks all three auth-sensitive (a degraded store TIGHTENS the paid-call budget)", () => {
    expect(rateLimiters.aiDiagnosticsAdmin.authSensitive).toBe(true);
    expect(rateLimiters.aiDiagnosticsIp.authSensitive).toBe(true);
    expect(rateLimiters.aiDiagnosticsGlobal.authSensitive).toBe(true);
  });

  it("keeps them distinct from the page-help aiChat* limiter ids", () => {
    const diagIds = [
      rateLimiters.aiDiagnosticsAdmin.id,
      rateLimiters.aiDiagnosticsIp.id,
      rateLimiters.aiDiagnosticsGlobal.id,
    ];
    const chatIds = [
      rateLimiters.aiChatMember.id,
      rateLimiters.aiChatIp.id,
      rateLimiters.aiChatGlobal.id,
    ];
    for (const id of diagIds) expect(chatIds).not.toContain(id);
  });
});

describe("per-admin diagnostics limiter TRIPS at its budget", () => {
  it("allows up to the limit, then denies", () => {
    const cfg = rateLimiters.aiDiagnosticsAdmin;
    let last;
    for (let i = 0; i < cfg.limit; i++) {
      last = checkRateLimitInMemory(cfg, "member:m1");
      expect(last.success).toBe(true);
    }
    // The (limit + 1)th attempt in the window is refused.
    const overflow = checkRateLimitInMemory(cfg, "member:m1");
    expect(overflow.success).toBe(false);
    expect(overflow.remaining).toBe(0);
  });

  it("degrades the budget on a shared-store outage (auth-sensitive fail-safe)", () => {
    const cfg = rateLimiters.aiDiagnosticsAdmin;
    // Degraded mode runs at limit/4 (min 1). The very first request past that
    // reduced budget is refused, proving a store outage cannot MULTIPLY the cap.
    const degradedLimit = Math.max(1, Math.floor(cfg.limit / 4));
    let last;
    for (let i = 0; i < degradedLimit; i++) {
      last = checkRateLimitInMemory(cfg, "member:m2", { degraded: true });
      expect(last.success).toBe(true);
    }
    const overflow = checkRateLimitInMemory(cfg, "member:m2", { degraded: true });
    expect(overflow.success).toBe(false);
    expect(overflow.limit).toBe(degradedLimit);
    expect(degradedLimit).toBeLessThan(cfg.limit);
  });
});
