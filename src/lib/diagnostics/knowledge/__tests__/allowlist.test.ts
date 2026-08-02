import { describe, expect, it } from "vitest";

import {
  DEFAULT_INCLUDE_GLOBS,
  OPTIONAL_SOURCE_INCLUDE_GLOBS,
  globToRegExp,
  isAllowlisted,
  isTextlikePath,
  resolveAllowlist,
} from "../allowlist";

describe("globToRegExp", () => {
  it("matches `**` across path segments and `*` within one", () => {
    expect(globToRegExp("docs/**/*.md").test("docs/a.md")).toBe(true);
    expect(globToRegExp("docs/**/*.md").test("docs/x/y/z.md")).toBe(true);
    expect(globToRegExp("docs/**/*.md").test("other/a.md")).toBe(false);
    expect(globToRegExp("**/*.test.ts").test("src/lib/x.test.ts")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/x.md")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(globToRegExp("prisma/schema.prisma").test("prisma/schemaXprisma")).toBe(
      false,
    );
    expect(globToRegExp("prisma/schema.prisma").test("prisma/schema.prisma")).toBe(
      true,
    );
  });
});

describe("isTextlikePath", () => {
  it("accepts text extensions and rejects binaries", () => {
    expect(isTextlikePath("docs/x.md")).toBe(true);
    expect(isTextlikePath("prisma/schema.prisma")).toBe(true);
    expect(isTextlikePath("public/logo.png")).toBe(false);
    expect(isTextlikePath("Makefile")).toBe(false);
  });
});

describe("isAllowlisted (default lattice)", () => {
  const allowlist = resolveAllowlist();

  it("includes docs, root project docs, and the prisma schema by default", () => {
    expect(isAllowlisted("docs/ARCHITECTURE.md", allowlist)).toBe(true);
    expect(isAllowlisted("README.md", allowlist)).toBe(true);
    expect(isAllowlisted("prisma/schema.prisma", allowlist)).toBe(true);
  });

  it("EXCLUDES first-party source by default (opt-in only)", () => {
    expect(isAllowlisted("src/lib/auth.ts", allowlist)).toBe(false);
  });

  it("excludes tests, env files, generated code, and unallowlisted files", () => {
    expect(isAllowlisted("src/lib/__tests__/auth.test.ts", allowlist)).toBe(false);
    expect(isAllowlisted(".env", allowlist)).toBe(false);
    expect(isAllowlisted(".env.production", allowlist)).toBe(false);
    expect(isAllowlisted("src/generated/prisma/index.ts", allowlist)).toBe(false);
    expect(isAllowlisted("random/file.ts", allowlist)).toBe(false);
    expect(isAllowlisted("package.json", allowlist)).toBe(false);
  });

  it("excludes the private deployment overlay paths (mirrors .gitignore)", () => {
    expect(isAllowlisted("config/club.json", allowlist)).toBe(false);
    expect(isAllowlisted("config/diagnostics-knowledge.json", allowlist)).toBe(
      false,
    );
    expect(isAllowlisted("seeds/tokoroa/members.json", allowlist)).toBe(false);
    expect(isAllowlisted("public/branding/logo.png", allowlist)).toBe(false);
  });
});

describe("overlay contract", () => {
  it("lets a deployment widen the allowlist to its own source", () => {
    const widened = resolveAllowlist({
      include: [...OPTIONAL_SOURCE_INCLUDE_GLOBS],
    });
    expect(isAllowlisted("src/lib/auth.ts", widened)).toBe(true);
    // A test file inside src stays excluded — default excludes still apply.
    expect(isAllowlisted("src/lib/__tests__/auth.test.ts", widened)).toBe(false);
  });

  it("can NEVER re-include a HARD_EXCLUDE path, even if the overlay tries", () => {
    // Overlay maliciously/mistakenly tries to include env + private overlay.
    const attacker = resolveAllowlist({
      include: ["**/*", ".env", "config/club.json", "seeds/**"],
    });
    expect(isAllowlisted(".env", attacker)).toBe(false);
    expect(isAllowlisted(".env.production", attacker)).toBe(false);
    expect(isAllowlisted("config/club.json", attacker)).toBe(false);
    expect(isAllowlisted("seeds/tokoroa/x.json", attacker)).toBe(false);
    expect(isAllowlisted("src/generated/prisma/index.ts", attacker)).toBe(false);
    expect(isAllowlisted("id_rsa", attacker)).toBe(false);
  });

  it("default include set is a stable, reviewable list", () => {
    expect(DEFAULT_INCLUDE_GLOBS).toContain("docs/**/*.md");
    expect(DEFAULT_INCLUDE_GLOBS).toContain("prisma/schema.prisma");
    expect(DEFAULT_INCLUDE_GLOBS).not.toContain("src/**/*.ts");
  });
});
