import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

/**
 * The setup wizard's rail: states, the navigation frontier, and the redraw a
 * module toggle causes (epic #213, C5 / #220 — mockup 2).
 *
 * Everything here is driven through the product's own surfaces: the progress
 * transitions are the wizard's buttons, and the module flags move through
 * `PUT /api/admin/modules` (the same helper the Xero and internet-banking specs
 * use) because the modules editor is a different admin page and embedding its
 * toggles in the rail is C3's work, not this child's.
 *
 * RETRY IDEMPOTENCY (#2302): every attempt starts by RESETTING setup progress,
 * because these journeys complete and defer steps permanently. Without it, an
 * attempt that deferred the first step leaves the next attempt resuming
 * somewhere else, and the reported failure is the pollution rather than the
 * cause. The same reset runs in `afterAll`, so the suite's other specs see the
 * state they started with.
 */

test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

async function resetSetupProgress(request: APIRequestContext) {
  const response = await request.patch("/api/admin/setup/progress", {
    data: { action: "reset" },
  });
  expect(
    response.ok(),
    `PATCH /api/admin/setup/progress reset (${response.status()})`,
  ).toBeTruthy();
}

interface WizardTraversal {
  applicableStepIds: string[];
  currentStepId: string | null;
  navigationFrontierStepId: string | null;
  percentComplete: number;
  steps: { id: string; state: string; isReachable: boolean }[];
}

async function readTraversal(request: APIRequestContext): Promise<WizardTraversal> {
  const response = await request.get("/api/admin/setup/wizard");
  expect(response.ok(), `GET /api/admin/setup/wizard (${response.status()})`).toBeTruthy();
  const body = (await response.json()) as { traversal: WizardTraversal };
  return body.traversal;
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  await resetSetupProgress(adminContext.request);
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      await resetSetupProgress(adminContext.request);
      if (previousModules) {
        await setModuleSettings(adminContext.request, previousModules);
      }
    }
  } finally {
    await adminContext?.close();
  }
});

test("the rail carries the journey, and the frontier stops a jump ahead", async () => {
  const page = await adminContext.newPage();

  // The launcher on `/admin/setup` is the entry point, and it is there in BOTH
  // positions of the legacy-surfaces switch (#223): with the surfaces shown it
  // sits above the readiness cards, with them hidden it is most of what the
  // page offers. This suite runs against a default club, so: shown.
  await page.goto("/admin/setup");
  await page.getByRole("link", { name: /Open the setup wizard/i }).click();
  await expect(page).toHaveURL(/\/admin\/setup\/wizard$/);

  const traversal = await readTraversal(adminContext.request);
  const current = traversal.currentStepId;
  expect(current, "a fresh club has an outstanding step").not.toBeNull();

  // The summary reads as a percentage (D7), and it is the traversal's.
  await expect(page.getByTestId("setup-wizard-percent")).toHaveText(
    `${traversal.percentComplete}%`,
  );

  // Every applicable step has a row, under a category heading.
  for (const id of traversal.applicableStepIds) {
    await expect(page.getByTestId(`setup-wizard-rail-row-${id}`)).toBeAttached();
  }
  // The category headings the rail groups under. `.first()` because the step
  // frame states the current step's category too, and both are the same word.
  await expect(page.getByText("Foundation", { exact: true }).first()).toBeVisible();

  // The wizard opens ON the current step, with its row in view rather than
  // somewhere below the fold.
  await expect(page.getByTestId("setup-wizard-step-frame")).toHaveAttribute(
    "data-step-id",
    String(current),
  );
  await expect(page.getByTestId(`setup-wizard-rail-row-${current}`)).toBeInViewport();

  // The launch panel is locked while anything blocks (D9).
  await expect(page.getByTestId("setup-wizard-rail-row-launch")).toHaveAttribute(
    "data-reachable",
    "false",
  );

  // D2: a step past the frontier is not navigable — the row is not a control at
  // all, so clicking where it sits changes nothing.
  //
  // The target is derived rather than assumed: `steps.find(not reachable)`
  // would have been satisfied by a row BEHIND the resume point, which is not
  // what "past the frontier" means, and `unreachable!` would have thrown a bare
  // TypeError on a seed where every step is reachable. A stack seeded far enough
  // to leave nothing locked is a legitimate seed, not a failure — so this skips
  // with a reason instead, and says which seed it wanted.
  const resumeIndex = traversal.steps.findIndex((step) => step.id === current);
  const locked = traversal.steps
    .slice(resumeIndex + 1)
    .find((step) => !step.isReachable);
  if (!locked) {
    await page.close();
    test.skip(
      true,
      "this stack's seed leaves no step behind the frontier after the resume point, so there is no jump-ahead to refuse",
    );
    return;
  }

  const lockedRow = page.getByTestId(`setup-wizard-rail-row-${locked.id}`);
  await expect(lockedRow).toHaveAttribute("data-reachable", "false");
  await lockedRow.click({ force: true });
  await expect(page.getByTestId("setup-wizard-step-frame")).toHaveAttribute(
    "data-step-id",
    String(current),
  );

  await page.close();
});

test("skipping a step buys passage and leaves it visibly outstanding (D4)", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");

  const before = await readTraversal(adminContext.request);
  const current = String(before.currentStepId);
  const resumeIndex = before.applicableStepIds.indexOf(current);
  const reachability = new Map(before.steps.map((step) => [step.id, step.isReachable]));

  // The skip target is derived, not assumed: the first APPLICABLE step after
  // the resume point that the PRE-READ traversal reports as blocked — never
  // simply index+1. A CI seed can leave the immediately-next applicable step
  // already complete on its own merits (e.g. age-tiers passes its own
  // readiness check independently of where the resume point sits), so
  // asserting data-reachable="false" on literally-the-next step fails there
  // even though a skip still buys real passage further along the rail.
  //
  // The post-skip assertion below then holds BY CONSTRUCTION, not by luck:
  // skipping the CURRENT blocking step advances the reachability frontier to
  // exactly the first step after it that this pre-read traversal found
  // blocked. Every step between `current` and that target was already
  // reachable (non-blocking, per the very isReachable read above) — so
  // skipping `current` changes nothing about any of them, and the derived
  // target is the one row whose reachability the skip actually flips.
  const nextId = before.applicableStepIds
    .slice(resumeIndex + 1)
    .find((id) => reachability.get(id) === false);

  // Same defensive read as above: nothing after the resume point is locked in
  // this seed, so there is no next step for a skip to unlock — a seed this
  // spec cannot exercise rather than a product failure.
  if (!nextId) {
    await page.close();
    test.skip(
      true,
      "nothing after the resume point is locked in this seed, so there is no next step for a skip to unlock",
    );
    return;
  }

  // Before: the next step is behind the frontier.
  await expect(page.getByTestId(`setup-wizard-rail-row-${nextId}`)).toHaveAttribute(
    "data-reachable",
    "false",
  );

  await page.getByRole("button", { name: /Skip for now/i }).click();

  // After: passage is bought — the next step is reachable — and the skipped one
  // is still on the rail, still stated as outstanding rather than hidden.
  await expect(page.getByTestId(`setup-wizard-rail-row-${nextId}`)).toHaveAttribute(
    "data-reachable",
    "true",
  );
  await expect(page.getByTestId(`setup-wizard-rail-row-${current}`)).toContainText(
    /skipped for now/i,
  );

  // And it can be taken back: reopening restores the frontier.
  await page.getByRole("button", { name: /^Reopen$/i }).click();
  await expect(page.getByTestId(`setup-wizard-rail-row-${nextId}`)).toHaveAttribute(
    "data-reachable",
    "false",
  );

  await page.close();
});

test("marking a step done advances the journey and the percentage", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/setup/wizard");

  const before = await readTraversal(adminContext.request);
  const current = String(before.currentStepId);

  await page.getByRole("button", { name: /Mark this step done/i }).click();

  await expect(page.getByTestId(`setup-wizard-rail-row-${current}`)).toHaveAttribute(
    "data-state",
    "complete",
  );
  const after = await readTraversal(adminContext.request);
  expect(after.percentComplete).toBeGreaterThan(before.percentComplete);
  await expect(page.getByTestId("setup-wizard-percent")).toHaveText(
    `${after.percentComplete}%`,
  );

  await page.close();
});

// Mockup 2, and the acceptance criterion in as many words: "WHEN a module is
// enabled or disabled, THE rail updates without a page reload." The mechanism
// is a refetch when the operator returns to the wizard tab — the modules editor
// is another page, so that is when the flags can have changed. Driven here with
// two real pages and `bringToFront`, which fires the browser's own
// visibilitychange, rather than with a synthetic event.
test("a module toggle redraws the rail without a page reload", async () => {
  const wizard = await adminContext.newPage();
  await wizard.goto("/admin/setup/wizard");

  // The client refetches on the window's real `focus` and `visibilitychange`
  // listeners (setup-wizard-client.tsx). In HEADLESS CI there is no window
  // manager, so `bringToFront()` delivers neither event and the refetch never
  // fires — measured on this suite's first CI run. Dispatching `focus` as a
  // DOM event exercises the identical listener → refetch → render path; only
  // the OS-level trigger is simulated, because headless Chromium cannot
  // produce one.
  const refocus = () => wizard.evaluate(() => window.dispatchEvent(new Event("focus")));

  // xeroIntegration is off in the E2E stack, so its two steps are absent (D4).
  await expect(wizard.getByTestId("setup-wizard-rail-row-xero-operational")).toHaveCount(0);

  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
  });

  await refocus();
  await expect(wizard.getByTestId("setup-wizard-rail-row-xero-operational")).toBeAttached();
  // No navigation happened: this is the same document the assertions above ran
  // against.
  await expect(wizard).toHaveURL(/\/admin\/setup\/wizard$/);

  // …and switching it back off removes them again.
  await setModuleSettings(adminContext.request, previousModules);
  previousModules = undefined;
  await refocus();
  await expect(wizard.getByTestId("setup-wizard-rail-row-xero-operational")).toHaveCount(0);

  await wizard.close();
});
