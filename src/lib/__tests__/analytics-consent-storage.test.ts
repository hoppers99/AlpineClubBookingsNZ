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
    const spy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      expect(readStoredConsent()).toBeNull();
    } finally {
      spy.mockRestore();
    }
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
    const spy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      expect(() =>
        writeStoredConsent({
          choice: "accepted",
          revision: 1,
          source: "banner",
        }),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
