import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_TOLERANCE } from "@/lib/deploy/warmup-evaluate";
import { WARMUP_VERDICT_SENTINEL } from "@/lib/deploy/warmup-report";

/**
 * The shell half of the pre-cutover warm-up gate (#2566).
 *
 * `scripts/run-production-blue-green-deploy.sh` cannot be executed here — it needs
 * a production host, Docker, and a live release — so its CONTRACT is asserted from
 * the source, which is the convention `deployment-image-contracts.test.ts` and
 * `calendar-diagnostic-script-contract.test.ts` already use for deploy and
 * diagnostic scripts. Each case names the property that would be a production
 * incident if it silently changed.
 */

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const script = readRepoFile("scripts/run-production-blue-green-deploy.sh");

describe("pre-cutover warm-up gate: deploy script contract", () => {
  it("runs the gate AFTER both web instances are healthy and BEFORE the Caddy switch", () => {
    const cronLeaderStep = script.indexOf(
      'step "15/20" "Refreshing cron leader on the new release before cutover"',
    );
    const warmupStep = script.indexOf(
      'step "16/20" "Warming the new release and verifying its page cache before cutover"',
    );
    const switchStep = script.indexOf(
      'step "17/20" "Switching Caddy upstream to target web service"',
    );
    const upstreamWrite = script.indexOf(
      'write_active_upstream_file "$TARGET_SERVICE" "$CRON_SERVICE"\nif ! reload_caddy',
    );

    expect(cronLeaderStep).toBeGreaterThan(0);
    expect(warmupStep).toBeGreaterThan(cronLeaderStep);
    expect(switchStep).toBeGreaterThan(warmupStep);
    expect(upstreamWrite).toBeGreaterThan(warmupStep);
    // The gate is invoked, not merely defined.
    expect(script.slice(warmupStep, switchStep)).toContain("run_warmup_gate");
  });

  it("keeps every step numbered out of twenty, so the runbook's references hold", () => {
    const stepNumbers = [...script.matchAll(/step "(\d+)\/20"/g)].map((match) =>
      Number(match[1]),
    );

    expect(stepNumbers).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(script).not.toMatch(/step "\d+\/19"/);
  });

  it("reads the verdict through the same sentinel the report renders", () => {
    expect(script).toContain(
      `DEPLOY_WARMUP_VERDICT_SENTINEL="${WARMUP_VERDICT_SENTINEL}"`,
    );
    expect(script).toContain('grep -F "${DEPLOY_WARMUP_VERDICT_SENTINEL}:"');
  });

  it("asks the endpoint the application actually serves", () => {
    expect(script).toContain('DEPLOY_WARMUP_PATH="/api/deploy/warmup"');
    // The route file has to exist at the matching location, or the gate 404s at
    // 2am rather than in CI.
    expect(() =>
      readRepoFile("src/app/api/deploy/warmup/route.ts"),
    ).not.toThrow();
  });

  it("refuses the cutover on a blocked verdict and on an unreadable one", () => {
    const gate = script.slice(
      script.indexOf("run_warmup_gate_for_service() {"),
      script.indexOf("run_warmup_gate() {"),
    );

    expect(gate).toContain("BLOCKED the cutover");
    expect(gate).toContain("no readable verdict");
    // Three refusals: unreadable response, blocked verdict, unrecognised verdict.
    expect(gate.match(/return 1/g)?.length).toBeGreaterThanOrEqual(3);
    // And a tolerated non-critical failure is a WARNING that still cuts over.
    expect(gate).toContain("pass-with-warning)");
    expect(gate).toContain("follow-up issue");
  });

  it("sends the warm-up requests to the target's own loopback, never the public domain", () => {
    expect(script).toContain(
      'url="http://127.0.0.1:3000${DEPLOY_WARMUP_PATH}?format=text"',
    );
    const gate = script.slice(script.indexOf("warmup_gate_url() {"));
    expect(gate).not.toContain("https://${domain}");
  });

  it("keeps the deploy secret inside the container", () => {
    // The secret is read from the app's own environment by the container's shell,
    // so it never appears in a host process list — the same concern
    // `curl_with_cron_secret_header` addresses for the external check. Only the URL
    // and the timeout are passed in.
    expect(script).toContain(
      `/bin/sh -lc 'wget -O - -T "$WARMUP_GATE_TIMEOUT" --header="x-cron-secret: $CRON_SECRET" "$WARMUP_GATE_URL"'`,
    );
    expect(script).not.toMatch(/-e "?CRON_SECRET=/);
  });

  it("warms every instance that can serve public traffic, target and fallback alike", () => {
    expect(script).toContain('resolved="$TARGET_SERVICE $CRON_SERVICE"');
    expect(script).toContain(
      "DEPLOY_WARMUP_SERVICES may only name app services",
    );
  });

  it("refuses an empty service list instead of cutting over having warmed nothing", () => {
    // `[ -n "$DEPLOY_WARMUP_SERVICES" ]` is true for a whitespace-only value, which
    // word-split to nothing: both loops iterated zero times, the gate returned success,
    // and the deploy cut over without asking the release a single question. It is the
    // only path where this gate could report a pass having proved nothing.
    expect(script).toContain("DEPLOY_WARMUP_SERVICES resolved to no services");

    // Resolved into a variable FIRST at both call sites, because `for x in $(f)`
    // discards f's exit status and would swallow that refusal.
    expect(script).not.toContain("for service in $(warmup_services); do");
    expect(
      script.match(/services="\$\(warmup_services\)" \|\| return 1/g)?.length,
    ).toBe(2);
  });

  it("checks every warm-up setting against the range the endpoint enforces", () => {
    // The endpoint answers 400 with the offending parameter named, and busybox `wget`
    // discards a non-2xx body — so an out-of-range setting used to block the deploy
    // with "the gate could not be read", pointing the operator at the container
    // instead of at the number they typed. The runbook's own advice to "lower the
    // timeout and the concurrency" reached that state.
    const validate = script.slice(
      script.indexOf("validate_warmup_settings() {"),
      script.indexOf("# Every web instance that can serve public traffic"),
    );

    expect(validate).toContain(
      "require_integer_setting_in_range DEPLOY_WARMUP_CONCURRENCY \"$DEPLOY_WARMUP_CONCURRENCY\" 1 8 || return 1",
    );
    expect(validate).toContain(
      'require_integer_setting_in_range DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS "$DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS" 1 120 || return 1',
    );
    expect(validate).toContain(
      'require_integer_setting_in_range DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS "$DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS" 5 1800 || return 1',
    );
    expect(validate).toContain(
      'require_integer_setting_in_range DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES "$DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES" 0 100 || return 1',
    );
    expect(validate).toContain(
      'require_integer_setting_in_range DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT "$DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT" 0 100 || return 1',
    );
  });

  it("labels a deploy that completed with a warning, after the logs rather than before", () => {
    // The owner's decision: "clearly label the deployment as completed with a warning"
    // and "ensure the failure is visible to the operator completing the deployment".
    // Printing it once at step 16 of 20 did neither — four steps, a container table and
    // 80 lines of application logs scroll past, and there is no log file.
    expect(script).toContain(
      'warn "Blue/green deploy complete WITH WARNINGS. See the summary below."',
    );
    expect(script).toContain("DEPLOY COMPLETED WITH WARNINGS");

    const logs = script.indexOf('docker compose logs "$TARGET_SERVICE" --tail 80');
    const summary = script.indexOf("print_deploy_warning_summary || true");
    expect(logs).toBeGreaterThan(0);
    expect(summary).toBeGreaterThan(logs);

    // Every tolerated outcome is accumulated, not just the tolerated page failure.
    const gate = script.slice(
      script.indexOf("run_warmup_gate_for_service() {"),
      script.indexOf("get_active_service() {"),
    );
    expect(gate.match(/record_warmup_warning /g)?.length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it("ships the owner's conservative tolerance as the default", () => {
    expect(script).toContain(
      `DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES="\${DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES:-${DEFAULT_WARMUP_TOLERANCE.maxFailedCmsRoutes}}"`,
    );
    expect(script).toContain(
      `DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT="\${DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT:-${DEFAULT_WARMUP_TOLERANCE.maxFailedCmsPercent}}"`,
    );
    expect(script).toContain(
      'DEPLOY_WARMUP_CONCURRENCY="${DEPLOY_WARMUP_CONCURRENCY:-3}"',
    );
    expect(script).toContain("validate_warmup_settings || return 1");
    expect(script).toContain("require_integer_setting_in_range");
  });

  it("makes disabling the gate impossible without a written reason", () => {
    expect(script).toContain(
      'DEPLOY_WARMUP_ENABLED="${DEPLOY_WARMUP_ENABLED:-1}"',
    );
    expect(script).toContain(
      'if [ -z "$DEPLOY_WARMUP_OVERRIDE_REASON" ]; then',
    );
    expect(script).toContain(
      "PRE-CUTOVER WARM-UP GATE DISABLED for this deploy.",
    );
  });

  it("does not weaken any gate that already existed", () => {
    // The #2560 windowed-migration handling, the migration validator, and both
    // health checks stay exactly where they were.
    expect(script).toContain("validate_pending_migrations_blue_green_safe");
    expect(script).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
    expect(script).toContain("BLUE_GREEN_MIGRATION_OVERRIDE_REASON");
    expect(script).toContain('verify_internal_health "$TARGET_SERVICE"');
    expect(script).toContain('verify_external_health "$TARGET_SERVICE"');
    expect(script).toContain("verify_cron_registration");
    expect(script).toContain("validate_prisma_schema_matches_migrations");
  });
});
