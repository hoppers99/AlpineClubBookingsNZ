import { describe, expect, it } from "vitest";
import { escapeCsvCell } from "@/lib/csv";

describe("escapeCsvCell", () => {
  it("leaves a plain cell untouched", () => {
    expect(escapeCsvCell("Alice")).toBe("Alice");
    expect(escapeCsvCell("")).toBe("");
    expect(escapeCsvCell("50.00")).toBe("50.00");
  });

  it("prefixes leading formula characters with a single quote", () => {
    expect(escapeCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(escapeCsvCell("+1")).toBe("'+1");
    expect(escapeCsvCell("-1")).toBe("'-1");
    expect(escapeCsvCell("@handle")).toBe("'@handle");
    expect(escapeCsvCell("\tvalue")).toBe("'\tvalue");
  });

  it("quotes cells containing a comma or embedded quote", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
  });

  it("quotes on a carriage return (not just newline)", () => {
    expect(escapeCsvCell("line1\r")).toBe('"line1\r"');
    expect(escapeCsvCell("line1\n")).toBe('"line1\n"');
  });

  it("applies both the formula guard and quoting for a leading CR", () => {
    // Leading CR is a formula trigger AND forces RFC-4180 quoting.
    expect(escapeCsvCell("\rdanger")).toBe('"\'\rdanger"');
  });
});
