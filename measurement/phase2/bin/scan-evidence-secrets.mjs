import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const out = resolve(process.argv[3] ?? "");
if (!root || !out) throw new Error("usage: scan-evidence-secrets.mjs <evidence-root> <out-json>");
const files = [];
const visit = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
  const path = resolve(dir, entry.name);
  if (entry.isDirectory()) visit(path);
  else if (entry.isFile() && path !== out) files.push(path);
  else if (!entry.isFile()) throw new Error(`unsupported evidence entry: ${path}`);
});
visit(root);
const findings = [];
for (const path of files) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  const tests = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["assigned-secret", /\b(?:DB_PASSWORD|SEED_ADMIN_PASSWORD|NEXTAUTH_SECRET|AUTH_SECRET|STRIPE_SECRET_KEY)\s*=\s*([^\s"']+)/gi],
    ["postgres-credential", /postgres(?:ql)?:\/\/[^:\s]+:([^@\s]+)@/gi],
  ];
  for (const [kind, pattern] of tests) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      if (value.startsWith("${") || /replace|dummy|example|<.*>/i.test(value)) continue;
      findings.push({ path, kind, offset: match.index });
    }
  }
}
const result = { schema_version: 1, scanned_files: files.length, scanned_bytes: files.reduce((sum, path) => sum + statSync(path).size, 0), findings, passed: findings.length === 0 };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
if (findings.length) throw new Error(`potential secrets found in evidence: ${findings.map((finding) => `${finding.kind}:${finding.path}`).join(", ")}`);
