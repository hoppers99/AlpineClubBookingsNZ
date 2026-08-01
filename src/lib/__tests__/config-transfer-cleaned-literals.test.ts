import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CLEANED_LITERALS,
  cleanedLiteralWarning,
  detectCleanedLiterals,
  stripCleanedLiterals,
} from "@/lib/config-transfer/cleaned-literals";
import {
  serialisePages,
  serialiseSiteContent,
  siteContentImporter,
} from "@/lib/config-transfer/categories/site-content";
import type { ImportMode, ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// #2511 — a config bundle exported BEFORE a cleanup migration still carries the
// removed value (the exporter selects the DB column verbatim; the applier writes
// it straight back), and the boot auto-import runs AFTER migrations. These tests
// prove the runtime guard refuses to re-plant each cleaned literal on BOTH the
// interactive (merge) and boot (overwrite) paths, keeps the preview honest, and
// never blocks a club's own customised value or the other fields in the bundle.

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

// ---------------------------------------------------------------------------
// Registry: byte-exact against the migrations, no silent drift.
// ---------------------------------------------------------------------------

describe("cleaned-literal registry stays byte-exact with the migrations (#2511)", () => {
  it("the #2431 hero literal matches the WHERE clause of its cleanup migration", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2431")!;
    expect(entry).toBeDefined();
    expect(entry.entity).toBe("page-content");
    expect(entry.key).toBe("home");
    expect(entry.field).toBe("headerText");
    // The migration matches the OLD sentence with SQL-doubled apostrophes.
    const sql = migrationSql(entry.migration);
    const sqlLiteral = entry.literal.replaceAll("'", "''");
    expect(sql).toContain(`"headerText" = '${sqlLiteral}'`);
    // And it must NOT equal the replacement the migration writes.
    expect(sql).toContain(`SET "headerText" = '`);
    expect(sql).not.toContain(`SET "headerText" = '${sqlLiteral}'`);
  });

  it("the #2490 footer literal matches the $cms$-quoted WHERE clause", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2490")!;
    expect(entry.entity).toBe("site-content");
    expect(entry.key).toBe("FOOTER_AFFILIATIONS");
    expect(entry.field).toBe("contentHtml");
    const sql = migrationSql(entry.migration);
    expect(sql).toContain(`AND "contentHtml" = $cms$${entry.literal}$cms$`);
  });

  it("the #2484 address literal matches its cleanup migration WHERE clause", () => {
    const entry = CLEANED_LITERALS.find((l) => l.issue === "#2484")!;
    expect(entry.entity).toBe("lodge");
    // Value-scoped across every lodge row.
    expect(entry.key).toBeNull();
    expect(entry.field).toBe("address");
    const sql = migrationSql(entry.migration);
    expect(sql).toContain(`WHERE "address" = '${entry.literal}'`);
  });
});

// ---------------------------------------------------------------------------
// Detector / stripper / warning — pure unit behaviour.
// ---------------------------------------------------------------------------

const HERO = CLEANED_LITERALS.find((l) => l.issue === "#2431")!;
const FOOTER = CLEANED_LITERALS.find((l) => l.issue === "#2490")!;
const ADDRESS = CLEANED_LITERALS.find((l) => l.issue === "#2484")!;

describe("detectCleanedLiterals (#2511)", () => {
  it("flags an exact byte-match on the right entity/key/field", () => {
    const hits = detectCleanedLiterals("page-content", "home", {
      headerText: HERO.literal,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe("headerText");
    expect(hits[0].migration).toBe(HERO.migration);
  });

  it("does NOT flag a club's own customised value", () => {
    expect(
      detectCleanedLiterals("page-content", "home", {
        headerText: "Welcome to Our Own Club Lodge — members only.",
      }),
    ).toHaveLength(0);
  });

  it("does NOT flag the literal under the wrong key", () => {
    expect(
      detectCleanedLiterals("page-content", "about", {
        headerText: HERO.literal,
      }),
    ).toHaveLength(0);
  });

  it("does NOT flag when the field is absent", () => {
    expect(detectCleanedLiterals("page-content", "home", {})).toHaveLength(0);
  });

  it("is byte-exact: a one-character change no longer matches", () => {
    expect(
      detectCleanedLiterals("page-content", "home", {
        headerText: HERO.literal + " ",
      }),
    ).toHaveLength(0);
  });

  it("matches a value-scoped (key:null) literal on ANY row key", () => {
    // The address is value-scoped across every lodge, so any slug matches.
    for (const slug of ["default", "second-lodge", "whatever"]) {
      expect(
        detectCleanedLiterals("lodge", slug, { address: ADDRESS.literal }),
      ).toHaveLength(1);
    }
  });
});

describe("stripCleanedLiterals (#2511)", () => {
  it("removes only the matched field and returns the hit", () => {
    const { write, hits } = stripCleanedLiterals(
      "page-content",
      "home",
      { headerText: HERO.literal, caption: "Welcome" },
      { headerText: HERO.literal, caption: "Welcome", title: "Home" },
    );
    expect(hits).toHaveLength(1);
    expect(write).toEqual({ caption: "Welcome", title: "Home" });
    expect("headerText" in write).toBe(false);
  });

  it("is a no-op (same reference) when nothing matches", () => {
    const original = { headerText: "custom", title: "Home" };
    const { write, hits } = stripCleanedLiterals(
      "page-content",
      "home",
      { headerText: "custom" },
      original,
    );
    expect(hits).toHaveLength(0);
    expect(write).toBe(original);
  });
});

describe("cleanedLiteralWarning (#2511)", () => {
  it("names what would be restored, the migration and the issue", () => {
    const [hit] = detectCleanedLiterals("site-content", "FOOTER_AFFILIATIONS", {
      contentHtml: FOOTER.literal,
    });
    const warning = cleanedLiteralWarning(hit);
    expect(warning).toContain(FOOTER.describe);
    expect(warning).toContain(FOOTER.migration);
    expect(warning).toContain("#2490");
  });
});

// ---------------------------------------------------------------------------
// Full plan + apply through the importer — interactive (merge) and boot
// (overwrite) paths. The boot auto-import uses BOOTSTRAP_IMPORT_MODE =
// "overwrite" and the SAME importer, so the overwrite cases prove the
// unattended fail-safe at the layer the guard lives.
// ---------------------------------------------------------------------------

const NEW_HERO =
  "Our club lodge welcomes members year-round. Log in to book a stay, or " +
  "apply to join and explore New Zealand's mountains.";

interface PageRow {
  id: string;
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
  published: boolean;
}
interface SiteRow {
  id: string;
  key: string;
  contentHtml: string;
}

/** A tx/db double capturing pageContent + siteContent writes. */
function makeStore(pages: PageRow[], siteRows: SiteRow[]) {
  const pageMap = new Map(pages.map((p) => [p.slug, { ...p }]));
  const siteMap = new Map(siteRows.map((s) => [s.key, { ...s }]));
  const db = {
    pageContent: {
      findMany: async ({ where }: { where?: { slug?: { in: string[] } } }) => {
        const slugs = where?.slug?.in;
        return [...pageMap.values()].filter(
          (p) => !slugs || slugs.includes(p.slug),
        );
      },
      create: async ({ data }: { data: PageRow }) => {
        pageMap.set(data.slug, { ...data });
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { slug: string };
        data: Partial<PageRow>;
      }) => {
        const cur = pageMap.get(where.slug)!;
        pageMap.set(where.slug, { ...cur, ...data });
        return pageMap.get(where.slug);
      },
    },
    siteContent: {
      findMany: async ({ where }: { where?: { key?: { in: string[] } } }) => {
        const keys = where?.key?.in;
        return [...siteMap.values()].filter(
          (s) => !keys || keys.includes(s.key),
        );
      },
      create: async ({ data }: { data: SiteRow }) => {
        siteMap.set(data.key, { ...data });
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { key: string };
        data: Partial<SiteRow>;
      }) => {
        const cur = siteMap.get(where.key)!;
        siteMap.set(where.key, { ...cur, ...data });
        return siteMap.get(where.key);
      },
    },
    clubTheme: { findUnique: async () => null, findMany: async () => [] },
    mediaImage: { findMany: async () => [] },
  };
  return {
    db,
    home: () => pageMap.get("home"),
    page: (slug: string) => pageMap.get(slug),
    site: (key: string) => siteMap.get(key),
  };
}

function pageBundleRow(overrides: Partial<PageRow>): Record<string, string> {
  const base = {
    slug: "home",
    path: "/home",
    caption: "Welcome to the Club Lodge",
    menuTitle: "Home",
    title: "Club Lodge",
    headerText: HERO.literal,
    sortOrder: 1,
    contentHtml: "",
    published: true,
  };
  const row = { ...base, ...overrides };
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
}

function currentHome(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "home",
    slug: "home",
    path: "/home",
    caption: "Welcome to the Club Lodge",
    menuTitle: "Home",
    title: "Club Lodge",
    headerText: NEW_HERO,
    sortOrder: 1,
    contentHtml: "",
    published: true,
    ...overrides,
  };
}

function filesFor(pageRows: Record<string, string>[], siteRows: Record<string, string>[]) {
  const files = new Map<string, Uint8Array>();
  const pageEntry = serialisePages(pageRows as never);
  files.set(pageEntry.path, pageEntry.bytes);
  const siteEntry = serialiseSiteContent(siteRows as never);
  files.set(siteEntry.path, siteEntry.bytes);
  return files;
}

async function runPlan(
  files: Map<string, Uint8Array>,
  store: ReturnType<typeof makeStore>,
  mode: ImportMode,
) {
  return siteContentImporter.plan({
    db: store.db as unknown as ReadDb,
    files,
    manifest: { formatVersion: 2 } as never,
    mode,
    resolutions: new Map<string, string>(),
  } as never);
}

async function runApply(
  files: Map<string, Uint8Array>,
  store: ReturnType<typeof makeStore>,
  mode: ImportMode,
) {
  return siteContentImporter.apply({
    tx: store.db as unknown as TxDb,
    files,
    manifest: { formatVersion: 2 } as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  });
}

describe.each(["overwrite", "merge"] as const)(
  "the cleaned-literal guard on the %s path (#2511)",
  (mode) => {
    it("does NOT re-plant the guest-booking hero, and keeps the cleaned copy", async () => {
      // The bundle carries the OLD hero for the always-seeded "home" row.
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: HERO.literal })], []);

      await runApply(files, store, mode);

      // The migration's replacement survives; the old sentence is NOT written.
      expect(store.home()!.headerText).toBe(NEW_HERO);
      expect(store.home()!.headerText).not.toBe(HERO.literal);
    });

    it("surfaces a named preview warning and does NOT claim a headerText change", async () => {
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: HERO.literal })], []);

      const plan = await runPlan(files, store, mode);

      expect(
        plan.warnings.some((w) => w.includes(HERO.migration) && w.includes("#2431")),
      ).toBe(true);
      const item = plan.items.find((i) => i.entity === "page-content" && i.key === "home");
      expect(item?.changedFields ?? []).not.toContain("headerText");
      // Pure re-plant (nothing else differs) reads as unchanged, not update.
      expect(item?.action).toBe("unchanged");
    });

    it("still imports OTHER fields of the same guarded row", async () => {
      // Same bundle re-plants the hero but genuinely changes the caption.
      const store = makeStore([currentHome()], []);
      const files = filesFor(
        [pageBundleRow({ headerText: HERO.literal, caption: "A brand new caption" })],
        [],
      );

      await runApply(files, store, mode);

      expect(store.home()!.caption).toBe("A brand new caption");
      expect(store.home()!.headerText).toBe(NEW_HERO); // hero still not re-planted
    });

    it("imports a club's OWN customised hero unchanged", async () => {
      const OWN = "Our alpine club — a members' lodge in the Southern Alps.";
      const store = makeStore([currentHome()], []);
      const files = filesFor([pageBundleRow({ headerText: OWN })], []);

      await runApply(files, store, mode);

      expect(store.home()!.headerText).toBe(OWN);
    });

    it("does NOT re-plant the RMCA footer affiliations", async () => {
      const store = makeStore(
        [],
        [{ id: "aff", key: "FOOTER_AFFILIATIONS", contentHtml: "" }],
      );
      const files = filesFor(
        [],
        [{ key: "FOOTER_AFFILIATIONS", contentHtml: FOOTER.literal }],
      );

      const plan = await runPlan(files, store, mode);
      await runApply(files, store, mode);

      expect(store.site("FOOTER_AFFILIATIONS")!.contentHtml).toBe("");
      expect(
        plan.warnings.some((w) => w.includes(FOOTER.migration) && w.includes("#2490")),
      ).toBe(true);
    });

    it("imports a DIFFERENT footer key normally", async () => {
      const store = makeStore(
        [],
        [{ id: "blurb", key: "FOOTER_BLURB", contentHtml: "<p>old</p>" }],
      );
      const files = filesFor(
        [],
        [{ key: "FOOTER_BLURB", contentHtml: "<p>Our new blurb</p>" }],
      );

      await runApply(files, store, mode);

      expect(store.site("FOOTER_BLURB")!.contentHtml).toContain("Our new blurb");
    });
  },
);
