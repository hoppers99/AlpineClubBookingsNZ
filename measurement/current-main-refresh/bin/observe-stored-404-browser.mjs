import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const required = (name) => {
  const value = args.get(`--${name}`);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const baseUrl = required("base-url");
const route = required("route");
const out = resolve(required("out"));
const screenshot = resolve(required("screenshot"));
const complaints = [];
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      complaints.push({ type: message.type(), text: message.text() });
    }
  });
  const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: "networkidle" });
  if (!response || response.status() !== 404) {
    throw new Error(`stored-404 browser request returned ${response?.status() ?? "no response"}`);
  }
  const visibleText = (await page.locator("body").innerText()).trim();
  await page.screenshot({ path: screenshot, fullPage: true });
  writeFileSync(out, JSON.stringify({
    schema_version: 1,
    status: response.status(),
    url: page.url(),
    visible_text: visibleText,
    visible_character_count: visibleText.length,
    console_messages: complaints,
    screenshot,
  }, null, 2), { flag: "wx" });
} finally {
  await browser.close();
}
