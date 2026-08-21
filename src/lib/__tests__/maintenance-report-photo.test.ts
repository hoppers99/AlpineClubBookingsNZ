import { describe, expect, it } from "vitest";

/**
 * Photo validation for maintenance reports (#2780).
 *
 * The subject is `parseMaintenancePhoto`'s refusal to trust the DECLARED MIME
 * type. On the QR path the declaration is attacker-controlled, so the container
 * is decided by sniffing the decoded bytes and a declaration that disagrees is
 * refused outright rather than quietly corrected.
 *
 * No mocks: the module reads nothing but its argument, so every test here
 * exercises the real code path an unauthenticated submission takes.
 */

import {
  MAX_MAINTENANCE_PHOTOS_PER_REPORT,
  MAX_MAINTENANCE_PHOTO_BYTES,
  MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH,
  MaintenancePhotoError,
  parseMaintenancePhoto,
  sniffMaintenancePhotoContentType,
} from "@/lib/maintenance-report-photo";

/** A real JPEG SOI + APP0 marker start. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
/** The fixed 8-byte PNG signature plus the start of an IHDR chunk. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
/** "RIFF" + a length + "WEBP" + the start of a VP8 chunk. */
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);
/** "RIFF" WITHOUT "WEBP" at offset 8 — this is a WAV, and must not sniff. */
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WAVEfmt ", "latin1"),
]);
/** An SVG document. There is no magic number to sniff, so it must be refused. */
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8",
);

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const READ_FAILURE = "That photo could not be read. Please attach a JPEG, PNG or WebP image.";
const TOO_LARGE = "That photo is too large. Please send one under 4 MB.";

describe("parseMaintenancePhoto — no photo", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("returns null for %s rather than throwing", (_label, value) => {
    expect(parseMaintenancePhoto(value)).toBeNull();
  });
});

describe("parseMaintenancePhoto — the accepted containers", () => {
  it.each([
    ["image/jpeg", JPEG_BYTES, "image/jpeg"],
    ["image/png", PNG_BYTES, "image/png"],
    ["image/webp", WEBP_BYTES, "image/webp"],
  ] as const)(
    "accepts a %s whose bytes agree with its declaration",
    (declared, bytes, expectedType) => {
      const parsed = parseMaintenancePhoto(dataUrl(declared, bytes));

      expect(parsed).not.toBeNull();
      expect(parsed?.contentType).toBe(expectedType);
      expect(parsed?.byteLength).toBe(bytes.length);
    },
  );

  it("normalises a declared image/jpg to image/jpeg when the bytes are a JPEG", () => {
    const parsed = parseMaintenancePhoto(dataUrl("image/jpg", JPEG_BYTES));

    expect(parsed?.contentType).toBe("image/jpeg");
  });

  it("stores a data URL rebuilt from the SNIFFED type, not the caller's string", () => {
    // Declared image/jpg; the stored URL must say image/jpeg, so what the admin
    // page renders matches the content type stored beside it.
    const parsed = parseMaintenancePhoto(dataUrl("image/jpg", JPEG_BYTES));

    expect(parsed?.dataUrl).toBe(
      `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`,
    );
    expect(parsed?.dataUrl.startsWith("data:image/jpg")).toBe(false);
  });

  it("re-encodes the bytes canonically, so odd caller padding is not echoed back", () => {
    // "/w==" and "/w=" decode to the same single byte; only the canonical form
    // may be stored.
    const canonical = dataUrl("image/png", PNG_BYTES);
    const parsed = parseMaintenancePhoto(canonical);

    expect(parsed?.dataUrl).toBe(canonical);
    expect(Buffer.from(parsed!.dataUrl.split(",")[1], "base64")).toEqual(PNG_BYTES);
  });
});

describe("parseMaintenancePhoto — the declaration is never trusted", () => {
  it("refuses PNG bytes declared as image/jpeg", () => {
    expect(() => parseMaintenancePhoto(dataUrl("image/jpeg", PNG_BYTES))).toThrow(
      MaintenancePhotoError,
    );
    expect(() => parseMaintenancePhoto(dataUrl("image/jpeg", PNG_BYTES))).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses JPEG bytes declared as image/png", () => {
    expect(() => parseMaintenancePhoto(dataUrl("image/png", JPEG_BYTES))).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses WebP bytes declared as image/png", () => {
    expect(() => parseMaintenancePhoto(dataUrl("image/png", WEBP_BYTES))).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses an SVG document however it is declared", () => {
    // SVG carries script and has no magic number, so it can only ever be trusted
    // on its declaration — which is the thing this module exists not to do.
    expect(() => parseMaintenancePhoto(dataUrl("image/png", SVG_BYTES))).toThrow(
      READ_FAILURE,
    );
    expect(() => parseMaintenancePhoto(`data:image/svg+xml;base64,${SVG_BYTES.toString("base64")}`)).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses a RIFF container that is not a WebP", () => {
    // "RIFF" alone is also WAV and AVI. Both halves of the WebP signature are
    // checked, so a WAV declared as image/webp is refused.
    expect(sniffMaintenancePhotoContentType(WAV_BYTES)).toBeNull();
    expect(() => parseMaintenancePhoto(dataUrl("image/webp", WAV_BYTES))).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses bytes that sniff as nothing at all", () => {
    const noise = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

    expect(sniffMaintenancePhotoContentType(noise)).toBeNull();
    expect(() => parseMaintenancePhoto(dataUrl("image/png", noise))).toThrow(
      READ_FAILURE,
    );
  });

  it("refuses a truncated signature rather than matching on a prefix", () => {
    // Two bytes of a PNG signature is not a PNG. `startsWith` must compare the
    // whole signature, so a short buffer cannot match.
    expect(sniffMaintenancePhotoContentType(Buffer.from([0x89, 0x50]))).toBeNull();
    // Four bytes of "RIFF" with nothing after it is not a WebP either.
    expect(
      sniffMaintenancePhotoContentType(Buffer.from("RIFF", "latin1")),
    ).toBeNull();
  });
});

describe("parseMaintenancePhoto — malformed envelopes", () => {
  it.each([
    ["a bare string", "not-a-data-url"],
    ["an unsupported image type", `data:image/gif;base64,${PNG_BYTES.toString("base64")}`],
    ["a non-image type", `data:application/pdf;base64,${PNG_BYTES.toString("base64")}`],
    ["a missing base64 marker", `data:image/png,${PNG_BYTES.toString("base64")}`],
    ["a base64 body with an illegal character", "data:image/png;base64,AAAA*AAA"],
    ["a data URL with whitespace in the body", "data:image/png;base64,AAAA AAAA"],
  ])("refuses %s", (_label, value) => {
    expect(() => parseMaintenancePhoto(value)).toThrow(READ_FAILURE);
  });

  it("refuses a body that decodes to zero bytes", () => {
    // A single base64 character matches the alphabet but decodes to nothing.
    expect(Buffer.from("A", "base64").length).toBe(0);
    expect(() => parseMaintenancePhoto("data:image/png;base64,A")).toThrow(
      READ_FAILURE,
    );
  });
});

describe("parseMaintenancePhoto — the size ceiling", () => {
  it("refuses an oversized data URL on its string length, before any decoding", () => {
    const oversized = `data:image/png;base64,${"A".repeat(
      MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH,
    )}`;

    expect(oversized.length).toBeGreaterThan(MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH);
    expect(() => parseMaintenancePhoto(oversized)).toThrow(TOO_LARGE);
  });

  it("refuses decoded bytes over the 4 MB ceiling", () => {
    // Inside the encoded-length ceiling, so this reaches the decoded-length
    // check rather than being caught by the cheaper string-length one.
    const tooManyBytes = Buffer.concat([
      JPEG_BYTES,
      Buffer.alloc(MAX_MAINTENANCE_PHOTO_BYTES + 1 - JPEG_BYTES.length, 0x41),
    ]);
    const url = dataUrl("image/jpeg", tooManyBytes);

    expect(tooManyBytes.length).toBeGreaterThan(MAX_MAINTENANCE_PHOTO_BYTES);
    expect(url.length).toBeLessThanOrEqual(MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH);
    expect(() => parseMaintenancePhoto(url)).toThrow(TOO_LARGE);
  });

  it("accepts a photo exactly on the 4 MB ceiling", () => {
    const exact = Buffer.concat([
      JPEG_BYTES,
      Buffer.alloc(MAX_MAINTENANCE_PHOTO_BYTES - JPEG_BYTES.length, 0x41),
    ]);

    expect(parseMaintenancePhoto(dataUrl("image/jpeg", exact))?.byteLength).toBe(
      MAX_MAINTENANCE_PHOTO_BYTES,
    );
  });

  it("keeps the encoded ceiling above the decoded one by the base64 inflation", () => {
    // If the encoded ceiling were the tighter of the two, the decoded check
    // below it would be unreachable and a 4 MB photo would be refused.
    expect(MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH).toBeGreaterThan(
      MAX_MAINTENANCE_PHOTO_BYTES,
    );
    expect(MAX_MAINTENANCE_PHOTO_BYTES).toBe(4_000_000);
  });

  it("allows exactly one photo per report", () => {
    expect(MAX_MAINTENANCE_PHOTOS_PER_REPORT).toBe(1);
  });
});

describe("parseMaintenancePhoto — what the submitter is told", () => {
  it("says nothing about the server in any refusal", () => {
    const attempts = [
      "not-a-data-url",
      dataUrl("image/png", JPEG_BYTES),
      dataUrl("image/webp", WAV_BYTES),
      "data:image/png;base64,A",
    ];

    for (const attempt of attempts) {
      let message = "";
      try {
        parseMaintenancePhoto(attempt);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      // Every message is one of the two submitter-safe sentences, so a refusal
      // cannot become an oracle for which check tripped.
      expect([READ_FAILURE, TOO_LARGE]).toContain(message);
    }
  });

  it("collapses every mismatch reason to the SAME message", () => {
    // A distinct message per branch would tell a prober whether their bytes
    // sniffed, which is more than the form needs to say.
    const messages = new Set(
      [
        dataUrl("image/png", JPEG_BYTES),
        dataUrl("image/jpeg", PNG_BYTES),
        dataUrl("image/png", SVG_BYTES),
        dataUrl("image/webp", WAV_BYTES),
      ].map((attempt) => {
        try {
          parseMaintenancePhoto(attempt);
          return "accepted";
        } catch (err) {
          return (err as Error).message;
        }
      }),
    );

    expect([...messages]).toEqual([READ_FAILURE]);
  });
});
