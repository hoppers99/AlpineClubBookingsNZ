/**
 * Prove the installed Chromium actually runs on this runner.
 *
 * This is what replaced `playwright install --with-deps` as the default path
 * (see `action.yml` for the measurement that motivated it). The apt install
 * existed to guarantee Chromium's system libraries were present; launching the
 * browser and rendering a page answers that question directly, about the exact
 * binary the suite is about to use, in about two seconds instead of nine
 * minutes.
 *
 * It deliberately does more than `browser.launch()`: a missing library most
 * often surfaces when the renderer process starts rather than when the browser
 * handle is created, so this opens a page and reads back something only a live
 * renderer can produce.
 *
 * Exit 0 means the browser is usable. Any throw exits non-zero, which the
 * workflow step reads as "fall back to installing system dependencies" — so a
 * false failure here costs nine minutes, never a red run, and a false PASS is
 * the thing to avoid. That is why the assertions below are about rendered
 * output rather than about the process merely having started.
 */
import { chromium } from "@playwright/test";

const TIMEOUT_MS = 60_000;

async function main() {
  const browser = await chromium.launch({ timeout: TIMEOUT_MS });
  try {
    const page = await browser.newPage();
    // A data URL, so the check never depends on the network or on the staging
    // stack being up — this step runs before the stack is prepared.
    await page.setContent("<title>launch-check</title><h1>ok</h1>", {
      timeout: TIMEOUT_MS,
    });

    const heading = await page.textContent("h1");
    if (heading !== "ok") {
      throw new Error(`Rendered heading was ${JSON.stringify(heading)}, expected "ok"`);
    }

    // Layout ran, so the renderer is genuinely alive rather than a blank
    // process that answered the DOM query from a parsed-but-unpainted tree.
    const width = await page.evaluate(
      () => document.querySelector("h1")?.getBoundingClientRect().width ?? 0,
    );
    if (!(width > 0)) {
      throw new Error(`Heading laid out with width ${width}, expected a positive width`);
    }

    console.log(`Chromium ${browser.version()} launched and rendered.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Chromium launch check failed:", error?.message ?? error);
  process.exit(1);
});
