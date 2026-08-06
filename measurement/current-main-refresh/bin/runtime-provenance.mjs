import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const canonicalDirectory = (input, label) => {
  const path = resolve(input); const stat = lstatSync(path); const real = realpathSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(path, real)) throw new Error(`${label} is not a canonical directory`);
  return path;
};
const canonicalFile = (input, label) => {
  const path = resolve(input); const stat = lstatSync(path); const real = realpathSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(path, real)) throw new Error(`${label} is not a canonical regular file`);
  return { path, size_bytes: stat.size };
};
const assertExactPath = (actual, expected, label) => {
  if (!samePath(resolve(actual ?? ""), resolve(expected))) throw new Error(`${label} is not the exact installed worktree path`);
};
const sha256 = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const described = async (input, label) => {
  const value = canonicalFile(input, label);
  return { ...value, sha256: await sha256(value.path) };
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export async function captureRuntimeProvenance(inputRoot) {
  if (!isAbsolute(inputRoot)) throw new Error("runtime root must be absolute");
  const root = canonicalDirectory(inputRoot, "runtime root");
  const worktree = canonicalDirectory(process.cwd(), "producer worktree");
  if (!samePath(root, worktree)) throw new Error("runtime root must be the actual producer worktree");

  const packageManifest = await described(join(root, "package.json"), "root package manifest");
  const packageLock = await described(join(root, "package-lock.json"), "root package lock");
  const nodeModulesRoot = canonicalDirectory(join(root, "node_modules"), "worktree node_modules");
  const installedLock = await described(join(root, "node_modules", ".package-lock.json"), "installed package lock");
  assertExactPath(packageManifest.path, join(root, "package.json"), "root package manifest");
  assertExactPath(packageLock.path, join(root, "package-lock.json"), "root package lock");
  assertExactPath(nodeModulesRoot, join(root, "node_modules"), "worktree node_modules");
  assertExactPath(installedLock.path, join(root, "node_modules", ".package-lock.json"), "installed package lock");

  const manifestDocument = json(packageManifest.path);
  const lockDocument = json(packageLock.path);
  const installedLockDocument = json(installedLock.path);
  if (lockDocument?.lockfileVersion !== 3 || installedLockDocument?.lockfileVersion !== 3) throw new Error("root and installed package locks must both use lockfileVersion 3");
  if (lockDocument?.packages?.[""]?.name !== manifestDocument?.name || lockDocument?.packages?.[""]?.version !== manifestDocument?.version) throw new Error("root package manifest and lock identity differ");
  const nodeRange = /^>=(\d+)\.0\.0 <(\d+)$/.exec(manifestDocument?.engines?.node ?? "");
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!nodeRange || nodeMajor < Number(nodeRange[1]) || nodeMajor >= Number(nodeRange[2])) throw new Error(`Node ${process.version} is outside the root package engine contract`);

  const requireFromRoot = createRequire(packageManifest.path);
  const packages = {};
  for (const name of ["@playwright/test", "playwright", "playwright-core", "axe-core"]) {
    const expectedPackageJson = join(root, "node_modules", ...name.split("/"), "package.json");
    const packageJson = canonicalFile(expectedPackageJson, `${name} package manifest`);
    assertExactPath(packageJson.path, expectedPackageJson, `${name} package manifest`);
    const relativePackage = relative(nodeModulesRoot, packageJson.path);
    if (!relativePackage || relativePackage.startsWith(`..${sep}`) || isAbsolute(relativePackage)) throw new Error(`${name} did not resolve inside this worktree's node_modules`);
    const document = json(packageJson.path);
    const rootLockEntry = lockDocument?.packages?.[`node_modules/${name}`];
    const installedLockEntry = installedLockDocument?.packages?.[`node_modules/${name}`];
    if (!document?.version || rootLockEntry?.version !== document.version || installedLockEntry?.version !== document.version) throw new Error(`${name} version differs across package JSON and root/installed locks`);
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(rootLockEntry?.integrity ?? "") || installedLockEntry?.integrity !== rootLockEntry.integrity) throw new Error(`${name} integrity differs across root and installed locks`);
    packages[name] = {
      version: document.version,
      package_json_path: packageJson.path,
      package_json_sha256: await sha256(packageJson.path),
      root_lock_integrity: rootLockEntry.integrity,
      installed_lock_integrity: installedLockEntry.integrity,
    };
  }

  const playwrightRoot = dirname(packages.playwright.package_json_path);
  const playwrightCoreRoot = dirname(packages["playwright-core"].package_json_path);
  const browserRegistry = await described(join(playwrightCoreRoot, "browsers.json"), "Playwright browser registry");
  assertExactPath(browserRegistry.path, join(root, "node_modules", "playwright-core", "browsers.json"), "Playwright browser registry");
  const chromiumRegistry = json(browserRegistry.path)?.browsers?.find((entry) => entry?.name === "chromium");
  if (!/^\d+$/.test(chromiumRegistry?.revision ?? "") || !/^\d+(?:\.\d+){2,3}$/.test(chromiumRegistry?.browserVersion ?? "")) throw new Error("Playwright Chromium registry identity is invalid");

  const playwrightEntry = canonicalFile(requireFromRoot.resolve("playwright"), "Playwright module entry");
  const playwrightEntryRelative = relative(playwrightRoot, playwrightEntry.path);
  if (!playwrightEntryRelative || playwrightEntryRelative.startsWith(`..${sep}`) || isAbsolute(playwrightEntryRelative)) throw new Error("Playwright module entry is outside the exact installed package");
  const registryModule = canonicalFile(join(playwrightCoreRoot, "lib", "server", "registry", "index.js"), "Playwright registry module");
  const { chromium } = requireFromRoot(playwrightEntry.path);
  const { registry } = requireFromRoot(registryModule.path);
  const independentlyResolvedExecutable = registry?.findExecutable?.("chromium")?.executablePath?.();
  if (!isAbsolute(independentlyResolvedExecutable ?? "")) throw new Error("installed Playwright registry did not resolve Chromium");
  const registryChromiumExecutable = await described(independentlyResolvedExecutable, "registry-resolved Chromium executable");
  const chromiumExecutable = await described(chromium.executablePath(), "Playwright Chromium executable");
  if (!samePath(registryChromiumExecutable.path, chromiumExecutable.path) || registryChromiumExecutable.sha256 !== chromiumExecutable.sha256) throw new Error("Playwright API and installed registry resolve different Chromium executables");
  // fnm's normal `fnm use` workflow exposes node.exe through a multishell
  // directory whose parent is a junction. Bind the physical installation
  // binary, not the transient alias, so the captured identity is stable while
  // still hashing the exact executable that Windows resolves.
  const physicalNodeExecutable = realpathSync.native(process.execPath);
  const nodeExecutable = await described(physicalNodeExecutable, "Node executable");
  assertExactPath(nodeExecutable.path, physicalNodeExecutable, "Node executable");

  return {
    schema_version: 1,
    node: { version: process.version, executable: nodeExecutable },
    root_package: packageManifest,
    root_lock: { ...packageLock, lockfile_version: lockDocument.lockfileVersion },
    installed_lock: { ...installedLock, lockfile_version: installedLockDocument.lockfileVersion },
    packages,
    chromium: {
      browser_version: chromiumRegistry.browserVersion,
      revision: chromiumRegistry.revision,
      registry: browserRegistry,
      executable: chromiumExecutable,
    },
  };
}

export async function verifyRuntimeProvenanceDocument(document, inputRoot) {
  const actual = await captureRuntimeProvenance(inputRoot);
  if (JSON.stringify(document) !== JSON.stringify(actual)) throw new Error("installed runtime differs from immutable runtime provenance");
  return actual;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index], value = process.argv[index + 1];
    if (!name?.startsWith("--") || !value || args.has(name)) throw new Error("runtime provenance arguments are malformed or duplicated");
    args.set(name, value);
  }
  const root = args.get("--root");
  const out = args.get("--out");
  const verify = args.get("--verify");
  if (!isAbsolute(root ?? "") || Boolean(out) === Boolean(verify) || !isAbsolute(out ?? verify ?? "") || args.size !== 2) throw new Error("usage: runtime-provenance.mjs --root ABS (--out ABS | --verify ABS)");
  const snapshot = await captureRuntimeProvenance(root);
  if (verify) {
    const expectedFile = canonicalFile(verify, "expected runtime provenance");
    if (JSON.stringify(json(expectedFile.path)) !== JSON.stringify(snapshot)) throw new Error("installed runtime differs from immutable runtime provenance");
  } else {
    writeFileSync(resolve(out), JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  }
}

if (process.argv[1] && samePath(resolve(process.argv[1]), resolve(fileURLToPath(import.meta.url)))) await main();
