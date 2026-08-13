import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("deployment image contracts", () => {
  it("lets production Compose use prebuilt app and migration images", () => {
    const compose = readRepoFile("docker-compose.yml");

    expect(compose).toContain(
      "image: ${APP_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-app:local}",
    );
    expect(compose).toContain(
      "image: ${MIGRATE_IMAGE:-${COMPOSE_PROJECT_NAME:-tacbookings}-migrate:local}",
    );
    expect(compose).toContain("target: builder");
  });

  it("publishes app and migration images to GHCR after CI passes", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("publish-ghcr-images:");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain(
      "APP_IMAGE: ${{ vars.GHCR_APP_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-app', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain(
      "MIGRATE_IMAGE: ${{ vars.GHCR_MIGRATE_IMAGE_REPOSITORY || format('ghcr.io/{0}/alpineclubbookingsnz-migrate', github.repository_owner) }}:${{ github.sha }}",
    );
    expect(workflow).toContain("uses: docker/build-push-action@v7");
    expect(workflow).toContain("target: builder");
  });

  it("pins scanner actions and images away from default branch refs", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain("SEMGREP_IMAGE: semgrep/semgrep:1.161.0");
    expect(workflow).toContain("ghcr.io/gitleaks/gitleaks:v8.28.0");
    expect(workflow).toContain("uses: aquasecurity/trivy-action@v0.36.0");
    expect(workflow).not.toMatch(/uses:\s+\S+@(master|main)\b/);
  });

  it("mounts scanner source checkouts read-only", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).toContain('-v "$PWD:/src:ro"');
    expect(workflow).toContain('-v "$RUNNER_TEMP/semgrep-output:/out"');
    expect(workflow).toContain('-v "$PWD:/repo:ro"');
    expect(workflow).toContain("${{ runner.temp }}/semgrep-output/semgrep-results.sarif");
  });

  // #2686. Each of the three gates below is a REQUIRED protected-branch check,
  // and each has a specific way of going quiet without going red — which is the
  // worst failure available to a security gate, because the checks list still
  // reads green. The assertions pin the exact shape that makes each one real.
  describe("required security gates (#2686)", () => {
    it("runs the repository's own Semgrep rules in the blocking gate, without dropping the registry packs", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      // The custom rules must be IN the blocking scan. Matched as the
      // backslash-continued argument line, because `--config .semgrep/rules`
      // also appears in the fixture-test step above it — so the plain substring
      // stayed green when the flag was deleted from the scan itself, which is
      // the only place that makes the rules blocking. Mutation-testing found it.
      expect(workflow).toMatch(/^ +--config \.semgrep\/rules \\$/m);
      // ...and the four registry packs must still be there beside them. Wiring
      // custom rules in by REPLACING the packs is the silent-coverage-loss the
      // issue's review focus names.
      expect(workflow).toContain("--config p/nextjs");
      expect(workflow).toContain("--config p/typescript");
      expect(workflow).toContain("--config p/javascript");
      expect(workflow).toContain("--config p/react");
      // The fixtures must run. A custom rule that has stopped matching anything
      // scans clean, which is indistinguishable from a rule that found nothing.
      expect(workflow).toContain(
        "semgrep --test --config .semgrep/rules .semgrep/tests",
      );
      // The fixtures are deliberate violations, so the scan must not read them.
      expect(workflow).toContain("--exclude .semgrep/tests");
      // `--error` is what turns a finding into a non-zero exit.
      expect(workflow).toContain("--error");
    });

    it("keeps the gitleaks gate on one pinned container, covering both the PR range and the full history", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");

      expect(workflow).toContain("name: Secret scan (gitleaks)");
      expect(workflow).toContain("GITLEAKS_IMAGE: ghcr.io/gitleaks/gitleaks:v8.28.0");
      // Both scopes. `--log-opts=--all` is the history scan the old
      // `gitleaks-full-repo` job never actually performed: the marketplace
      // action picks its range from the event and only scans everything on
      // workflow_dispatch/schedule, neither of which this workflow fires.
      expect(workflow).toContain("--log-opts=--all");
      expect(workflow).toContain('--log-opts="${PR_BASE_SHA}..${PR_HEAD_SHA}"');
      // Non-zero exit on a finding, and no secret echoed into a public log.
      expect(workflow).toContain("--exit-code=1");
      expect(workflow).toContain("--redact");
      // The action is no longer USED: it installed a DIFFERENT gitleaks (8.24.3
      // by default) than the pinned container, so the two jobs disagreed about
      // which tool was enforcing the gate. Matched on `uses:` rather than on the
      // bare name, because the job's own comment explains why it went.
      expect(workflow).not.toMatch(/uses:\s*gitleaks\/gitleaks-action/);
      // The SHAs reach the script through `env:`, not through `${{ }}` spliced
      // into the shell program.
      expect(workflow).toContain("PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}");
      expect(workflow).toContain("PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    });

    it("never puts the required secret-scan job behind a job-level event condition", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const job = workflow.slice(
        workflow.indexOf("  secret-scan:"),
        workflow.indexOf("  verify:"),
      );

      expect(job.length).toBeGreaterThan(0);
      // A required check that SKIPS produces no status, and branch protection
      // waits for a status that will never arrive — the branch becomes
      // unmergeable. The PR-range scan is therefore conditional at STEP level,
      // where a skip leaves the job (and so the check context) intact.
      expect(job).not.toMatch(/^ {4}if:/m);
      expect(job).toMatch(/^ {8}if: github\.event_name == 'pull_request'$/m);
    });

    it("names the Trivy gate for what it blocks and keeps it off the verify critical path", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const job = workflow.slice(
        workflow.indexOf("  docker-image-security:"),
        workflow.indexOf("  publish-ghcr-images:"),
      );

      expect(job).toContain("name: Image security gate (Trivy CRITICAL)");
      // CRITICAL blocks...
      expect(job).toContain(
        "name: Trivy CRITICAL gate (REQUIRED — a finding here blocks the merge)",
      );
      // ...HIGH does not, and must keep its escape hatch or it would start
      // blocking merges under a policy nobody agreed to.
      expect(job).toContain(
        "name: Trivy HIGH report (ADVISORY — never blocks the merge)",
      );
      // Anchored: the step's own comment quotes `continue-on-error: true` while
      // explaining why it must stay, so the plain substring survived deleting
      // the directive. Third instance of that defect in this block, all three
      // found by mutation-testing rather than by reading.
      expect(job).toMatch(/^ +continue-on-error: true$/m);
      // `needs: verify` here would put a REQUIRED image scan behind a ~17-minute
      // job, making it the new critical path for every merge.
      expect(job).not.toMatch(/needs:\s*\n\s*- verify/);
    });

    it("keeps the gitleaks config extending the default rule set", () => {
      const config = readRepoFile(".gitleaks.toml");

      // Without this, the config REPLACES the built-in rules with the empty set
      // this file declares, and every gitleaks job in CI passes unconditionally.
      // That is exactly what shipped before #2686.
      //
      // Anchored to the start of a line on purpose. `toContain("[extend]")`
      // passes on the COMMENT above the directive, which explains at length why
      // the directive must never be removed — so deleting the directive left
      // this test green when it was first written. Mutation-testing it is what
      // found that; the file's own prose was satisfying the guard.
      expect(config).toMatch(/^\[extend\]$/m);
      expect(config).toMatch(/^useDefault\s*=\s*true$/m);
      // Allowlists stay content-scoped: a global allowlist carrying `paths`
      // suppresses EVERYTHING under those paths in gitleaks 8.28.0, whatever
      // else the entry says.
      expect(config).not.toMatch(/^\s*paths\s*=/m);
    });

    it("releases only behind the renamed secret-scan gate", () => {
      const workflow = readRepoFile(".github/workflows/ci.yml");
      const publish = workflow.slice(workflow.indexOf("  publish-ghcr-images:"));

      expect(publish).toContain("- secret-scan");
      expect(publish).not.toContain("- gitleaks-full-repo");
    });
  });

  it("deploys the resolved commit SHA image references from the production script", () => {
    const deployScript = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deployScript).toContain(
      'GHCR_APP_IMAGE_REPOSITORY="${GHCR_APP_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-app}"',
    );
    expect(deployScript).toContain(
      'GHCR_MIGRATE_IMAGE_REPOSITORY="${GHCR_MIGRATE_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-migrate}"',
    );
    expect(deployScript).toContain(
      'APP_IMAGE="${GHCR_APP_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain(
      'MIGRATE_IMAGE="${GHCR_MIGRATE_IMAGE_REPOSITORY}:${RESOLVED_REF}"',
    );
    expect(deployScript).toContain('APP_IMAGE="$APP_IMAGE"');
    expect(deployScript).toContain('MIGRATE_IMAGE="$MIGRATE_IMAGE"');
    expect(deployScript).toContain("--internal-blue-green-deploy");
  });

  it("pulls supplied app and migration images instead of building locally", () => {
    const deploy = readRepoFile("scripts/run-production-blue-green-deploy.sh");

    expect(deploy).toContain('APP_IMAGE="${APP_IMAGE:-}"');
    expect(deploy).toContain('MIGRATE_IMAGE="${MIGRATE_IMAGE:-}"');
    expect(deploy).toContain("validate_image_reference_contract");
    expect(deploy).toContain(
      'docker compose pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
    expect(deploy).toContain(
      'docker compose build --pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"',
    );
  });

  it("copies standalone static assets without nesting static/static", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/standalone ./",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/.next/static/ ./.next/static/",
    );
    expect(dockerfile).not.toMatch(
      /^COPY --from=builder \/app\/\.next\/static \.\/\.next\/static$/m,
    );
  });
});
