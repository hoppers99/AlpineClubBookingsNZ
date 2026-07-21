/*
 * Theme guarantees — the programme's compliance-by-construction layer (#2187 P1).
 *
 * Every guarantee is a HARD floor swept over every scale × mode × seed (+ kiosk).
 * A failing cell is a blunt stop-and-report (the sweep test fails), never a silent
 * walk-back. The Phase-0 measurements.json guarantee_sweep is the coverage target;
 * this module reproduces it and adds G2b (R11).
 *
 *  G1  foreground (neutral-12) on scale steps 1–5      ≥ 4.5:1 (AA text)
 *  G2  muted-fg  (neutral-11) on scale steps 1–3       ≥ 4.5:1 (AA text)
 *  G2b status-chip text (step-11) on chip surface (step-3), every scale ≥ 4.5:1 (R11)
 *  G3  muted-fg (neutral-11) vs foreground (neutral-12): distinctness ratio (recorded)
 *  G4  A4 solid-foreground on step-9 / step-10 fills    ≥ 4.5:1 (AA text)
 *  G5a card/page separation (neutral-1 vs neutral-2): ΔL floor + pinned shadow (J8)
 *  G5b --input/--ring (neutral-10) vs surfaces 1–3      ≥ 3:1
 */
import { contrast, oklch, a4SolidForeground, type BuiltTheme } from "./theme-substrate";
import { A2_INPUT_RING_NEUTRAL_STEP } from "./aliases";

/** WCAG AA minimum for normal-size body text. */
export const AA_TEXT = 4.5;
/** G5b floor: interactive-boundary contrast against adjacent surfaces. */
export const INPUT_RING_MIN = 3;
/** G2b floor: status-chip text must clear AA (4.5:1) on its pale chip surface. */
export const CHIP_TEXT_FLOOR = 4.5;

/**
 * G5a card separation — signed-off A6 candidate ii (tint + shadow). The measured
 * default-light numbers are the pinned floor; the shadow is the pinned J8 value.
 */
export const G5A_CARD_SEPARATION = {
  /** neutral-1 (card) vs neutral-2 (page) minimum lightness delta. */
  minDeltaL: 0.012,
  /** neutral-1 vs neutral-2 minimum contrast ratio. */
  minContrast: 1.04,
  /** J8 pinned box-shadow. */
  boxShadow: "0 1px 2px 0 #040a054a, 0 1px 3px 0 #020b037b",
} as const;

export interface SweepFailure {
  guarantee: "G1" | "G2" | "G2b" | "G4" | "G5a" | "G5b";
  cell: string;
  ratio: number;
  floor: number;
}

/** True oklch lightness (matches the Phase-0 ΔL space). */
const oklchL = (hex: string): number => oklch(hex)[0];

/**
 * Sweep every guarantee over one built theme. `lightNeutral12` is the SAME seed
 * set's light-mode neutral-12 (for the A4 ladder). Returns the failure list —
 * empty means the theme is compliant by construction.
 */
export function sweepGuarantees(
  theme: BuiltTheme,
  lightNeutral12: string,
  cellPrefix: string,
): SweepFailure[] {
  const failures: SweepFailure[] = [];
  const n = theme.neutralHex;
  const fg = n[11]; // neutral-12
  const mfg = n[10]; // neutral-11
  const surfaces1to3 = [n[0], n[1], n[2]];

  for (const [sname, s] of Object.entries(theme.scales)) {
    const h = s.hex;
    // G1: foreground on steps 1–5
    for (let i = 0; i < 5; i++) {
      const r = contrast(fg, h[i]);
      if (r < AA_TEXT) failures.push({ guarantee: "G1", cell: `${cellPrefix}/${sname}/step${i + 1}`, ratio: round2(r), floor: AA_TEXT });
    }
    // G2: muted-fg on steps 1–3
    for (let i = 0; i < 3; i++) {
      const r = contrast(mfg, h[i]);
      if (r < AA_TEXT) failures.push({ guarantee: "G2", cell: `${cellPrefix}/${sname}/step${i + 1}`, ratio: round2(r), floor: AA_TEXT });
    }
    // G2b: chip text (step-11) on chip surface (step-3) for EVERY scale
    const g2b = contrast(h[10], h[2]);
    if (g2b < CHIP_TEXT_FLOOR) failures.push({ guarantee: "G2b", cell: `${cellPrefix}/${sname}/chip`, ratio: round2(g2b), floor: CHIP_TEXT_FLOOR });
    // G4: A4 solid-foreground on step-9 / step-10 (hue scales only)
    if (sname !== "neutral" && s.generatorContrast) {
      for (const idx of [8, 9]) {
        const res = a4SolidForeground(h[idx], s.generatorContrast, lightNeutral12);
        if (!res.passAA) failures.push({ guarantee: "G4", cell: `${cellPrefix}/${sname}/step${idx + 1}`, ratio: res.ratio, floor: AA_TEXT });
      }
    }
  }

  // G5b: --input/--ring (neutral-10) vs surfaces 1–3
  const inputRing = n[A2_INPUT_RING_NEUTRAL_STEP - 1];
  for (let i = 0; i < 3; i++) {
    const r = contrast(inputRing, surfaces1to3[i]);
    if (r < INPUT_RING_MIN) failures.push({ guarantee: "G5b", cell: `${cellPrefix}/inputring/surface${i + 1}`, ratio: round2(r), floor: INPUT_RING_MIN });
  }

  // G5a: card/page separation (light only — cards read via shadow+border in dark).
  if (theme.mode === "light") {
    // Compared at measurements.json precision (ΔL r3, contrast r2): both reference
    // seeds clear the pinned candidate-ii floor there; tokoroa sits right on the ΔL
    // floor, with the pinned J8 shadow the primary separation reinforcement.
    const dL = round3(Math.abs(oklchL(n[0]) - oklchL(n[1])));
    const c = round2(contrast(n[0], n[1]));
    if (dL < G5A_CARD_SEPARATION.minDeltaL) failures.push({ guarantee: "G5a", cell: `${cellPrefix}/card-deltaL`, ratio: dL, floor: G5A_CARD_SEPARATION.minDeltaL });
    if (c < G5A_CARD_SEPARATION.minContrast) failures.push({ guarantee: "G5a", cell: `${cellPrefix}/card-contrast`, ratio: c, floor: G5A_CARD_SEPARATION.minContrast });
  }

  return failures;
}

/** G3 distinctness ratio (recorded, not a hard floor): muted-fg vs foreground. */
export function g3Distinctness(theme: BuiltTheme): number {
  return round2(contrast(theme.neutralHex[10], theme.neutralHex[11]));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
