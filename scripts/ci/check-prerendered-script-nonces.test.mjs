import { describe, expect, it } from "vitest";

import {
  KNOWN_UNNONCED_PRERENDERS,
  auditPrerenderedHtml,
  checkBuildOutput,
  findUnnoncedInlineScripts,
} from "./check-prerendered-script-nonces.mjs";

/**
 * Unit coverage for the pure half of the prerendered-nonce gate (#2356). The
 * gate itself runs against real build output in CI, after `npm run build`;
 * these tests pin the RULES so a future edit cannot loosen them silently.
 */

const NONCE = "ZTljYzE2MmUtMTVhYi00YzliLWI4YTk";

describe("findUnnoncedInlineScripts", () => {
  it("flags an inline script with no nonce", () => {
    const html = `<html><body><script>self.__next_f.push([0])</script></body></html>`;
    expect(findUnnoncedInlineScripts(html)).toEqual(["<script>"]);
  });

  it("accepts an inline script carrying a nonce", () => {
    const html = `<script nonce="${NONCE}">self.__next_f.push([0])</script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([]);
  });

  it("ignores external scripts, which script-src 'self' already covers", () => {
    const html = `<script src="/_next/static/chunks/a.js" async=""></script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([]);
  });

  it("treats an EMPTY nonce as unnonced", () => {
    // `nonce=""` matches no 'nonce-…' source expression, so the browser blocks
    // the script exactly as if the attribute were absent. Accepting it would be
    // the silent pass this guard exists to prevent.
    const html = `<script nonce="">alert(1)</script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([`<script nonce="">`]);
  });

  it("finds every offender in a document, not just the first", () => {
    const html = `<script>a</script><script nonce="${NONCE}">b</script><script>c</script>`;
    expect(findUnnoncedInlineScripts(html)).toHaveLength(2);
  });
});

describe("auditPrerenderedHtml", () => {
  const allowlist = new Map([["server/app/_global-error.html", "documented reason"]]);

  it("passes when every prerendered artefact is nonced", () => {
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script>bootstrap</script>`],
      ["server/app/other.html", `<script nonce="${NONCE}">ok</script>`],
    ]);
    expect(auditPrerenderedHtml(artefacts, allowlist)).toEqual({
      offenders: [],
      staleAllowances: [],
    });
  });

  it("reports a NEW prerendered route that ships unnonced inline scripts", () => {
    // The regression this whole check exists for: someone adds a prerendered
    // page (or drops a `force-dynamic`) and the CSP silently blocks its scripts.
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script>bootstrap</script>`],
      ["server/app/_not-found.html", `<script>self.__next_f.push([0])</script>`],
    ]);
    const { offenders } = auditPrerenderedHtml(artefacts, allowlist);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].file).toBe("server/app/_not-found.html");
    expect(offenders[0].count).toBe(1);
  });

  it("reports an allowlisted artefact the build no longer emits", () => {
    const { staleAllowances } = auditPrerenderedHtml(new Map(), allowlist);
    expect(staleAllowances).toHaveLength(1);
    expect(staleAllowances[0]).toContain("was not emitted by the build");
  });

  it("reports an allowlisted artefact that has stopped offending", () => {
    // If a Next release starts nonce-ing the global error page, the carve-out
    // must be deleted rather than quietly outliving its reason.
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script nonce="${NONCE}">bootstrap</script>`],
    ]);
    const { staleAllowances } = auditPrerenderedHtml(artefacts, allowlist);
    expect(staleAllowances).toHaveLength(1);
    expect(staleAllowances[0]).toContain("delete the carve-out");
  });

  it("keeps the shipped allowlist closed and documented", () => {
    // Adding an entry here is a deliberate, reviewed act: each one is a page
    // whose scripts our own CSP blocks in production.
    expect([...KNOWN_UNNONCED_PRERENDERS.keys()]).toEqual([
      "server/app/_global-error.html",
      "server/pages/500.html",
    ]);
    for (const reason of KNOWN_UNNONCED_PRERENDERS.values()) {
      expect(reason).toMatch(/#2356/);
    }
  });
});

describe("checkBuildOutput", () => {
  it("throws rather than passing quietly when there is no build output", () => {
    // The failure mode the check must never have: a green result from a run
    // that inspected nothing.
    expect(() => checkBuildOutput("./definitely-not-a-build-dir-2356")).toThrow(
      /must run AFTER `npm run build`/,
    );
  });
});
