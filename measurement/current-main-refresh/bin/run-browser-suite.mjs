import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import axe from "axe-core";
import { validateLocalAuthState, validateLocalOrigin } from "../lib/local-auth-state.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const required = (name) => {
  const value = args.get(`--${name}`); if (!value) throw new Error(`--${name} is required`); return value;
};
const baseUrl = required("base-url");
const publicOrigin = required("public-origin");
validateLocalOrigin(baseUrl, "base URL", "http://127.0.0.1:8027");
validateLocalOrigin(publicOrigin, "public origin");
if (!new Set([baseUrl, "http://localhost:8027"]).has(publicOrigin)) throw new Error("public origin is outside the exact measurement listener");
const authState = validateLocalAuthState(required("auth-state")).path;
const outDir = resolve(required("out-dir"));
const out = resolve(required("out"));
const runId = required("run-id");
const canonicalContractPath = resolve(required("canonical-contract"));
const canonicalContractBody = readFileSync(canonicalContractPath);
const canonicalContract = JSON.parse(canonicalContractBody.toString("utf8"));
const canonicalExpectations = new Map(canonicalContract?.routes?.map((row) => [row.route, row.expectation]));
if (canonicalContract?.schema_version !== 1 || canonicalExpectations.size !== 5 || canonicalContract.routes.some((row) => row?.expectation?.kind !== "absent" || row.expectation.count !== 0)) throw new Error("canonical metadata contract is invalid");
const applicantEmail = `issue2352.${runId}@applicant.invalid`;
const complaints = [];
const browser = await chromium.launch();
const allowedOrigins = new Set([baseUrl, publicOrigin]);
const newLocalContext = async (options = {}) => {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    let origin;
    try { origin = new URL(route.request().url()).origin; } catch { await route.abort("blockedbyclient"); return; }
    if (!allowedOrigins.has(origin)) { await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  return context;
};
const routeRecords = [];
const a11yRecords = [];
const screenshotName = (path) => path === "/" ? "root" : path.slice(1).replace(/[^A-Za-z0-9._-]/g, "_");
const watchPage = (page, route) => {
  page.on("console", (message) => {
    const text = message.text();
    if (["error", "warning"].includes(message.type()) && /(content security policy|refused to (execute|load)|hydrat)/i.test(text)) {
      complaints.push({ route, source: "console", type: message.type(), text });
    }
  });
  page.on("pageerror", (error) => complaints.push({ route, source: "pageerror", type: "error", text: error.message }));
};
const metadata = async (page) => page.evaluate(() => ({
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
  og_title: document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "",
  og_description: document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? "",
  robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "",
  canonicals: [...document.querySelectorAll('link[rel="canonical"]')].map((link) => link.href),
  h1_count: document.querySelectorAll("h1").length,
  main_count: document.querySelectorAll("main").length,
  lang: document.documentElement.lang,
})) ;
const runAxe = async (page, route) => {
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () => {
    const results = await globalThis.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  });
  a11yRecords.push({ route, violations });
  if (violations.length) throw new Error(`${route} has serious/critical axe violations: ${violations.map((v) => v.id).join(",")}`);
};

try {
  const anonymous = await newLocalContext();
  await anonymous.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const coreRoutes = ["/", "/about", "/join", "/contact", "/join/apply"];
  for (const route of coreRoutes) {
    const page = await anonymous.newPage(); watchPage(page, route);
    const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: "networkidle" });
    if (!response || response.status() !== 200) throw new Error(`${route} returned ${response?.status() ?? "no response"}`);
    const head = await metadata(page);
    if (!head.title || !head.description || !head.og_title || !head.og_description || head.lang !== "en" || head.h1_count < 1 || head.main_count !== 1) {
      throw new Error(`${route} metadata/document landmarks are incomplete: ${JSON.stringify(head)}`);
    }
    for (const href of ["/", "/join", "/contact"]) {
      if (await page.locator(`a[href="${href}"]`).count() === 0) throw new Error(`${route} navigation omits ${href}`);
    }
    await runAxe(page, route);
    await page.screenshot({ path: resolve(outDir, `${screenshotName(route)}.png`), fullPage: true });
    routeRecords.push({ route, status: response.status(), url: page.url(), headers: await response.allHeaders(), metadata: head });
    await page.close();
  }

  for (const entry of [
    { route: "/hut-leader-instructions", statuses: [200] },
    { route: "/join/SOMECODE", statuses: [200, 404] },
    { route: "/join/verify/sometoken", statuses: [200, 404] },
    { route: "/login", statuses: [200] },
    { route: "/register", statuses: [200] },
    { route: "/display", statuses: [200] },
    { route: "/dashboard/nope", statuses: [200, 404] },
    { route: "/admin/typo", statuses: [404] },
    { route: "/hut-leader-instruction%73", statuses: [404] },
    { route: "/join/appl%79", statuses: [200, 404] },
  ]) {
    const page = await anonymous.newPage(); watchPage(page, entry.route);
    const response = await page.goto(new URL(entry.route, baseUrl).href, { waitUntil: "networkidle" });
    if (!response || !entry.statuses.includes(response.status())) throw new Error(`${entry.route} returned ${response?.status() ?? "no response"}`);
    routeRecords.push({ route: entry.route, status: response.status(), url: page.url(), headers: await response.allHeaders(), metadata: await metadata(page) });
    await page.close();
  }

  const presentation = await anonymous.newPage(); watchPage(presentation, "/about anonymous");
  await presentation.goto(new URL("/about", baseUrl).href, { waitUntil: "networkidle" });
  if (await presentation.getByRole("link", { name: "Log In" }).count() < 1 || await presentation.getByRole("link", { name: "Dashboard" }).count() !== 0) {
    throw new Error("anonymous stored-page presentation is wrong");
  }
  await presentation.close();

  const contact = await anonymous.newPage(); watchPage(contact, "/contact form");
  await contact.goto(new URL("/contact", baseUrl).href, { waitUntil: "networkidle" });
  await contact.getByRole("button", { name: "Send Message" }).click();
  if (await contact.locator("input:invalid,textarea:invalid").count() < 1) throw new Error("contact form did not enforce required validation");
  await contact.locator("#name").fill(`Issue 2352 ${runId}`);
  await contact.locator("#email").fill(`issue2352.${runId}@contact.invalid`);
  await contact.locator("#message").fill(`contact-form-submission-${runId}`);
  const contactResponsePromise = contact.waitForResponse((response) => response.url().endsWith("/api/contact") && response.request().method() === "POST");
  await contact.getByRole("button", { name: "Send Message" }).click();
  const contactResponse = await contactResponsePromise;
  if (contactResponse.status() !== 200) throw new Error(`contact submission returned ${contactResponse.status()}`);
  await contact.getByRole("heading", { name: "Message Sent" }).waitFor();
  await contact.screenshot({ path: resolve(outDir, "contact-submitted.png"), fullPage: true });
  await contact.close();

  const application = await anonymous.newPage(); watchPage(application, "/join/apply form");
  await application.goto(new URL("/join/apply", baseUrl).href, { waitUntil: "networkidle" });
  await application.getByRole("button", { name: "Submit membership application" }).click();
  await application.locator("#applicantFirstName-error").waitFor();
  await application.locator("#applicantFirstName").fill("Issue");
  await application.locator("#applicantLastName").fill(`Probe ${runId}`);
  await application.locator("#applicantEmail").fill(applicantEmail);
  await application.locator("#applicantDateOfBirth").fill("1990-02-02");
  await application.locator("#nominator1Email").fill("alice@demo.alpineclub.test");
  await application.locator("#nominator2Email").fill("nadia@demo.alpineclub.test");
  const applicationResponsePromise = application.waitForResponse((response) => response.url().endsWith("/api/applications") && response.request().method() === "POST");
  await application.getByRole("button", { name: "Submit membership application" }).click();
  const applicationResponse = await applicationResponsePromise;
  const applicationBody = await applicationResponse.json();
  if (applicationResponse.status() !== 201 || applicationBody?.status !== "PENDING_NOMINATORS" || typeof applicationBody?.applicationId !== "string" || (applicationBody.warnings ?? []).length) {
    throw new Error(`application submission failed: ${applicationResponse.status()} ${JSON.stringify(applicationBody)}`);
  }
  await application.getByRole("heading", { name: "Application submitted" }).waitFor();
  await application.screenshot({ path: resolve(outDir, "application-submitted.png"), fullPage: true });
  await application.close();
  await anonymous.tracing.stop({ path: resolve(outDir, "anonymous-trace.zip") });
  await anonymous.close();

  const authenticated = await newLocalContext({ storageState: authState });
  await authenticated.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const signedIn = await authenticated.newPage(); watchPage(signedIn, "/about authenticated");
  await signedIn.goto(new URL("/about", baseUrl).href, { waitUntil: "networkidle" });
  if (await signedIn.getByRole("link", { name: "Dashboard" }).count() < 1 || await signedIn.getByRole("link", { name: "Log In" }).count() !== 0) {
    throw new Error("authenticated marker presentation is wrong");
  }
  await signedIn.screenshot({ path: resolve(outDir, "authenticated-about.png"), fullPage: true });
  await signedIn.close();
  await authenticated.tracing.stop({ path: resolve(outDir, "authenticated-trace.zip") });
  await authenticated.close();

  const markerOnly = await newLocalContext();
  await markerOnly.addCookies([{ name: "signed-in-hint", value: "1", url: baseUrl }]);
  const markerPage = await markerOnly.newPage(); watchPage(markerPage, "marker-only");
  await markerPage.goto(new URL("/about", baseUrl).href, { waitUntil: "networkidle" });
  if (await markerPage.getByRole("link", { name: "Dashboard" }).count() < 1) throw new Error("marker-only presentation did not change");
  await markerPage.goto(new URL("/dashboard", baseUrl).href, { waitUntil: "networkidle" });
  if (!new URL(markerPage.url()).pathname.startsWith("/login")) throw new Error("marker-only visitor gained dashboard access");
  const adminApi = await markerOnly.request.get(new URL("/api/admin/page-content", baseUrl).href);
  if (![401, 403].includes(adminApi.status())) throw new Error(`marker-only visitor gained admin API access: ${adminApi.status()}`);
  await markerOnly.close();

  if (complaints.length) throw new Error(`CSP/hydration complaints: ${JSON.stringify(complaints)}`);
  const canonicalRecords = routeRecords.filter((record) => coreRoutes.includes(record.route)).map((record) => ({
    route: record.route,
    expected: canonicalExpectations.get(record.route),
    actual: record.metadata.canonicals,
  }));
  const canonicalContractSatisfied = canonicalRecords.every((record) => record.expected?.kind === "absent" && record.actual.length === record.expected.count);
  if (!canonicalContractSatisfied) throw new Error(`rendered canonical metadata violates the source-derived contract: ${JSON.stringify(canonicalRecords)}`);
  writeFileSync(out, JSON.stringify({
    schema_version: 1,
    run_id: runId,
    public_origin: publicOrigin,
    applicant_email: applicantEmail,
    application_id: applicationBody.applicationId,
    route_records: routeRecords,
    csp_hydration_complaints: complaints,
    accessibility: a11yRecords,
    forms: { contact_validation: true, contact_submission: true, application_validation: true, application_submission: true },
    marker_access: { anonymous_presentation: true, authenticated_presentation: true, marker_only_presentation: true, protected_redirect: true, admin_api_denied: true },
    canonical_records: canonicalRecords,
    canonical_contract: { sha256: createHash("sha256").update(canonicalContractBody).digest("hex"), satisfied: true },
  }, null, 2) + "\n", { flag: "wx" });
} finally {
  await browser.close();
}
