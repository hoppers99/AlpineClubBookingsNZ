import { describe, expect, it } from "vitest";
import { diffLines, isSameText } from "@/lib/text-diff";

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

  it("degrades to a whole-block replacement rather than hanging on huge input", () => {
    const before = Array.from({ length: 1600 }, (_, i) => `before ${i}`).join("\n");
    const after = Array.from({ length: 1600 }, (_, i) => `after ${i}`).join("\n");
    const lines = diffLines(before, after);
    expect(lines).toHaveLength(3200);
    expect(lines.some((line) => line.type === "equal")).toBe(false);
  });
});
