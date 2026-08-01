import { describe, expect, it } from "vitest";
import {
  buildThemeSubstrate,
  buildKioskTheme,
  contrast,
} from "../theme-substrate";
import {
  SEED_SETS,
  SYNTHETIC_SEEDS,
  SYNTHETIC_CLUB_THEME_VALUES,
  ACHROMATIC_NEUTRAL_SEEDS,
} from "./reference-seed-sets";
import {
  sweepGuarantees,
  sweepDerivedMutedForeground,
  DERIVED_MUTED_SURFACE_STEPS,
  g3Distinctness,
  G5A_CARD_SEPARATION,
  CHIP_TEXT_FLOOR,
  AA_TEXT,
} from "../guarantees";
import {
  DEFAULT_CLUB_THEME_VALUES,
  deriveAppMutedForeground,
  themeSeedsFromValues,
} from "../../club-theme-schema";
import measurements from "../../../../docs/theme/phase0/data/measurements.json";

/*
 * Guarantee sweep (#2187 P1). Compliance-by-construction: every scale × mode × seed
 * (+ kiosk) must clear its floor with ZERO failures. Also cross-checks that this
 * reproduces the Phase-0 measurements.json guarantee_sweep coverage (every recorded
 * cell pass:true) and pins the R11 G2b sweep and the G5a candidate-ii floor.
 */

type Built = ReturnType<typeof buildThemeSubstrate>;
function allThemes(): Array<{ theme: Built; lightN12: string; label: string }> {
  const out: Array<{ theme: Built; lightN12: string; label: string }> = [];
  // The shipping default (golden-pinned) plus the synthetic bright-accent stress
  // palette — the two reference palettes the substrate must hold for. Neither is
  // a real club's brand (#2190 D15). The exact-grey neutral palette is swept
  // separately below: it carries one KNOWN, pre-existing G5a shortfall.
  const seeds: Array<[string, (typeof SEED_SETS)["default"]]> = [
    ...(Object.entries(SEED_SETS) as Array<[string, (typeof SEED_SETS)["default"]]>),
    ["synthetic", SYNTHETIC_SEEDS],
  ];
  for (const [seedName, seed] of seeds) {
    const light = buildThemeSubstrate(seed, "light");
    const lightN12 = light.neutralHex[11];
    out.push({ theme: light, lightN12, label: `${seedName}/light` });
    out.push({ theme: buildThemeSubstrate(seed, "dark"), lightN12, label: `${seedName}/dark` });
  }
  const { theme, lightNeutral12 } = buildKioskTheme();
  out.push({ theme, lightN12: lightNeutral12, label: "kiosk/dark" });
  return out;
}

describe("theme guarantee sweep", () => {
  it("has ZERO guarantee failures across every scale × mode × seed + kiosk", () => {
    const failures = allThemes().flatMap(({ theme, lightN12, label }) =>
      sweepGuarantees(theme, lightN12, label),
    );
    expect(failures).toEqual([]);
  });

  /*
   * The exact-grey neutral-character palette (#2303). A seed with r == g == b
   * carries no hue, so the gray seed the substrate derives from it sits at the
   * neutral-seed pin's chroma on hue ~355 — low enough that Radix's perfectly
   * achromatic `gray` ramp becomes its closest reference ramp, which is the
   * degenerate case `getScaleFromColor`'s chroma guard exists for. This sweep
   * proves that ramp class is contrast-verified, not merely well-formed.
   *
   * It clears every guarantee EXCEPT one, which is pinned here rather than
   * hidden: light-mode card/page separation lands just under the G5a floor
   * (ΔL 0.011 vs 0.012, contrast 1.03 vs 1.04). That shortfall is PRE-EXISTING
   * and has nothing to do with the colorjs bump — measured directly against
   * colorjs.io 0.5.2 it fails identically, because it is a property of where
   * that palette's neutral 1 and 2 land, not of how their chroma is computed.
   * (The pre-fix form of the guard flattened the ramp to a pure grey, which
   * happened to widen ΔL enough to pass — a false pass on a wrong ramp.)
   *
   * If this list ever changes, do not edit it to match: the grey-neutral
   * palette's compliance profile has genuinely moved and needs a look.
   */
  it("exact-grey neutral palette: clears every guarantee but the known G5a card separation", () => {
    const light = buildThemeSubstrate(ACHROMATIC_NEUTRAL_SEEDS, "light");
    const lightN12 = light.neutralHex[11];
    const failures = [
      ...sweepGuarantees(light, lightN12, "grey/light"),
      ...sweepGuarantees(buildThemeSubstrate(ACHROMATIC_NEUTRAL_SEEDS, "dark"), lightN12, "grey/dark"),
    ];
    expect(failures).toEqual([
      { guarantee: "G5a", cell: "grey/light/card-deltaL", ratio: 0.011, floor: G5A_CARD_SEPARATION.minDeltaL },
      { guarantee: "G5a", cell: "grey/light/card-contrast", ratio: 1.03, floor: G5A_CARD_SEPARATION.minContrast },
    ]);
    // Everything else — G1/G2/G2b/G2c/G4/G5b, both modes — is clean.
    expect(failures.filter((f) => f.guarantee !== "G5a")).toEqual([]);
  });

  it("G2c: the SHIPPED derived --muted-foreground tone clears AA on neutral steps 1–4, both modes, both seeds", () => {
    const seeds = [
      ["default", DEFAULT_CLUB_THEME_VALUES],
      ["synthetic", SYNTHETIC_CLUB_THEME_VALUES],
    ] as const;
    const failures = seeds.flatMap(([name, values]) => {
      const tones = deriveAppMutedForeground(values);
      const s = themeSeedsFromValues(values);
      return [
        ...sweepDerivedMutedForeground(
          tones.light,
          buildThemeSubstrate(s, "light"),
          `${name}/light`,
        ),
        ...sweepDerivedMutedForeground(
          tones.dark,
          buildThemeSubstrate(s, "dark"),
          `${name}/dark`,
        ),
      ];
    });
    // A failing cell reports its exact ratio; asserting on the empty list keeps
    // the numbers in the failure message when CI goes red.
    expect(failures).toEqual([]);
    // Guard against a vacuous pass if the surface reach is ever zeroed.
    expect(DERIVED_MUTED_SURFACE_STEPS).toBeGreaterThanOrEqual(4);
    expect(AA_TEXT).toBe(4.5);
  });

  it("G2b (R11): status-chip text (step-11) clears AA on chip surface (step-3), every scale/mode/seed", () => {
    for (const { theme, label } of allThemes()) {
      for (const [sname, s] of Object.entries(theme.scales)) {
        const ratio = contrast(s.hex[10], s.hex[2]);
        expect(ratio, `G2b ${label}/${sname}`).toBeGreaterThanOrEqual(CHIP_TEXT_FLOOR);
      }
    }
  });

  it("G5a: light-mode card/page separation clears the candidate-ii floor", () => {
    for (const seedName of Object.keys(SEED_SETS) as Array<keyof typeof SEED_SETS>) {
      const light = buildThemeSubstrate(SEED_SETS[seedName], "light");
      const c = Math.round(contrast(light.neutralHex[0], light.neutralHex[1]) * 100) / 100;
      expect(c, seedName).toBeGreaterThanOrEqual(G5A_CARD_SEPARATION.minContrast);
    }
    // J8 pinned shadow is a stable string constant.
    expect(G5A_CARD_SEPARATION.boxShadow).toBe("0 1px 2px 0 #040a054a, 0 1px 3px 0 #020b037b");
  });

  it("G3 distinctness ratio is recorded and positive for every theme", () => {
    for (const { theme, label } of allThemes()) {
      expect(g3Distinctness(theme), `G3 ${label}`).toBeGreaterThan(1);
    }
  });

  it("reproduces the Phase-0 measurements.json guarantee_sweep coverage (all pass:true)", () => {
    const gs = measurements.guarantee_sweep as Record<string, any>;
    const cells: Array<[string, boolean]> = [];
    const visit = (seed: string, mode: string, g: any) => {
      for (const [sname, ps] of Object.entries<any>(g.perScale)) {
        for (const c of ps.G1_foreground_steps1to5) cells.push([`G1/${seed}/${mode}/${sname}/${c.step}`, c.pass]);
        for (const c of ps.G2_mutedFg_steps1to3) cells.push([`G2/${seed}/${mode}/${sname}/${c.step}`, c.pass]);
        if (ps.G4_solid_fg) {
          cells.push([`G4/${seed}/${mode}/${sname}/9`, ps.G4_solid_fg.step9.pass]);
          cells.push([`G4/${seed}/${mode}/${sname}/10`, ps.G4_solid_fg.step10.pass]);
        }
      }
      if (g.G5b_input_ring_vs_surfaces1to3) cells.push([`G5b/${seed}/${mode}`, g.G5b_input_ring_vs_surfaces1to3.pass]);
    };
    // The frozen Phase-0 measurements.json is the sign-off record and still
    // holds every recorded reference seed (including the fork palette shown at
    // sign-off, "fork data ... for sign-off only"); reproduce all of its
    // non-kiosk seeds by key rather than naming any club here (#2190 D15).
    for (const seed of Object.keys(gs).filter((k) => k !== "kiosk"))
      for (const mode of ["light", "dark"]) visit(seed, mode, gs[seed][mode]);
    visit("kiosk", "dark", gs.kiosk.dark);
    const failing = cells.filter(([, pass]) => !pass).map(([k]) => k);
    expect(failing).toEqual([]);
    expect(cells.length).toBeGreaterThan(300); // full coverage, not an empty pass
  });
});
