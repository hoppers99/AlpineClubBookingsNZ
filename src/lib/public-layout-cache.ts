import "server-only";

import { revalidateTag } from "next/cache";

export const PUBLIC_LAYOUT_CACHE_TAGS = {
  capacity: "public-layout:capacity",
  modules: "public-layout:modules",
  banners: "public-layout:banners",
  theme: "public-layout:theme",
  identity: "public-layout:identity",
} as const;

export function invalidatePublicLayoutConfig(
  ...tags: Array<
    (typeof PUBLIC_LAYOUT_CACHE_TAGS)[keyof typeof PUBLIC_LAYOUT_CACHE_TAGS]
  >
): void {
  for (const tag of tags) revalidateTag(tag, "max");
}

/**
 * There is no `invalidatePublicLodgeCapacity()` any more (#2352 slice-1 review).
 *
 * It cleared the capacity TAG and nothing else, which was right while every public
 * page was re-rendered per visit and wrong the moment the CMS pages became stored
 * renders: `{{lodge-capacity}}` is resolved server-side through UNCACHED reads
 * (`src/lib/page-content-embeds.ts`), so the page's ISR entry carries no capacity
 * tag for `revalidateTag` to expire — an admin lowering the bed count changed
 * nothing a visitor saw. Its nine call sites (lodge settings plus the eight
 * bed-allocation write handlers) now call `revalidatePublicSite()`, which clears
 * the stored pages as well as the tag.
 */

/**
 * Invalidate the DB-first club-identity tag (E3 #1929). Called from the club
 * identity admin PUT, the lodges write routes (default lodge name feeds the
 * identity), and config-transfer apply. Lodge capacity shares the identity's
 * default-lodge dependency, so callers pair this with the capacity tag.
 */
export function invalidatePublicClubIdentity(): void {
  invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.identity);
}
