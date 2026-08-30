import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

/**
 * Resuming the setup wizard, and the launch panel it ends at (epic #213, C5 /
 * #220 — mockups 6 and 7).
 *
 * Two things only a running stack can show: that leaving and coming back
 * RESUMES rather than restarts, and that D9's launch panel unlocks exactly when
 * the traversal says every applicable step is resolved.
 *
 * The journey is driven to that point through the product's own progress API
 * rather than through seventeen UI clicks — the transitions themselves are
 * covered by clicking in `setup-wizard-rail.spec.ts`, and what this spec is
 * about is the state at the end of them. RETRY IDEMPOTENCY (#2302): progress is
 * reset before each attempt and restored afterwards.
 */

test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;

interface WizardTraversal {
  applicableStepIds: string[];
  currentStepId: string | null;
  allResolved: boolean;
  steps: { id: string; state: string; isReachable: boolean; isDeferred: boolean }[];
  /**
   * D17 (#246). The walk below iterates `steps`, which since the split is the
   * OPERATOR half — so it skips fewer things, never sends an environment id at
   * the progress route's new 422, and still arrives at `allResolved`.
   */
  environmentFacts: { id: string; status: string; blocksLaunch: boolean }[];
  launchBlockedBy: string[];
}

async function resetSetupProgress(request: APIRequestContext) {
  const response = await request.patch("/api/admin/setup/progress", {
    data: { action: "reset" },
  });
  expect(response.ok(), `reset setup progress (${response.status()})`).toBeTruthy();
}

async function readTraversal(request: APIRequestContext): Promise<WizardTraversal> {
  const response = await request.get("/api/admin/setup/wizard");
  expect(response.ok(), `GET /api/admin/setup/wizard (${response.status()})`).toBeTruthy();
  const body = (await response.json()) as { traversal: WizardTraversal };
  return body.traversal;
}

async function progress(
  request: APIRequestContext,
  action: "complete" | "skip",
  stepId: string,
) {
  const response = await request.patch("/api/admin/setup/progress", {
    data: { action, stepId },
  });
  expect(response.ok(), `${action} ${stepId} (${response.status()})`).toBeTruthy();
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  await resetSetupProgress(adminContext.request);
});

test.afterAll(async () => {
  try {
    if (adminContext) await resetSetupProgress(adminContext.request);
  } finally {
    await adminContext?.close();
  }
});

test("reopening the wizard resumes where the operator got to", async () => {
  // Walk two steps in by COMPLETING them, reading the resume point back from
  // the product each time rather than assuming the first two ids in the
  // registry are outstanding — several checks pass on their own in a seeded
  // stack, and which ones is not this spec's business. Deferring deliberately
  // would NOT move the resume point (a deferred step is still not complete);
  // that rule is asserted in `setup-wizard-rail.spec.ts`.
  const first = String((await readTraversal(adminContext.request)).currentStepId);
  await progress(adminContext.request, "complete", first);
  const second = String((await readTraversal(adminContext.request)).currentStepId);
  expect(second).not.toBe(first);
  await progress(adminContext.request, "complete", second);

  const resumed = await readTraversal(adminContext.request);
  const third = String(resumed.currentStepId);
  expect(third).not.toBe(second);

  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");

  await expect(page.getByTestId("setup-wizard-step-frame")).toHaveAttribute(
    "data-step-id",
    third,
  );
  // The row is in view on arrival rather than below the fold — the rail scrolls
  // the resume point into view when the wizard opens.
  await expect(page.getByTestId(`setup-wizard-rail-row-${third}`)).toBeInViewport();
  // The finished steps stay reachable in both directions (D2, reading 1).
  await expect(page.getByTestId(`setup-wizard-rail-row-${first}`)).toHaveAttribute(
    "data-reachable",
    "true",
  );
  await expect(page.getByTestId(`setup-wizard-rail-row-${first}`)).toHaveAttribute(
    "data-state",
    "complete",
  );

  await page.close();
});

test("the launch panel unlocks once every step is resolved, and states what was skipped", async () => {
  const before = await readTraversal(adminContext.request);
  expect(before.allResolved).toBe(false);

  // Resolve everything the fastest legitimate way: defer whatever is still
  // outstanding. D4 keeps every one of them visible as outstanding, which is
  // exactly the state mockup 6 exists to describe.
  const outstanding = before.steps.filter((step) => step.state !== "complete");
  for (const step of outstanding) {
    await progress(adminContext.request, "skip", step.id);
  }

  const resolved = await readTraversal(adminContext.request);
  expect(resolved.allResolved).toBe(true);

  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");

  const launchRow = page.getByTestId("setup-wizard-rail-row-launch");
  await expect(launchRow).toHaveAttribute("data-reachable", "true");
  await launchRow.click();

  const panel = page.getByTestId("setup-wizard-launch-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: /Ready to open/i })).toBeVisible();

  // Mockup 6: a club that skipped things still opens, and is told what it
  // skipped rather than having it quietly dropped.
  const outstandingBox = page.getByTestId("setup-wizard-outstanding");
  await expect(outstandingBox).toBeVisible();
  await expect(outstandingBox).toContainText(/skipped for now/i);

  // D9's second lever is consume-only: it instructs and offers no control.
  const role = page.getByTestId("setup-wizard-environment-role");
  await expect(role).toBeVisible();
  await expect(role).toContainText(".env");
  await expect(role.getByRole("button")).toHaveCount(0);

  await page.close();
});

/*
  D17 (#246). The journey above resolved WITHOUT any environment fact being
  confirmed — which is the split working, and is why the walk skipped fewer
  steps than it used to. These two tests cover the other end of it.
*/
test("the environment facts are reported on their own panel, not walked", async () => {
  const traversal = await readTraversal(adminContext.request);
  expect(
    traversal.environmentFacts.length,
    "the registry declares environment facts",
  ).toBeGreaterThan(0);

  // Not in the journey at all — the assertion the whole child exists for.
  const journeyIds = traversal.steps.map((step) => step.id);
  for (const fact of traversal.environmentFacts) {
    expect(journeyIds).not.toContain(fact.id);
  }
  // …but still in the applicable set, because the readiness cards read that one.
  for (const fact of traversal.environmentFacts) {
    expect(traversal.applicableStepIds).toContain(fact.id);
  }

  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");
  await page.getByTestId("setup-wizard-rail-row-environment").click();

  const panel = page.getByTestId("setup-wizard-environment-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/not steps for you to complete/i);
  for (const fact of traversal.environmentFacts) {
    await expect(
      page.getByTestId(`setup-wizard-environment-row-${fact.id}`),
    ).toBeVisible();
  }

  await page.close();
});

test("the progress route refuses a transition on an environment fact", async () => {
  const traversal = await readTraversal(adminContext.request);
  const fact = traversal.environmentFacts[0];
  const response = await adminContext.request.patch(
    "/api/admin/setup/progress",
    { data: { action: "complete", stepId: fact.id } },
  );
  expect(
    response.status(),
    `completing "${fact.id}" should be refused, not accepted`,
  ).toBe(422);
});

test("reopening a step locks the launch panel again", async () => {
  const resolved = await readTraversal(adminContext.request);
  expect(resolved.allResolved).toBe(true);

  // Reopen a DEFERRED step, not merely the first id. Under D14 (#237) either
  // choice would in fact re-block the launch panel — a step reopened onto its
  // own passing readiness check is DEFAULTED, and a defaulted step is
  // unresolved (D15) — but the deferred one is still the right target, because
  // it is the state whose reopening this test is named for and the only one
  // guaranteed to exist here (the previous test skipped everything outstanding).
  // Before #237 the distinction was load-bearing rather than tidy: a step whose
  // check passed read as complete whatever the progress record said, so
  // reopening one resolved nothing and this test passed vacuously.
  const deferred = resolved.steps.find((step) => step.isDeferred);
  expect(deferred, "the previous test left deferred steps behind").toBeTruthy();
  const response = await adminContext.request.patch("/api/admin/setup/progress", {
    data: { action: "reopen", stepId: deferred!.id },
  });
  expect(response.ok()).toBeTruthy();

  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");
  await expect(page.getByTestId("setup-wizard-rail-row-launch")).toHaveAttribute(
    "data-reachable",
    "false",
  );
  await expect(page.getByTestId("setup-wizard-launch-panel")).toHaveCount(0);

  await page.close();
});
