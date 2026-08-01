import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Provide fake email-delivery env so the delivery-config gate is satisfied
    // in tests (nodemailer is mocked, so nothing is actually sent).
    setupFiles: ["./vitest.setup.ts"],
    // Never descend into agent git worktrees (.claude/worktrees/*): they hold
    // stale snapshots of the repo whose test files would otherwise be collected
    // and run against the main source via the "@" alias. e2e/ holds Playwright
    // specs that Vitest's default include pattern would otherwise collect.
    exclude: [...configDefaults.exclude, "**/.claude/**", "e2e/**"],
    sequence: {
      // Load-bearing for the frozen test clock (#2481), not a style preference.
      // "stack" runs `beforeAll`/`beforeEach` in definition order, so the setup
      // file's freeze installs FIRST and any suite that pins its own instant
      // with `vi.setSystemTime` in its own hook still wins. `after*` hooks run
      // in reverse, so the setup file hands the clock back last. This is
      // currently Vitest's resolved default; pinned here so a future default
      // change cannot silently invert the override order.
      hooks: "stack",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
