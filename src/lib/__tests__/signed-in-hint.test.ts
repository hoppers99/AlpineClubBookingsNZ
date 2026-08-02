import { describe, expect, it } from "vitest";

import {
  hasSignedInHint,
  SIGNED_IN_HINT_COOKIE,
  SIGNED_IN_HINT_MAX_AGE_SECONDS,
  SIGNED_IN_HINT_VALUE,
} from "@/lib/signed-in-hint";

/**
 * The non-secret sign-in marker cookie (#2352 D2).
 *
 * Read strictly, and the strictness is the point rather than fussiness: this value
 * decides which of two link labels a visitor sees, so a loose match would be a
 * behaviour a stranger could trigger by naming an unrelated cookie carefully.
 */
describe("hasSignedInHint", () => {
  it("reads the cookie whether it stands alone or sits among others", () => {
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`)).toBe(
      true,
    );
    expect(
      hasSignedInHint(
        `theme=dark; ${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}; other=1`,
      ),
    ).toBe(true);
    // `document.cookie` and a `Cookie` header both use "; ", but a client may send
    // ";" with no space.
    expect(
      hasSignedInHint(`theme=dark;${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`),
    ).toBe(true);
  });

  it("is false for absent, empty and malformed cookie strings", () => {
    expect(hasSignedInHint(undefined)).toBe(false);
    expect(hasSignedInHint(null)).toBe(false);
    expect(hasSignedInHint("")).toBe(false);
    expect(hasSignedInHint("nonsense")).toBe(false);
    expect(hasSignedInHint(";;;")).toBe(false);
  });

  it("refuses a value other than the one exact value", () => {
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=`)).toBe(false);
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=0`)).toBe(false);
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=true`)).toBe(false);
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=11`)).toBe(false);
  });

  it("refuses a cookie whose NAME merely contains the hint's name", () => {
    expect(
      hasSignedInHint(`x-${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}`),
    ).toBe(false);
    expect(
      hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}-shadow=${SIGNED_IN_HINT_VALUE}`),
    ).toBe(false);
  });

  it("refuses another cookie whose VALUE spells out the hint", () => {
    // The bug a whole-string regex would have: an unrelated cookie carrying the
    // text is not the hint.
    expect(
      hasSignedInHint(
        `decoy=${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}; theme=dark`,
      ),
    ).toBe(false);
  });

  it("carries one bit and nothing else", () => {
    // Not a style preference: the whole safety argument for a non-HttpOnly,
    // forgeable cookie is that there is nothing in it to leak and nothing in it to
    // authenticate with.
    expect(SIGNED_IN_HINT_VALUE).toBe("1");
    expect(SIGNED_IN_HINT_COOKIE).toBe("signed-in-hint");
    expect(SIGNED_IN_HINT_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
  });
});
