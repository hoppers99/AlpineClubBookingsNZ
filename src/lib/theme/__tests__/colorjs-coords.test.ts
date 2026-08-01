import { describe, expect, it } from "vitest";
import Color from "colorjs.io";
import { buildNeutralRamp, contrast, fromOklch, oklch } from "../theme-substrate";

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

describe("achromatic neutral-character seeds (#2303)", () => {
  /*
   * A neutral-character seed with r == g == b lands on Radix's perfectly
   * achromatic `gray` reference ramp, so the generator's chroma rescale divides
   * by a chroma of exactly 0. Under colorjs 0.5.2 that division saw ~1e-16 of
   * float noise instead of a true zero and produced a faintly pink ramp; under
   * 0.7.x it is 0/0, and without the `ratioC` guard in `getScaleFromColor` every
   * step serialises to the literal string "#NaNNaNNaN" and the next parse throws.
   *
   * Removing that guard fails all three assertions below.
   */
  const GREY_SEEDS = ["#000000", "#010101", "#767676", "#7f7f7f", "#8f8f8f", "#fefefe", "#ffffff"];

  it("build a valid ramp instead of #NaNNaNNaN", () => {
    for (const neutralSource of GREY_SEEDS) {
      for (const mode of ["light", "dark"] as const) {
        const ramp = buildNeutralRamp(
          { accent: "#57b3ab", neutralSource, support: "#b04d28" },
          mode,
        );
        expect(ramp, `${neutralSource}/${mode}`).toHaveLength(12);
        for (const step of ramp) {
          expect(step, `${neutralSource}/${mode}`).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        }
      }
    }
  });

  it("produce a genuinely neutral light ramp, not a noise-tinted one", () => {
    // The pinned light ramp every achromatic seed now derives. 0.5.2 returned
    // #fef4f7 / #8b8486 / #211f20 here — a pink cast that came from float noise,
    // not from the seed.
    const expected = [
      "#f7f7f7", "#f3f3f3", "#e9e9e9", "#e1e1e1", "#dadada", "#d1d1d1",
      "#c7c7c7", "#b3b3b3", "#868686", "#7b7b7b", "#5e5e5e", "#202020",
    ];
    for (const neutralSource of GREY_SEEDS) {
      const ramp = buildNeutralRamp(
        { accent: "#57b3ab", neutralSource, support: "#b04d28" },
        "light",
      );
      expect(ramp, neutralSource).toEqual(expected);
      for (const step of ramp) {
        const [, chroma] = oklch(step);
        expect(chroma, `${neutralSource} ${step} chroma`).toBeLessThan(0.001);
      }
    }
  });

  it("leave a chromatic neutral-character seed exactly where 0.5.2 left it", () => {
    // The shipping default seed. Pinned against the 0.5.2 output, so the guard
    // above cannot quietly start firing on palettes that do have a hue.
    expect(buildNeutralRamp({ accent: "#57b3ab", neutralSource: "#17231c", support: "#b04d28" }, "light")).toEqual([
      "#f6f8f7", "#f2f4f2", "#e9ebe9", "#e0e3e1", "#d8dbd9", "#d0d3d0",
      "#c5c8c5", "#b1b5b2", "#818782", "#767c78", "#595e5a", "#1c211d",
    ]);
  });
});
