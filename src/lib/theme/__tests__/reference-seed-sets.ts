/*
 * FORK REFERENCE FIXTURES for the theme generator/guarantee tests only.
 *
 * Tokoroa's gold (#ffcb05) is FORK data and must NEVER appear in shipping src/
 * product code (standing directive D15 — no Tokoroa colours in the public repo).
 * The full ClubTheme values live in the seed-provisioning domain
 * (prisma/seed-data.ts, alongside their SEED_TOKOROA_THEME_COMPLETE guard, out of
 * src/); this test fixture RE-EXPORTS them so the substrate tests have one source
 * of truth. The SEED_SETS 3-seed triples below are test-only golden references
 * (moved verbatim out of theme-substrate.ts) and are kept here because nothing in
 * src/ product code consumes them. The fork's own deployment carries this palette
 * in its ClubTheme DB row.
 */
import type { ThemeSeeds } from "../theme-substrate";

export { TOKOROA_CLUB_THEME_VALUES } from "../../../../prisma/seed-data";

/** Migrated 3-seed values for the two reference palettes (D12 mapping). */
export const SEED_SETS: Record<"default" | "tokoroa", ThemeSeeds> = {
  default: { accent: "#57b3ab", neutralSource: "#17231c", support: "#b04d28" },
  tokoroa: { accent: "#ffcb05", neutralSource: "#2f2f2b", support: "#ff7c12" },
};
