import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const fail = (message) => { throw new Error(message); };
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--out") fail("usage: verify-database-isolation.mjs --input <counts-json> --out <new-json>");
const input = resolve(args[1]);
const out = resolve(args[3]);
if (!existsSync(input) || existsSync(out)) fail("database isolation input/output paths are invalid");
const value = JSON.parse(readFileSync(input, "utf8").trim());
const expectedKeys = ["schema_version", "forbidden_integration_credential_count", "xero_token_count", "club_module_settings_rows", "unsafe_club_module_settings_rows", "analytics_settings_rows", "unsafe_analytics_settings_rows"];
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort())) fail("database isolation audit has an invalid schema");
for (const key of expectedKeys.slice(1)) if (!Number.isInteger(value[key]) || value[key] < 0) fail(`database isolation audit has invalid ${key}`);
if (value.schema_version !== 1 || value.forbidden_integration_credential_count !== 0 || value.xero_token_count !== 0 || value.unsafe_club_module_settings_rows !== 0 || value.unsafe_analytics_settings_rows !== 0) fail("canonical database permits a live provider or enabled analytics/AI/Xero/Google module");
const result = { ...value, passed: true };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
