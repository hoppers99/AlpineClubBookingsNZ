import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalRelative = (value) => {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\\") || /[\0\r\n\t]/.test(value) || posix.normalize(value) !== value || value === ".." || value.startsWith("../")) fail(`non-canonical secret-scan path: ${value}`);
  return value;
};
const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const safeValue = (value) => {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return normalized === "" || /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(normalized) || /^(?:0|false|null|none|redacted|placeholder|changeme|example|dummy|fixture|measurement|localhost|<[^>]+>)$/i.test(normalized);
};

const PATTERNS = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, 0],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 0],
  ["sentry-dsn", /https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@[^\s/]*sentry(?:\.io)?\/[^\s"']+/gi, 0],
  ["bearer-token", /\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9._~+/=-]{12,})/gi, 1],
  ["postgres-credential", /postgres(?:ql)?:\/\/[^:\s/@]+:([^@\s/]+)@/gi, 1],
  ["sensitive-assignment", /\b(?:DATABASE_URL|AI_DIAGNOSTICS_DATABASE_URL|DB_PASSWORD|SEED_ADMIN_PASSWORD|SEED_LODGE_PASSWORD|CRON_SECRET|NEXTAUTH_SECRET|AUTH_SECRET|STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET)|AWS(?:_SES|_S3)?_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|EMAIL_SERVER_PASSWORD|SMTP_PASSWORD|ADDY_API_(?:KEY|SECRET)|SENTRY_(?:AUTH_TOKEN|DSN)|NEXT_PUBLIC_SENTRY_DSN|LEGACY_DASHBOARD_EXPORT_TOKEN|MIRO(?:TALK)?_(?:JWT_KEY|MEETING_PASSWORD|MEETING_USERNAME|MEETING_PRESENTER)|XERO_(?:CLIENT_ID|CLIENT_SECRET|ENCRYPTION_KEY|WEBHOOK_KEY)|GOOGLE_(?:CLIENT_ID|CLIENT_SECRET)|BACKUP_(?:S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|ENCRYPTION_KEY|PASSWORD|CREDENTIALS?)|COOKIE_SECRET)\b\s*(?:=|:)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi, 1],
  ["credential-assignment", /["']?\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DSN)[A-Za-z0-9_]*)\b["']?\s*(?:=|:)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\$\{[^}\s]+\}|[^\s,;}]+)/gi, 2],
  ["sensitive-json", /["'](?:password|secret|token|dsn|api[_-]?key|access[_-]?key(?:[_-]?id)?|client[_-]?secret|encryption[_-]?key|webhook[_-]?key|private[_-]?key|cookie)["']\s*:\s*["']([^"']+)["']/gi, 1],
  ["sensitive-argument", /--(?:password|secret|token|api-key|client-secret)(?:=|\s+)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/gi, 1],
  ["stripe-secret", /\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{12,}\b/g, 0],
  ["cookie-value", /\b(?:cookie|set-cookie)\s*:\s*[^\r\n=;]+=(?!deleted\b)([^;\r\n]{12,})/gi, 1],
];

function decodedViews(bytes) {
  const result = [{ encoding: "utf8", text: bytes.toString("utf8") }];
  if (bytes.includes(0)) result.push({ encoding: "nul-stripped-utf8", text: bytes.toString("utf8").replaceAll("\0", "") });
  const nulEven = bytes.length > 2 && Array.from({ length: Math.min(bytes.length, 512) }, (_, index) => index).filter((index) => bytes[index] === 0 && index % 2 === 0).length;
  const nulOdd = bytes.length > 2 && Array.from({ length: Math.min(bytes.length, 512) }, (_, index) => index).filter((index) => bytes[index] === 0 && index % 2 === 1).length;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || nulOdd > 3) result.push({ encoding: "utf16le", text: bytes.toString("utf16le") });
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || nulEven > 3) {
    const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
    for (let index = 0; index < swapped.length; index += 2) { swapped[index] = bytes[index + 1]; swapped[index + 1] = bytes[index]; }
    result.push({ encoding: "utf16be", text: swapped.toString("utf16le") });
  }
  return result;
}

function walk(root, out) {
  const rootReal = realpathSync.native(root);
  const outFolded = fold(resolve(out));
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) fail(`secret scan rejects symbolic links/junctions: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && fold(resolve(path)) !== outFolded) files.push(relative(rootReal, path).split(sep).join("/"));
      else if (!entry.isFile()) fail(`secret scan encountered unsupported entry: ${path}`);
    }
  };
  visit(rootReal);
  return files.sort();
}

function manifestFiles(root, manifest) {
  const value = JSON.parse(readFileSync(manifest, "utf8"));
  if (value.schema_version !== 1 || !Array.isArray(value.entries) || !value.entries.length) fail("secret-scan manifest is invalid/empty");
  const files = [...value.entries.map((entry) => canonicalRelative(entry.path)), "postconditions.json"];
  if (new Set(files.map(fold)).size !== files.length) fail("secret-scan manifest contains duplicate paths");
  for (const [index, path] of files.entries()) {
    const absolute = join(root, ...path.split("/"));
    const bytes = readFileSync(absolute);
    const expected = index < value.entries.length ? value.entries[index] : { bytes: bytes.length, sha256: value.postconditions_sha256 };
    if (!statSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink() || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) fail(`secret-scan manifest binding failed: ${path}`);
  }
  return { files, manifestSha256: sha256(readFileSync(manifest)) };
}

export function scanEvidence({ root, out, manifest = null }) {
  const rootPath = realpathSync.native(resolve(root));
  const outPath = resolve(out);
  if (!(fold(outPath).startsWith(`${fold(rootPath)}${sep}`)) || dirname(outPath) !== rootPath) fail("secret-scan output must be a direct child of the evidence root");
  if (existsSync(outPath)) fail(`secret-scan output already exists: ${outPath}`);
  const selected = manifest ? manifestFiles(rootPath, resolve(manifest)) : { files: walk(rootPath, outPath), manifestSha256: null };
  const records = [];
  const findings = [];
  for (const path of selected.files) {
    const absolute = join(rootPath, ...path.split("/"));
    const bytes = readFileSync(absolute);
    records.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    for (const { encoding, text } of decodedViews(bytes)) {
      for (const [kind, pattern, group] of PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const candidate = match[group] ?? match[0];
          if (kind === "credential-assignment" && /_(?:COUNT|PATH|FILE|FILENAME|NAME|HASH|SHA(?:256)?|PRESENT|STATUS|ENABLED|EXP|EXPIRY|EXPIRATION|LENGTH|TYPE)$/i.test(match[1])) continue;
          if (safeValue(candidate)) continue;
          findings.push({ path, kind, encoding, offset: match.index });
        }
      }
    }
  }
  const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.path}|${finding.kind}|${finding.encoding}|${finding.offset}`, finding])).values()];
  const result = {
    schema_version: 2,
    mode: manifest ? "exact-manifest" : "exact-tree-before-output",
    raw_evidence_manifest_sha256: selected.manifestSha256,
    scanned_file_count: records.length,
    scanned_bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    files: records,
    findings: uniqueFindings,
    passed: uniqueFindings.length === 0,
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (!result.passed) fail(`potential secrets found in evidence (${uniqueFindings.map((finding) => `${finding.kind}:${finding.path}`).join(",")})`);
  return result;
}

export function verifySecretScan({ root, report, manifest = null, allowedLaterFiles = [] }) {
  const rootPath = realpathSync.native(resolve(root));
  if (report.schema_version !== 2 || !report.passed || !Array.isArray(report.files) || report.findings?.length !== 0 || report.scanned_file_count !== report.files.length) fail("secret-scan report did not pass");
  const selected = manifest ? manifestFiles(rootPath, resolve(manifest)) : { files: walk(rootPath, join(rootPath, "secret-scan.json")).filter((path) => !allowedLaterFiles.includes(path)), manifestSha256: null };
  if (report.mode !== (manifest ? "exact-manifest" : "exact-tree-before-output") || report.raw_evidence_manifest_sha256 !== selected.manifestSha256 || JSON.stringify(report.files.map((record) => record.path)) !== JSON.stringify(selected.files)) fail("secret-scan exact path census changed");
  let bytesTotal = 0;
  for (const record of report.files) {
    const absolute = join(rootPath, ...canonicalRelative(record.path).split("/"));
    const bytes = readFileSync(absolute);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail(`secret-scan file binding changed: ${record.path}`);
    bytesTotal += bytes.length;
  }
  if (bytesTotal !== report.scanned_bytes) fail("secret-scan byte census changed");
  return report;
}

if (import.meta.filename === process.argv[1]) {
  let root, out, manifest = null;
  if (process.argv[2]?.startsWith("--")) {
    const value = (name) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? null : process.argv[index + 1]; };
    root = value("root"); out = value("out"); manifest = value("manifest");
  } else [root, out] = process.argv.slice(2);
  if (!root || !out) fail("usage: scan-evidence-secrets.mjs <root> <out> OR --root <root> --out <out> [--manifest <raw-manifest>]");
  scanEvidence({ root, out, manifest });
}
