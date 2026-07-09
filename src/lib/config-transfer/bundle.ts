import "server-only";

import { createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

import { parseCsv } from "./csv";
import {
  CONFIG_TRANSFER_CATEGORIES,
  CONFIG_TRANSFER_FORMAT_VERSION,
  CONFIG_TRANSFER_MANIFEST_PATH,
  configTransferManifestSchema,
  type ConfigTransferCategory,
  type ConfigTransferManifest,
} from "./manifest";

// Zip read/write for config-transfer bundles, with integrity + safety limits.
// A bundle is untrusted input (hand-editable), so readBundle validates the
// manifest, verifies every declared checksum, and rejects anything unexpected
// or oversized before the engine sees it. See ADR-002 "Security Considerations".

/** Overall bundle upload cap (MVP). Import streams/validates within this. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** Per-file uncompressed cap (media is separately capped at 2MB by media-image). */
export const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
/** Guard against zip-bomb-style entry counts. */
export const MAX_BUNDLE_FILES = 2000;

export class ConfigTransferBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigTransferBundleError";
  }
}

export type BundleEntry = {
  /** Path within the zip, e.g. "site-content/pages.csv". Never "manifest.json". */
  path: string;
  category: ConfigTransferCategory;
  /** Row count for tabular/document files; null for binary media. */
  rowCount: number | null;
  bytes: Uint8Array;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BuildBundleParams = {
  entries: BundleEntry[];
  appVersion: string;
  prismaMigration: string | null;
  includedCategories: ConfigTransferCategory[];
  doorCodesIncluded: boolean;
  /** ISO-8601 timestamp; the app stamps this (kept out of this pure builder). */
  generatedAt: string;
};

/** Build a bundle's zip bytes: manifest (with per-file checksums) + entries. */
export function buildBundle(params: BuildBundleParams): Uint8Array {
  const seen = new Set<string>();
  for (const entry of params.entries) {
    if (entry.path === CONFIG_TRANSFER_MANIFEST_PATH) {
      throw new ConfigTransferBundleError(
        `Entry path collides with the manifest: ${entry.path}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new ConfigTransferBundleError(`Duplicate entry path: ${entry.path}`);
    }
    seen.add(entry.path);
  }

  const manifest: ConfigTransferManifest = {
    formatVersion: CONFIG_TRANSFER_FORMAT_VERSION,
    generatedAt: params.generatedAt,
    app: {
      version: params.appVersion,
      prismaMigration: params.prismaMigration,
    },
    includedCategories: params.includedCategories,
    files: params.entries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      rowCount: entry.rowCount,
      sha256: sha256Hex(entry.bytes),
    })),
    doorCodesIncluded: params.doorCodesIncluded,
  };

  const zippable: Record<string, Uint8Array> = {
    [CONFIG_TRANSFER_MANIFEST_PATH]: strToU8(
      JSON.stringify(manifest, null, 2),
    ),
  };
  for (const entry of params.entries) {
    zippable[entry.path] = entry.bytes;
  }

  return zipSync(zippable, { level: 6 });
}

export type ReadBundleResult = {
  manifest: ConfigTransferManifest;
  /**
   * Every non-manifest file actually present in the zip, keyed by path
   * (files-first: the importer trusts the bytes on disk, not the manifest's
   * declared list, so a hand-added file is usable and a hand-removed one simply
   * absent).
   */
  files: Map<string, Uint8Array>;
  /**
   * Advisory integrity notes (checksum drift, declared-but-missing, or
   * present-but-undeclared files). Surfaced in the dry-run so the admin can
   * decide; never blocks the import. See ADR-001 "hand-edit".
   */
  warnings: string[];
};

/** Reject path-traversal / absolute / backslash entry names (safety, not integrity). */
function isUnsafeEntryPath(name: string): boolean {
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return true;
  if (name.includes("\\")) return true;
  return name.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * Tolerate the two most common re-zip mistakes for a hand-edited bundle:
 * 1. macOS archive cruft — drop `__MACOSX/…` and any `.DS_Store` entry.
 * 2. a single wrapper directory — if `manifest.json` isn't at the root but
 *    exactly one top-level folder contains it (the "Compress the folder"
 *    mistake), strip that folder prefix so the bundle reads as if at the root.
 * Anything ambiguous (no wrapper, or several candidate folders) is left as-is
 * and falls through to the normal missing-manifest error.
 */
function normalizeBundleEntries(
  unzipped: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const cleaned = Object.entries(unzipped).filter(
    ([name]) =>
      // Drop directory markers (a re-zip via macOS/`zip -r` adds explicit
      // "foo/" entries; our own export stores flat paths), macOS cruft, and
      // .DS_Store — none are bundle files, so they must not be treated as
      // undeclared entries.
      !name.endsWith("/") &&
      !name.startsWith("__MACOSX/") &&
      !name.split("/").includes(".DS_Store"),
  );
  if (cleaned.some(([name]) => name === CONFIG_TRANSFER_MANIFEST_PATH)) {
    return Object.fromEntries(cleaned);
  }
  const wrapperPrefixes = new Set<string>();
  for (const [name] of cleaned) {
    const slash = name.indexOf("/");
    if (slash > 0 && name.slice(slash + 1) === CONFIG_TRANSFER_MANIFEST_PATH) {
      wrapperPrefixes.add(name.slice(0, slash + 1));
    }
  }
  if (wrapperPrefixes.size === 1) {
    const prefix = [...wrapperPrefixes][0];
    return Object.fromEntries(
      cleaned
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, bytes]) => [name.slice(prefix.length), bytes]),
    );
  }
  return Object.fromEntries(cleaned);
}

/**
 * Parse + validate a bundle. HARD-throws ConfigTransferBundleError only for
 * problems that make the bundle unprocessable or unsafe: oversized, too many
 * files, unsafe entry paths, not-a-zip, missing/invalid manifest, or an
 * unsupported (newer) format version. Integrity issues that a hand-editor can
 * legitimately cause — checksum drift, row-count/file-set differences — are
 * returned as `warnings`, not thrown, because bundles are meant to be editable
 * and a human reviews the dry-run before anything writes (ADR-001 "hand-edit").
 */
export function readBundle(zipBytes: Uint8Array): ReadBundleResult {
  if (zipBytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new ConfigTransferBundleError(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
    );
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch {
    throw new ConfigTransferBundleError("Bundle is not a valid zip archive");
  }
  // Forgive the common re-zip mistakes (macOS cruft, single wrapper folder).
  unzipped = normalizeBundleEntries(unzipped);

  const names = Object.keys(unzipped);
  if (names.length > MAX_BUNDLE_FILES) {
    throw new ConfigTransferBundleError(
      `Bundle has too many files (${names.length} > ${MAX_BUNDLE_FILES})`,
    );
  }
  for (const name of names) {
    if (isUnsafeEntryPath(name)) {
      throw new ConfigTransferBundleError(
        `Bundle contains an unsafe entry path: ${name}`,
      );
    }
    if (unzipped[name].byteLength > MAX_BUNDLE_FILE_BYTES) {
      throw new ConfigTransferBundleError(
        `Bundle file exceeds the per-file limit: ${name}`,
      );
    }
  }

  const manifestBytes = unzipped[CONFIG_TRANSFER_MANIFEST_PATH];
  if (!manifestBytes) {
    throw new ConfigTransferBundleError("Bundle is missing manifest.json");
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ConfigTransferBundleError("manifest.json is not valid JSON");
  }

  const parsed = configTransferManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new ConfigTransferBundleError(
      `manifest.json failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const manifest = parsed.data;

  if (manifest.formatVersion > CONFIG_TRANSFER_FORMAT_VERSION) {
    throw new ConfigTransferBundleError(
      `Bundle format version ${manifest.formatVersion} is newer than this ` +
        `app supports (${CONFIG_TRANSFER_FORMAT_VERSION}); upgrade before importing`,
    );
  }

  // Files-first: every file actually present (bar the manifest) is usable.
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name === CONFIG_TRANSFER_MANIFEST_PATH) continue;
    files.set(name, unzipped[name]);
  }

  // Advisory integrity: compare the manifest's declared file list to what is
  // present. Drift is expected for hand-edited bundles, so these are warnings.
  const warnings: string[] = [];
  const declared = new Set<string>();
  for (const file of manifest.files) {
    declared.add(file.path);
    const bytes = files.get(file.path);
    if (!bytes) {
      warnings.push(`Manifest lists ${file.path}, but it is not in the bundle`);
      continue;
    }
    if (sha256Hex(bytes) !== file.sha256) {
      warnings.push(
        `${file.path} differs from its manifest checksum (edited since export)`,
      );
    }
  }
  for (const name of files.keys()) {
    if (!declared.has(name)) {
      warnings.push(`${name} is present but not listed in the manifest`);
    }
  }

  return { manifest, files, warnings };
}

/** Map a zip path to its owning category (media rides with site-content). */
function categoryForPath(path: string): ConfigTransferCategory {
  const seg = path.split("/")[0];
  if (seg === "media") return "site-content";
  const cat = CONFIG_TRANSFER_CATEGORIES.find((c) => c === seg);
  if (!cat) {
    throw new ConfigTransferBundleError(
      `Cannot map "${path}" to a known category for reseal`,
    );
  }
  return cat;
}

/**
 * Regenerate a bundle's manifest from the files actually present, so a
 * hand-edited bundle imports without integrity warnings. Recomputes every
 * checksum + row count and re-derives includedCategories from the files; keeps
 * the envelope metadata (app version, timestamp, door-codes flag). Structural
 * limits still apply (throws on unsafe/oversized/invalid input).
 */
export function resealBundle(zipBytes: Uint8Array): Uint8Array {
  const { manifest, files } = readBundle(zipBytes);
  const entries: BundleEntry[] = [];
  for (const [path, bytes] of files) {
    entries.push({
      path,
      category: categoryForPath(path),
      rowCount: path.endsWith(".csv")
        ? parseCsv(strFromU8(bytes)).rows.length
        : null,
      bytes,
    });
  }
  return buildBundle({
    entries,
    appVersion: manifest.app.version,
    prismaMigration: manifest.app.prismaMigration,
    includedCategories: [...new Set(entries.map((e) => e.category))],
    doorCodesIncluded: manifest.doorCodesIncluded,
    generatedAt: manifest.generatedAt,
  });
}
