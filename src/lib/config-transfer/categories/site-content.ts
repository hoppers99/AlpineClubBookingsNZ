import { strToU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity, type EntityDescriptor } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";

// site-content category: CMS pages, keyed site content, and the club theme.
// See docs/config-transfer/decisions/ADR-001.

const PAGE_FILE = "site-content/pages.csv";
const SITE_CONTENT_FILE = "site-content/site-content.csv";
const THEME_FILE = "site-content/theme.json";

/** Allowlisted PageContent fields — no id/updatedByMemberId/timestamps. */
export const PAGE_CONTENT_FIELDS = [
  "slug",
  "path",
  "caption",
  "menuTitle",
  "title",
  "headerText",
  "sortOrder",
  "contentHtml",
  "published",
] as const;

export const SITE_CONTENT_FIELDS = ["key", "contentHtml"] as const;

export const CLUB_THEME_FIELDS = [
  "brandGold",
  "brandCharcoal",
  "brandDeep",
  "brandRidge",
  "brandMist",
  "brandSnow",
  "brandSafety",
  "headingFontKey",
  "bodyFontKey",
  "logoDataUrl",
  "rawCss",
] as const;

export const pageContentDescriptor: EntityDescriptor = registerEntity({
  entity: "page-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: PAGE_FILE,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...PAGE_CONTENT_FIELDS],
});

export const siteContentDescriptor: EntityDescriptor = registerEntity({
  entity: "site-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: SITE_CONTENT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...SITE_CONTENT_FIELDS],
});

export const clubThemeDescriptor: EntityDescriptor = registerEntity({
  entity: "club-theme",
  category: "site-content",
  tier: "key-strong",
  format: "json",
  file: THEME_FILE,
  naturalKey: [],
  singleton: true,
  fields: [...CLUB_THEME_FIELDS],
});

/** Extract MediaImage ids referenced as /api/images/<id> in content HTML. */
export function extractImageIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/images\/([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

type PageRow = Record<(typeof PAGE_CONTENT_FIELDS)[number], unknown>;
type SiteRow = Record<(typeof SITE_CONTENT_FIELDS)[number], unknown>;

export function serialisePages(rows: PageRow[]): BundleEntry {
  return {
    path: PAGE_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseSiteContent(rows: SiteRow[]): BundleEntry {
  return {
    path: SITE_CONTENT_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...SITE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseTheme(
  theme: Record<(typeof CLUB_THEME_FIELDS)[number], unknown> | null,
): BundleEntry | null {
  if (!theme) return null;
  const projected: Record<string, unknown> = {};
  for (const field of CLUB_THEME_FIELDS) projected[field] = theme[field];
  return {
    path: THEME_FILE,
    category: "site-content",
    rowCount: 1,
    bytes: strToU8(JSON.stringify(projected, null, 2)),
  };
}

export const siteContentExporter: CategoryExporter = {
  category: "site-content",
  descriptors: [
    pageContentDescriptor,
    siteContentDescriptor,
    clubThemeDescriptor,
  ],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const pages = await ctx.db.pageContent.findMany({
      orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
      select: {
        slug: true,
        path: true,
        caption: true,
        menuTitle: true,
        title: true,
        headerText: true,
        sortOrder: true,
        contentHtml: true,
        published: true,
      },
    });
    const siteContent = await ctx.db.siteContent.findMany({
      orderBy: { key: "asc" },
      select: { key: true, contentHtml: true },
    });
    const theme = await ctx.db.clubTheme.findUnique({
      where: { id: "default" },
      select: {
        brandGold: true,
        brandCharcoal: true,
        brandDeep: true,
        brandRidge: true,
        brandMist: true,
        brandSnow: true,
        brandSafety: true,
        headingFontKey: true,
        bodyFontKey: true,
        logoDataUrl: true,
        rawCss: true,
      },
    });

    // Reference every image embedded in exported HTML so its bytes are bundled.
    for (const page of pages) {
      for (const id of extractImageIds(page.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }
    for (const row of siteContent) {
      for (const id of extractImageIds(row.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }

    const entries: BundleEntry[] = [
      serialisePages(pages),
      serialiseSiteContent(siteContent),
    ];
    const themeEntry = serialiseTheme(theme);
    if (themeEntry) entries.push(themeEntry);
    return entries;
  },
};
