/*
 * REFERENCE PALETTES for the theme generator/guarantee tests.
 *
 * #2190 P4 — no fork/Tokoroa brand colours appear anywhere in the public repo
 * (standing directive D15). The generator goldens are pinned only for the
 * shipping DEFAULT palette (SEED_SETS below), and a SYNTHETIC bright-accent
 * palette — a generic Tailwind yellow/zinc/rose triple, deliberately NOT any
 * real club's brand — provides the "does the substrate hold for a bright,
 * low-headroom accent?" coverage that a second reference palette used to give.
 * The synthetic palette is exercised by the guarantee sweep (compliance is
 * computed, so it needs no pinned goldens) and by the club-theme-schema
 * distinctness/contrast tests.
 */
import type { ThemeSeeds } from "../theme-substrate";
import type { ClubThemeValues } from "@/lib/club-theme-schema";

/** The shipping default seed triple (D12 mapping); the golden-pinned reference. */
export const SEED_SETS: Record<"default", ThemeSeeds> = {
  default: { accent: "#57b3ab", neutralSource: "#17231c", support: "#b04d28" },
};

/**
 * A synthetic bright-accent stress palette: a generic Tailwind yellow-500 accent
 * and rose-600 support over a dark pine neutral character (chosen to clear the
 * tight G5a light-mode card-separation floor). Not any real club's brand — it
 * exists only to prove the generator bands a bright, low-contrast-headroom accent
 * into an AA-compliant substrate by construction. Guarantee-sweep coverage only;
 * no pinned goldens.
 */
export const SYNTHETIC_SEEDS: ThemeSeeds = {
  accent: "#eab308",
  neutralSource: "#0f2018",
  support: "#e11d48",
};

/**
 * A palette whose neutral-character seed is an exact grey (r == g == b), so it
 * carries no hue at all. A hueless character has no tint direction, so
 * `deriveGrayAndBg` derives a chroma-0 grey seed for it (#2491) — Radix's
 * perfectly achromatic `gray` ramp is its closest reference ramp, the degenerate
 * divide-by-zero the colorjs 0.7 chroma guard in `getScaleFromColor` handles
 * (#2303). Guarantee-sweep coverage only (no pinned goldens):
 * `colorjs-coords.test.ts` pins the hexes, this proves the resulting true-grey
 * ramp clears every contrast floor by construction — including the G5a card/page
 * separation, once #2491 dropped the arbitrary hue-0 (red) tint the old 0.008
 * seed chroma produced on a missing hue.
 */
export const ACHROMATIC_NEUTRAL_SEEDS: ThemeSeeds = {
  accent: "#57b3ab",
  neutralSource: "#808080",
  support: "#b04d28",
};

/** The {@link SYNTHETIC_SEEDS} palette as full ClubThemeValues (schema tests). */
export const SYNTHETIC_CLUB_THEME_VALUES: ClubThemeValues = {
  brandGold: "#eab308",
  brandDeep: "#0f2018",
  brandSafety: "#e11d48",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoUrl: null,
  logoDataUrl: null,
  rawCss: "",
};
