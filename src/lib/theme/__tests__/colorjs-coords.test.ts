import { describe, expect, it } from "vitest";
import Color from "colorjs.io";
import {
  buildNeutralRamp,
  buildThemeSubstrate,
  contrast,
  fromOklch,
  oklch,
} from "../theme-substrate";

/*
 * colorjs.io missing-coordinate contract (#2303).
 *
 * colorjs.io 0.5.2 typed every colour coordinate as `number` and reported the hue
 * of an achromatic colour as `NaN`. From 0.6 a coordinate is `number | null`,
 * where `null` is a CSS Color 4 "none" (missing) component — and an achromatic
 * oklch conversion now yields a null hue and an exactly-zero chroma.
 *
 * The substrate is not allowed to notice: `generator-goldens.test.ts` pins every
 * shipping hex, and the 0.5.2 -> 0.7.1 bump left all of them byte-identical. This
 * suite pins the layer underneath that — the primitives in `theme-substrate.ts`
 * that had to be taught about `null` — so a future colorjs bump that changes how
 * a missing component is reported fails here, in the one place that explains it,
 * rather than as a wall of golden diffs.
 */

const ACHROMATIC = ["#ffffff", "#000000", "#808080", "#7f7f7f", "#010101"];

/** colorjs shortens `#ffffff` to `#fff`; compare colours, not spellings. */
const expandHex = (hex: string): string =>
  hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;

describe("colorjs.io missing-coordinate handling", () => {
  it("the library really does report a missing hue as null, not NaN", () => {
    // Guards the assumption every helper below is written against. If a future
    // colorjs release goes back to NaN (or invents a third spelling), this fails
    // first and points at the reason.
    for (const hex of ACHROMATIC) {
      const [, chroma, hue] = new Color(hex).to("oklch").coords;
      expect(hue, `${hex} hue`).toBeNull();
      expect(chroma, `${hex} chroma`).toBe(0);
    }
    const [, , chromaticHue] = new Color("#57b3ab").to("oklch").coords;
    expect(typeof chromaticHue).toBe("number");
  });

  it("oklch() normalises a missing hue to 0 and never leaks null or NaN", () => {
    for (const hex of [...ACHROMATIC, "#57b3ab", "#17231c", "#b04d28"]) {
      const coords = oklch(hex);
      expect(coords, `${hex} arity`).toHaveLength(3);
      for (const [i, coord] of coords.entries()) {
        expect(coord, `${hex} coord ${i}`).toBeTypeOf("number");
        expect(Number.isNaN(coord), `${hex} coord ${i} is NaN`).toBe(false);
      }
    }
    // 0 is the behaviour-preserving read: 0.5.2 handed the NaN hue to fromOklch,
    // which folded it to 0 before building the colour.
    expect(oklch("#808080")[2]).toBe(0);
  });

  it("oklch() still reports lightness/chroma/hue for a chromatic colour", () => {
    const [L, C, H] = oklch("#57b3ab");
    expect(L).toBeCloseTo(0.7083624772026524, 12);
    expect(C).toBeCloseTo(0.08870517261974413, 12);
    expect(H).toBeCloseTo(187.8325373912753, 10);
  });

  it("fromOklch() folds a NaN hue rather than emitting #NaNNaNNaN", () => {
    // Load-bearing under 0.7: `new Color("oklch", [L, C, NaN])` now serialises to
    // the literal string "#NaNNaNNaN", where 0.5.2 quietly treated it as no hue.
    // Dropping the isNaN guard in fromOklch would ship that string as CSS.
    expect(new Color("oklch", [0.5, 0.008, NaN]).to("srgb").toString({ format: "hex" })).toContain(
      "NaN",
    );
    expect(fromOklch(0.5, 0.008, NaN)).toBe(fromOklch(0.5, 0.008, 0));
    expect(fromOklch(0.5, 0.008, NaN)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("a missing hue and an explicit 0 hue round-trip to the same colour", () => {
    // Why coalescing to 0 is safe rather than merely convenient: colorjs renders
    // `oklch(L C none)` identically to `oklch(L C 0)`.
    const none = new Color("oklch", [0.5, 0.008, null]).to("srgb").toString({ format: "hex" });
    expect(fromOklch(0.5, 0.008, 0)).toBe(none);
    for (const hex of ACHROMATIC) {
      const [L, C, H] = oklch(hex);
      expect(expandHex(fromOklch(L, C, H)), `${hex} round-trip`).toBe(hex);
    }
  });

  it("contrast() is unaffected by achromatic inputs", () => {
    expect(contrast("#ffffff", "#000000")).toBe(21);
    expect(contrast("#808080", "#ffffff")).toBeCloseTo(3.9494396480491156, 12);
    expect(contrast("#808080", "#000000")).toBeCloseTo(5.317210002277984, 12);
    expect(contrast("#57b3ab", "#ffffff")).toBeCloseTo(2.4877560784869486, 12);
  });
});

describe("the achromatic reference ramp (#2303)", () => {
  /*
   * Radix ships six reference gray ramps, of which only `gray` is PERFECTLY
   * achromatic. Whenever `gray` is the closest reference ramp to a seed, the
   * generator's chroma rescale in `getScaleFromColor` divides by a chroma of
   * exactly 0. colorjs 0.5.2 never quite said zero — it left ~1e-16 of float
   * noise there — so the ratio came out ~1e14, the rescaled term dwarfed the
   * `sourceC * 1.5` cap, and `Math.min` returned the cap for every step. 0.7.x
   * reports a true 0, so the ratio is Infinity, `0 * Infinity` is NaN, and every
   * step serialises to the literal string "#NaNNaNNaN", which throws on reparse.
   *
   * The guard takes the cap directly, which is exactly the limit 0.5.2 landed
   * on. What matters — and what these tests exist to pin — is WHICH seeds reach
   * that branch. It is NOT only exact greys: any seed of low enough chroma is
   * closest to `gray`, and reading the guard as "this must be a grey, so make
   * the ramp grey" silently strips the hue off desaturated brand colours in
   * BOTH modes. Each test below states which arm it covers.
   */
  const SEEDS = (over: Partial<Record<"accent" | "neutralSource", string>>) => ({
    accent: "#57b3ab",
    neutralSource: "#17231c",
    support: "#b04d28",
    ...over,
  });

  /*
   * Every exactly-grey neutral-character seed derives the SAME gray seed, because
   * `deriveGrayAndBg` keeps only the seed's hue and an achromatic seed has none
   * (it coalesces to 0). So all of these produce one identical ramp.
   */
  const GREY_SEEDS = ["#000000", "#010101", "#767676", "#7f7f7f", "#8f8f8f", "#fefefe", "#ffffff"];

  it("build a valid ramp instead of #NaNNaNNaN", () => {
    for (const neutralSource of GREY_SEEDS) {
      for (const mode of ["light", "dark"] as const) {
        const ramp = buildNeutralRamp(SEEDS({ neutralSource }), mode);
        expect(ramp, `${neutralSource}/${mode}`).toHaveLength(12);
        for (const step of ramp) {
          expect(step, `${neutralSource}/${mode}`).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        }
      }
    }
  });

  it("keep the substrate's own neutral tint on an exact-grey seed", () => {
    /*
     * The ramp an exact grey derives is NOT itself grey, and never was. The
     * substrate does not feed the seed to the generator: `deriveGrayAndBg`
     * rebuilds a gray seed at the pinned `PINS.neutralSeed` chroma (0.008) on
     * the seed's hue, and an achromatic seed's hue coalesces to 0. So the ramp
     * carries a faint warm cast by construction — the pin's doing, not a
     * rounding artefact. These are the hexes colorjs 0.5.2 shipped (steps 1, 2,
     * 3, 5, 8 and 10 byte-identical; the rest within a few 1/255ths, because
     * 0.5.2's per-step values were derived from float noise and cannot be
     * reproduced exactly).
     */
    const expected = [
      "#fef4f7", "#fbf0f3", "#f1e6ea", "#e9dee2", "#e1d7da", "#d9ced2",
      "#cec4c7", "#bab0b4", "#8d8386", "#82797c", "#645b5e", "#251e20",
    ];
    for (const neutralSource of GREY_SEEDS) {
      const ramp = buildNeutralRamp(SEEDS({ neutralSource }), "light");
      expect(ramp, neutralSource).toEqual(expected);
      for (const step of ramp) {
        const [, chroma] = oklch(step);
        // Tinted, but only just: the pin is 0.008, capped at 1.5x = 0.012.
        expect(chroma, `${neutralSource} ${step} chroma`).toBeGreaterThan(0.005);
        expect(chroma, `${neutralSource} ${step} chroma`).toBeLessThan(0.02);
      }
    }
    // Dark mode reaches the same branch and is likewise unchanged from 0.5.2.
    expect(buildNeutralRamp(SEEDS({ neutralSource: "#808080" }), "dark")).toEqual([
      "#171616", "#1e1c1d", "#262525", "#2d2a2b", "#343132", "#3d3a3b",
      "#4b4748", "#645e60", "#736c6f", "#807a7c", "#b8b2b4", "#efeeee",
    ]);
  });

  it("keep a low-chroma CHROMATIC seed's hue instead of flattening it to grey", () => {
    /*
     * The boundary the guard must not overreach. #805562 is a dusty rose
     * (oklch C 0.060) and #6b7373 a muted slate-teal (oklch C 0.0097) — both
     * carry a real, chosen hue, and both are close enough to Radix's `gray`
     * ramp to reach the achromatic branch. Reading that branch as "make it
     * grey" turned #805562's light neutral ramp into #f7f7f7/#f3f3f3/#e9e9e9
     * and collapsed #6b7373's accent ramp to grey in BOTH modes. Every hex
     * below is the value colorjs 0.5.2 produced or within a few 1/255ths of it,
     * and every step still carries the seed's hue.
     */
    expect(buildNeutralRamp(SEEDS({ neutralSource: "#805562" }), "light")).toEqual([
      "#fef4f7", "#fbf0f3", "#f1e6ea", "#e9dee2", "#e1d7da", "#d9ced2",
      "#cec4c7", "#bab0b4", "#8d8386", "#82797c", "#645b5e", "#251e20",
    ]);

    const accentRamp = (mode: "light" | "dark") =>
      buildThemeSubstrate(SEEDS({ accent: "#6b7373" }), mode).scales.accent.hexRaw;

    expect(accentRamp("light")).toEqual([
      "#ecfafa", "#e9f6f6", "#dfeded", "#d7e4e4", "#cfdddd", "#c7d5d5",
      "#bccaca", "#a9b6b6", "#6b7373", "#5b6767", "#556060", "#182222",
    ]);
    expect(accentRamp("dark")).toEqual([
      "#0f1919", "#151f20", "#1d2828", "#232e2e", "#2a3535", "#323d3d",
      "#404b4b", "#576363", "#6b7373", "#5b6767", "#aab7b7", "#e4f1f1",
    ]);

    // The seed's own hue survives on every step of both modes; a grey ramp
    // would report a missing hue instead.
    const [, , seedHue] = oklch("#6b7373");
    for (const mode of ["light", "dark"] as const) {
      for (const step of accentRamp(mode)) {
        const [, chroma, hue] = new Color(step).to("oklch").coords;
        expect(chroma, `${mode} ${step} chroma`).toBeGreaterThan(0.005);
        expect(hue, `${mode} ${step} hue`).not.toBeNull();
        expect(Math.abs((hue ?? 0) - seedHue), `${mode} ${step} hue drift`).toBeLessThan(10);
      }
    }
  });

  it("still flatten a seed whose chroma is genuinely zero", () => {
    /*
     * The other arm. An accent seed reaches the generator unmodified, so an
     * exact grey really does arrive with chroma 0 — the cap is then 0 and the
     * ramp is honestly grey. This is also why "#NaNNaNNaN" is now unreachable:
     * the guard never divides. 0.5.2 produced these same hexes.
     */
    for (const mode of ["light", "dark"] as const) {
      const ramp = buildThemeSubstrate(SEEDS({ accent: "#808080" }), mode).scales.accent.hexRaw;
      for (const step of ramp) {
        expect(oklch(step)[1], `${mode} ${step} chroma`).toBeLessThan(1e-9);
      }
    }
    expect(buildThemeSubstrate(SEEDS({ accent: "#808080" }), "light").scales.accent.hexRaw).toEqual([
      "#f7f7f7", "#f3f3f3", "#e9e9e9", "#e1e1e1", "#dadada", "#d1d1d1",
      "#c6c6c6", "#b3b3b3", "#808080", "#737373", "#5e5e5e", "#202020",
    ]);
  });

  it("leave a chromatic neutral-character seed exactly where 0.5.2 left it", () => {
    // The shipping default seed, whose closest reference ramp is one of Radix's
    // TINTED grays — so it never reaches the guard at all. Pinned against the
    // 0.5.2 output, so the branch cannot quietly start firing more widely.
    expect(buildNeutralRamp(SEEDS({}), "light")).toEqual([
      "#f6f8f7", "#f2f4f2", "#e9ebe9", "#e0e3e1", "#d8dbd9", "#d0d3d0",
      "#c5c8c5", "#b1b5b2", "#818782", "#767c78", "#595e5a", "#1c211d",
    ]);
  });
});
