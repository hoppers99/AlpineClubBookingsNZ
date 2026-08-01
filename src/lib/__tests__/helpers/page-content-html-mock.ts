/**
 * Shared module-mock factory for `@/lib/page-content-html` (#2440).
 *
 * Several suites mock the whole module around a per-suite
 * `getSanitizedPageContentByPath` mock. The public routes read through
 * `getPublishedPageContentByPath`, so the mock must supply it too — and if
 * each suite re-implemented the published filter inline, a later change to
 * the real semantics would leave five stale copies silently asserting the old
 * behaviour. This is the single test-side mirror of that filter; the real
 * module's own semantics are pinned by `page-content-html.test.ts` and
 * end-to-end (mocking only prisma) by `public-page-unpublished-fallback.test.tsx`.
 */
export function pageContentHtmlModuleMock(
  getPage: (path: string) => Promise<unknown>,
  extras: Record<string, unknown> = {},
) {
  return {
    getSanitizedPageContentByPath: getPage,
    getPublishedPageContentByPath: async (path: string) => {
      const page = (await getPage(path)) as { published?: boolean | null } | null;
      return !page || page.published === false ? null : page;
    },
    ...extras,
  };
}
