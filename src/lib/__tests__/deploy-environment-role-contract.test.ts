import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";

/**
 * The production-upgrade path for the environment declaration (ENV-SAFETY 1,
 * #3034; epic #2986; INV-CONFIG-003).
 *
 * THIS IS THE PART THE EPIC IS JUDGED ON. Before this release an installation
 * needed no declaration; after it, an installation without one resolves UNKNOWN
 * and fails closed. So the plain upgrade of an existing production install would,
 * left alone, succeed and then quietly stop sending mail to members — which
 * #2986 explicitly forbids shipping. The controlled path is that a production
 * deploy CANNOT COMPLETE without the declaration, so the failure is a loud
 * refusal BEFORE anything changes rather than a silent outage after.
 *
 * `scripts/run-production-blue-green-deploy.sh` cannot be executed here — it
 * needs a production host, Docker and a live release — so its CONTRACT is
 * asserted from the source, the convention
 * `deploy-warmup-gate-script-contract.test.ts` and
 * `deployment-image-contracts.test.ts` already use for deploy scripts.
 *
 * THE ORDER IS THE POINT, not the validator's mere existence. Measured on this
 * script:
 *
 *   step  3/20  validate_env_contract        <- the new declaration check
 *   step 12/20  schema vs committed migrations
 *   step 13/20  prisma migrate deploy        <- the table starts existing
 *   step 14/20  the target web service starts <- first new-code process boots
 *   step 15/20  cron leader recreated
 *   step 17/20  Caddy cutover                <- traffic moves
 *
 * That gives the chain in both directions. An undeclared production upgrade
 * aborts at step 3 with the old colour still serving, nothing migrated and
 * nothing switched. And no new-code process can boot against a database lacking
 * `EnvironmentSafetySettings`, because the migration is ten steps before the
 * first start. Move the env check after step 13 and an abort leaves the schema
 * already changed; move it after step 14 and the "silently suppresses live
 * service" outcome the epic forbids comes straight back. Hence the offsets below.
 *
 * `test:related` cannot select this file: it reads shell and YAML from disk, so
 * it has no import edge to any of them (`docs/TESTING.md`).
 */

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const script = readRepoFile("scripts/run-production-blue-green-deploy.sh");
const compose = readRepoFile("docker-compose.yml");
const stagingCompose = readRepoFile("docker-compose.staging.yml");
const envExample = readRepoFile(".env.example");
const stagingEnvExample = readRepoFile(".env.staging.example");
const instrumentation = readRepoFile("src/instrumentation.node.ts");

/**
 * The validator function's body, from its opening brace to its closing one.
 *
 * Extracted once because five cases below read it, and because slicing to the
 * NEXT top-level `}` is what keeps an assertion about this function from
 * accidentally passing on text from the function after it.
 */
function validatorBody(): string {
  const start = script.indexOf("require_environment_role_env_key() {");
  expect(start).toBeGreaterThan(0);
  const end = script.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

/** The offset of a `step "N/20" "…"` line, or -1. */
function stepOffset(number: number): number {
  const match = script.indexOf(`step "${number}/20"`);
  return match;
}

describe("the deploy refuses an undeclared production release", () => {
  it("requires the declaration in the .env contract", () => {
    expect(script).toContain("require_environment_role_env_key");
    // Defined AND invoked. A helper nothing calls is a comment.
    const definition = script.indexOf("require_environment_role_env_key() {");
    const contract = script.indexOf("validate_env_contract() {");
    const invocation = script.indexOf(
      "  require_environment_role_env_key\n",
      contract,
    );
    expect(definition).toBeGreaterThan(0);
    expect(contract).toBeGreaterThan(definition);
    expect(invocation).toBeGreaterThan(contract);
  });

  it("requires exactly `production`, because this script only ever deploys the live site", () => {
    /*
      THE NARROWEST AND MOST IMPORTANT ASSERTION IN THIS FILE (#3034 review).
      The application parser accepts `production` OR `non-production`; this
      script must accept only the first. It has no staging mode, no `--env`
      switch and no alternate path — a non-production stack goes through
      `docker-compose.staging.yml` and `scripts/e2e-stack.sh` — so a declaration
      saying "this is a copy" is the one value it can prove is wrong.

      And it is the likeliest operator error, not a theoretical one.
      `.env.example` ships `non-production` (correct there: a template shipping
      `production` would have a laptop declaring itself live), and `.env.example`
      is also the file an operator diffs against their real `.env` when
      upgrading. Copying the value across would pass a gate that accepted both,
      migrate, boot, resolve NON_PRODUCTION — and then suppress every real
      member's email and, once #3036 lands, rewrite the email addresses on the
      club's real Xero contacts. The safe-LOOKING value is the unsafe outcome
      here, and only here.
    */
    const body = validatorBody();

    // Case-folded after trimming, the same rule `readEnvironmentRoleDeclaration`
    // applies, so the gate and the app cannot disagree about what counts as set.
    expect(body).toContain("tr '[:upper:]' '[:lower:]'");

    // The condition is a SINGLE comparison against `production`. Not an
    // alternation that also admits `non-production` — that WAS the first draft,
    // and it is the hole this case exists to keep closed.
    expect(body).toContain('if [ "$normalised" != "production" ]; then');
    expect(body).not.toContain('!= "non-production"');

    // `non-production` may appear only inside the refusal, explaining itself —
    // never in the condition that decides whether to refuse.
    const condition = body.slice(0, body.indexOf("; then") + 6);
    expect(condition).not.toContain("non-production");

    // It FAILS rather than warns.
    expect(body).toContain("return 1");
    // And it names the trap: the other variable that looks like it answers this.
    expect(body).toContain("APP_RUNTIME_ROLE");
  });

  it("tells an operator who declared non-production what it would have done", () => {
    // A refusal that only says "must be production" invites the operator to
    // wonder whether the gate is being fussy. Naming the consequence — real
    // members' email suppressed, real Xero contact addresses rewritten — is what
    // makes it obvious the value is wrong rather than the check.
    const body = validatorBody();
    expect(body).toContain('if [ "$normalised" = "non-production" ]; then');

    const branch = body.slice(body.indexOf('= "non-production"'));
    expect(branch).toContain("COPY");
    expect(branch.toLowerCase()).toContain("real members");
    expect(branch.toLowerCase()).toContain("xero");
    // And it explains where the wrong value most likely came from.
    expect(branch).toContain(".env.example");
    expect(body).toContain("docs/guides/environment-role.md");
  });

  it("keeps the undeclared case explained differently from the wrong-value case", () => {
    // Two quite different mistakes reach this refusal and they need different
    // instructions: "you have not set it" versus "you set it to the value that
    // says this is a copy".
    const body = validatorBody();
    expect(body).toContain("resolves UNKNOWN");
    expect(body).toContain("Set APP_ENVIRONMENT_ROLE=production");
    // The absent case is caught by require_env_key, which fails on its own
    // before the value comparison — so an absent AND a wrong value both abort.
    expect(body).toContain('require_env_key "$key"');
  });

  it("points a non-production operator at the stack that is actually for them", () => {
    expect(validatorBody()).toContain("docker-compose.staging.yml");
  });

  it("names the variable the application actually reads", () => {
    // A gate demanding a variable nothing reads passes every deploy and protects
    // nothing, so the name comes from the module that parses it.
    expect(ENVIRONMENT_ROLE_ENV_VAR).toBe("APP_ENVIRONMENT_ROLE");
    const body = validatorBody();
    expect(body).toContain(`local key="${ENVIRONMENT_ROLE_ENV_VAR}"`);
  });

  it("runs the check at step 3, BEFORE the migration, the first boot and the cutover", () => {
    const envContract = stepOffset(3);
    const schemaCheck = stepOffset(12);
    const migrate = stepOffset(13);
    const targetStart = stepOffset(14);
    const cutover = stepOffset(17);

    for (const offset of [
      envContract,
      schemaCheck,
      migrate,
      targetStart,
      cutover,
    ]) {
      expect(offset).toBeGreaterThan(0);
    }

    // The env contract is invoked inside step 3's block, not merely defined
    // somewhere above it.
    expect(script.slice(envContract, schemaCheck)).toContain(
      "validate_env_contract",
    );

    expect(envContract).toBeLessThan(schemaCheck);
    expect(schemaCheck).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(targetStart);
    expect(targetStart).toBeLessThan(cutover);
  });

  it("applies the migration before the first new-code process starts", () => {
    // The other half of the chain: the table exists before anything reads it, so
    // the fail-closed "override unreadable" path cannot be reached by a correct
    // deploy of this release.
    const migrateStep = script.slice(stepOffset(13), stepOffset(14));
    expect(migrateStep).toContain('run --rm "$MIGRATE_SERVICE"');
    expect(migrateStep).toContain("verify_prisma_migration_status");
  });
});

describe("every service that runs the app is given the declaration", () => {
  it("passes it through the shared app-environment anchor", () => {
    expect(compose).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${${ENVIRONMENT_ROLE_ENV_VAR}}`,
    );
  });

  it("gives it NO default, because a default is the inference this epic removes", () => {
    /*
      `${APP_ENVIRONMENT_ROLE:-production}` would be wrong for every fork and
      every restored copy, in the direction that emails the club's real members
      from a test system. `:-non-production` would be wrong for the live site, in
      the direction that silently stops its mail. There is no defensible default,
      which is why the variable is required instead.
    */
    expect(compose).not.toContain(`\${${ENVIRONMENT_ROLE_ENV_VAR}:-`);
    expect(compose).not.toContain(`\${${ENVIRONMENT_ROLE_ENV_VAR}:?`);
  });

  it("reaches the cron leader and both web slots through that anchor", () => {
    // Each app service merges `<<: *app-environment`; only `migrate` does not,
    // and it runs `prisma migrate deploy` with no application code.
    const anchorUsers = [...compose.matchAll(/<<: \*app-environment/g)].length;
    expect(anchorUsers).toBe(3);
    for (const slot of ["cron-leader", "web-blue", "web-green"]) {
      expect(compose).toContain(`APP_RUNTIME_ROLE: ${slot}`);
    }
  });

  it("leaves the migrate service without it, and says why", () => {
    const migrateBlock = compose.slice(compose.indexOf("\n  migrate:"));
    expect(migrateBlock).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${${ENVIRONMENT_ROLE_ENV_VAR}}`,
    );
    // Absent on purpose is only distinguishable from forgotten if it says so.
    expect(migrateBlock).toContain("deliberately ABSENT");
  });
});

describe("non-production targets declare themselves", () => {
  it("hard-codes non-production on the staging app service", () => {
    expect(stagingCompose).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: non-production`,
    );
    // Hard-coded, NOT interpolated from the env file: a stray value there must
    // not be able to make the staging/E2E stack claim to be the live site.
    expect(stagingCompose).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${`,
    );
  });

  it("keeps the E2E and staging env template declared, so the suite never meets UNKNOWN", () => {
    expect(stagingEnvExample).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}=non-production`,
    );
  });

  it("ships the safe value in the local-development template", () => {
    expect(envExample).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=non-production`);
  });

  it("tells a production operator, in the template, that they must change it", () => {
    const start = envExample.indexOf("# Is this installation");
    expect(start).toBeGreaterThan(-1);
    const block = envExample.slice(start, envExample.indexOf("\n\n", start));
    expect(block).toContain("REQUIRED");
    expect(block).toContain("production | non-production");
    // The two things an operator gets wrong: assuming a default, and repairing
    // the neighbouring variable.
    expect(block).toContain("MUST set");
    expect(block).toContain("APP_RUNTIME_ROLE");
    expect(block).toContain("docs/guides/environment-role.md");
  });
});

describe("the boot advisory reaches the containers that serve traffic", () => {
  it("sits in the Node block that runs regardless of cron configuration", () => {
    /*
      The SECOND `NEXT_RUNTIME === "nodejs"` block returns early when
      CRON_ENABLED is false — which is exactly what app_blue and app_green set —
      so an advisory appended at the end of `register()` would never run on the
      web containers. Measured, not assumed: the offsets below are what pin it.
    */
    const advisory = instrumentation.indexOf(
      'const { resolveEnvironmentRole } = await import("./lib/environment-role")',
    );
    const cronBlock = instrumentation.indexOf("const cronEnabled =");
    const earlyReturn = instrumentation.indexOf(
      "Cron scheduling disabled for this app instance",
    );

    expect(advisory).toBeGreaterThan(0);
    expect(cronBlock).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(cronBlock);
    expect(advisory).toBeLessThan(cronBlock);
  });

  it("logs at error level only for UNKNOWN, and never blocks startup", () => {
    const advisory = instrumentation.indexOf(
      'const { resolveEnvironmentRole } = await import("./lib/environment-role")',
    );
    const block = instrumentation.slice(advisory - 400, advisory + 1600);
    expect(block).toContain('resolution.role === "UNKNOWN"');
    expect(block).toContain("logger.error");
    // Its own try/catch — a configuration advisory that stops the site coming up
    // would be a worse fault than the one it reports.
    expect(block).toContain("} catch {");
    /*
      And it does NOT hard-code an instruction to set the variable. That reads
      like a missing assertion and is the fix: an UNKNOWN caused by an unreadable
      override has a perfectly correct APP_ENVIRONMENT_ROLE, and telling that
      operator to set it sends them to repair the one thing that is already
      right. The per-case instruction comes from `resolution.notes`, asserted in
      the case above; the notes' own content is asserted in
      environment-role-precedence.test.ts.
    */
    const sentence = block.slice(block.indexOf("logger.error"));
    expect(sentence).not.toContain(`Set ${ENVIRONMENT_ROLE_ENV_VAR}`);
    expect(sentence).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR} does not say`,
    );
  });
});
