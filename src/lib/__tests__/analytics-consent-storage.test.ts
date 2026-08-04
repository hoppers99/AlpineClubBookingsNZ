// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  LEGACY_ANALYTICS_CONSENT_STORAGE_KEY,
  readStoredConsent,
  writeStoredConsent,
} from "@/lib/analytics-consent-storage";

/**
 * Where a visitor's analytics choice lives (#2573). `localStorage` only: the choice
 * never leaves the browser it was made in, so there is nothing here to audit or
 * expose.
 *
 * The read has to fail CLOSED — an unreadable or corrupt value is "no choice
 * recorded", which in banner-enabled mode shows the banner again rather than
 * assuming consent.
 */

/**
 * Block one `localStorage` method the way a storage-refusing browser does.
 *
 * It has to be `Storage.prototype` and NOT `window.localStorage`. jsdom implements
 * `localStorage` as a Proxy whose traps forward to the prototype methods, so
 * `vi.spyOn(window.localStorage, "setItem")` installs a property the proxy never
 * consults: the mock is never called and the real store answers normally.
 *
 * That is not a hypothetical tidy-up. Two tests in this file used the instance seam
 * and passed VACUOUSLY — one asserted a call "does not throw" when nothing was
 * throwing, and the other asserted a null read that was already null because the
 * store was empty. Measured, not assumed: with the instance spy installed, a direct
 * `window.localStorage.setItem` does not throw; with this one, it does.
 */
function blockStorage(method: "getItem" | "setItem" | "removeItem") {
  return vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new Error("SecurityError: storage is not available");
  });
}

describe("readStoredConsent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredConsent()).toBeNull();
  });

  it("round-trips a written record", () => {
    writeStoredConsent({ choice: "accepted", revision: 4, source: "banner" });
    expect(readStoredConsent()).toEqual({
      choice: "accepted",
      revision: 4,
      source: "banner",
    });
  });

  it("keeps the source, because banner-off mode depends on telling the two apart", () => {
    writeStoredConsent({
      choice: "declined",
      revision: 2,
      source: "preferences",
    });
    expect(readStoredConsent()?.source).toBe("preferences");
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a bare legacy string under the v2 key", '"accepted"'],
    ["an unknown choice", '{"choice":"maybe","revision":1,"source":"banner"}'],
    ["an unknown source", '{"choice":"accepted","revision":1,"source":"api"}'],
    ["a missing revision", '{"choice":"accepted","source":"banner"}'],
    [
      "a non-integer revision",
      '{"choice":"accepted","revision":1.5,"source":"banner"}',
    ],
    [
      "a revision below one",
      '{"choice":"accepted","revision":0,"source":"banner"}',
    ],
    ["null", "null"],
  ])("treats %s as no record rather than as consent", (_label, raw) => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, raw);
    expect(readStoredConsent()).toBeNull();
  });

  it("does not fall back to the legacy key when a v2 value is present but corrupt", () => {
    // Otherwise a corrupt v2 write would silently resurrect a much older choice.
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "{broken");
    window.localStorage.setItem(
      LEGACY_ANALYTICS_CONSENT_STORAGE_KEY,
      "accepted",
    );
    expect(readStoredConsent()).toBeNull();
  });

  it("returns null rather than throwing when storage itself throws", () => {
    // Private browsing and storage-partitioned contexts throw on access; the
    // fail-closed answer is "no choice", which re-shows the banner.
    //
    // A record is written FIRST, so the null answer can only come from the caught
    // throw. Without it this passes on an empty store whether or not the block is
    // in force — which is exactly how it used to pass.
    writeStoredConsent({ choice: "accepted", revision: 1, source: "banner" });
    expect(readStoredConsent()).not.toBeNull();

    const spy = blockStorage("getItem");
    try {
      expect(readStoredConsent()).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // …and the record was there all along, so nothing else explains the null.
    expect(readStoredConsent()).not.toBeNull();
  });
});

describe("migrating the pre-#2573 record", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(["accepted", "declined"] as const)(
    "reads a v1 %s as a banner-sourced choice at revision 1",
    (choice) => {
      window.localStorage.setItem(LEGACY_ANALYTICS_CONSENT_STORAGE_KEY, choice);
      // Revision 1 is where an untouched club still is, so a visitor who answered the
      // old hard-coded banner is not re-prompted for no reason. `banner` is where the
      // choice was actually made, which is what makes a v1 DECLINE invalidate when the
      // banner is switched off.
      expect(readStoredConsent()).toEqual({
        choice,
        revision: 1,
        source: "banner",
      });
    },
  );

  it("ignores an unrecognised legacy value", () => {
    window.localStorage.setItem(LEGACY_ANALYTICS_CONSENT_STORAGE_KEY, "yes");
    expect(readStoredConsent()).toBeNull();
  });

  it("clears the legacy key on the first write, so a bump cannot be undone", () => {
    window.localStorage.setItem(
      LEGACY_ANALYTICS_CONSENT_STORAGE_KEY,
      "accepted",
    );
    writeStoredConsent({ choice: "declined", revision: 5, source: "banner" });
    expect(
      window.localStorage.getItem(LEGACY_ANALYTICS_CONSENT_STORAGE_KEY),
    ).toBeNull();
    expect(readStoredConsent()).toEqual({
      choice: "declined",
      revision: 5,
      source: "banner",
    });
  });
});

describe("writeStoredConsent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("swallows a storage failure rather than breaking the page", () => {
    const spy = blockStorage("setItem");
    try {
      expect(() =>
        writeStoredConsent({
          choice: "accepted",
          revision: 1,
          source: "banner",
        }),
      ).not.toThrow();
      // The block really was in force: without this the "does not throw" above is
      // satisfied by a write that simply succeeded.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports true when the value landed", () => {
    expect(
      writeStoredConsent({
        choice: "declined",
        revision: 1,
        source: "preferences",
      }),
    ).toBe(true);
  });

  /*
    The return value is the whole point, not a convenience.

    A storage-blocked browser throws on the read as well as the write, so the
    choice cannot come back on the next page load. In banner-ENABLED mode that is
    fail-closed and needs nothing said (the banner asks again and nothing loads).
    In banner-DISABLED mode `resolveAnalyticsDecision` answers "allowed" with no
    stored record, so a preferences opt-out would hold for one page and then
    silently stop holding while the panel had just promised it would stop further
    collection from this browser. Reporting the refusal is what lets the panel say
    so instead of asserting something untrue — see the module header.
  */
  it("reports false when the browser refuses the write", () => {
    const spy = blockStorage("setItem");
    try {
      expect(
        writeStoredConsent({
          choice: "declined",
          revision: 1,
          source: "preferences",
        }),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("still reports true when only the legacy cleanup fails", () => {
    // The v2 value landed, which is the fact the caller acts on; a browser that
    // refuses `removeItem` has no v1 value to remove either, and the v2 record wins
    // on the next read regardless.
    const spy = blockStorage("removeItem");
    try {
      expect(
        writeStoredConsent({
          choice: "accepted",
          revision: 3,
          source: "banner",
        }),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
