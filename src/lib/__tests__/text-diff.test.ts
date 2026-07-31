import { describe, expect, it } from "vitest";
import {
  diffLines,
  isSameText,
  markInvisibleCharacters,
} from "@/lib/text-diff";

// #2269 (F3). The email template editor shows this diff to an admin who is
// deciding whether to keep their saved wording or press Restore Default, so a
// diff that invents a change (or hides one) is a decision made on bad
// information.

function render(before: string, after: string): string {
  return diffLines(before, after)
    .map(
      (line) =>
        `${line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}${line.value}`,
    )
    .join("\n");
}

describe("diffLines", () => {
  it("reports no change at all for identical text", () => {
    const text = "Booking Confirmed\n\nHi {{firstName}}.";
    expect(diffLines(text, text).every((line) => line.type === "equal")).toBe(true);
  });

  it("marks a changed line as one removal and one addition, in place", () => {
    expect(
      render(
        "Hi {{firstName}}.\nDoor code: {{doorCode}}\nSee you soon.",
        "Hi {{firstName}}.\n{{doorCodeNote}}\nSee you soon.",
      ),
    ).toBe(
      [
        " Hi {{firstName}}.",
        "-Door code: {{doorCode}}",
        "+{{doorCodeNote}}",
        " See you soon.",
      ].join("\n"),
    );
  });

  it("keeps the shared lines shared when a block is inserted", () => {
    expect(render("a\nb", "a\nnew\nb")).toBe([" a", "+new", " b"].join("\n"));
  });

  it("keeps the shared lines shared when a block is deleted", () => {
    expect(render("a\ngone\nb", "a\nb")).toBe([" a", "-gone", " b"].join("\n"));
  });

  it("treats a trailing newline as no difference", () => {
    // A textarea round-trip routinely adds or drops one, and reporting that as
    // a change would put a red line on every override.
    expect(diffLines("a\nb\n", "a\nb").every((line) => line.type === "equal")).toBe(
      true,
    );
    expect(isSameText("a\nb\n", "a\nb")).toBe(true);
  });

  it("treats CRLF and LF as the same text", () => {
    expect(
      diffLines("a\r\nb", "a\nb").every((line) => line.type === "equal"),
    ).toBe(true);
    expect(isSameText("a\r\nb", "a\nb")).toBe(true);
  });

  it("handles an empty side without inventing a blank line", () => {
    expect(render("", "hello")).toBe("+hello");
    expect(render("hello", "")).toBe("-hello");
    expect(diffLines("", "")).toEqual([]);
  });

  it("never loses content: every line of both sides appears exactly once", () => {
    const before = "one\ntwo\nthree\nfour";
    const after = "one\ntwo point five\nthree\nfive";
    const lines = diffLines(before, after);
    expect(
      lines
        .filter((line) => line.type !== "added")
        .map((line) => line.value)
        .join("\n"),
    ).toBe(before);
    expect(
      lines
        .filter((line) => line.type !== "removed")
        .map((line) => line.value)
        .join("\n"),
    ).toBe(after);
  });

  it("normalises a lone carriage return as a line break", () => {
    // \r\n was already handled; a lone \r (an old-Mac paste, or a value that
    // has been through a tool that rewrote line endings) would otherwise
    // arrive as one enormous single line and diff as "everything replaced".
    // This repo has had a real CRLF incident (#2399).
    expect(isSameText("one\rtwo", "one\ntwo")).toBe(true);
    expect(diffLines("one\rtwo", "one\ntwo")).toEqual([
      { type: "equal", value: "one" },
      { type: "equal", value: "two" },
    ]);
  });

  it("does not show two visually identical lines as a change", () => {
    // "é" as one code point and as "e" + combining acute look the same on
    // screen. Without normalising, the diff shows a removed line and an added
    // line that an admin cannot tell apart, which reads as a broken diff.
    const composed = "Café open at 7";
    const decomposed = "Café open at 7";
    expect(composed).not.toBe(decomposed);
    expect(isSameText(composed, decomposed)).toBe(true);
    expect(diffLines(composed, decomposed)).toEqual([
      { type: "equal", value: composed },
    ]);
  });

  it("marks trailing whitespace so a whitespace-only change is visible", () => {
    expect(markInvisibleCharacters("Total:  ")).toBe("Total:··");
    expect(markInvisibleCharacters("Total:\t")).toBe("Total:→");
    // Interior spacing is left exactly as written — the defaults padded their
    // notes into a column, and turning that into dots would be unreadable.
    expect(markInvisibleCharacters("Total:  x")).toBe("Total:  x");
    expect(markInvisibleCharacters("Total: x")).toBe("Total: x");
  });

  it("degrades to a whole-block replacement rather than hanging on huge input", () => {
    const before = Array.from({ length: 1600 }, (_, i) => `before ${i}`).join("\n");
    const after = Array.from({ length: 1600 }, (_, i) => `after ${i}`).join("\n");
    const lines = diffLines(before, after);
    expect(lines).toHaveLength(3200);
    expect(lines.some((line) => line.type === "equal")).toBe(false);
  });
});
