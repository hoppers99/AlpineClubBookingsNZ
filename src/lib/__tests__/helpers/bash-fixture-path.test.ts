import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import {
  bashFixtureEnv,
  bashFixturePath,
  bashToolArgs,
  PATH_VALUED_ENV_KEYS,
  translateWindowsAbsolutePathForBash,
} from "./bash-fixture-path";

const execFileSyncMock = vi.mocked(execFileSync);

describe("bash fixture path transport (#2886)", () => {
  it("keeps the supported gate path-variable inventory explicit", () => {
    expect([...PATH_VALUED_ENV_KEYS].sort()).toEqual([
      "DATA_MIGRATION_GRANDFATHER_FILE",
      "DATA_MIGRATION_VERIFICATION_DIR",
      "MIGRATIONS_DIR",
      "MIGRATION_SAFETY_LEDGER",
      "SQL_STATEMENT_SPLITTER",
      "VALIDATOR",
    ]);
  });

  it("quotes POSIX tool arguments without relying on bash positional semantics", () => {
    expect(bashToolArgs("awk", ["two words", "it's quoted"])).toEqual([
      "-c",
      `exec 'awk' 'two words' 'it'"'"'s quoted'`,
    ]);
  });

  it("converts every path-valued variable and leaves prose untouched", () => {
    const cwd = process.cwd();
    const fixture = path.join(cwd, "fixtures", "migration.sql");
    const converted = bashFixtureEnv(
      Object.fromEntries([
        ...[...PATH_VALUED_ENV_KEYS].map((key) => [key, fixture]),
        ["BLUE_GREEN_MIGRATION_OVERRIDE_REASON", "keep \\ exactly"],
      ]),
      cwd,
    );

    for (const key of PATH_VALUED_ENV_KEYS) {
      expect(converted[key]).toBe("fixtures/migration.sql");
    }
    expect(converted.BLUE_GREEN_MIGRATION_OVERRIDE_REASON).toBe(
      "keep \\ exactly",
    );
  });

  it("asks the selected bash to translate a cross-volume Windows path", () => {
    execFileSyncMock.mockReturnValue("/mnt/c/Temp/fixture.sql\n" as never);

    expect(
      translateWindowsAbsolutePathForBash(
        "C:\\Temp\\fixture.sql",
        "D:\\repo",
      ),
    ).toBe("/mnt/c/Temp/fixture.sql");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "bash",
      [
        "-c",
        expect.stringContaining("wslpath"),
        "bash-fixture-path",
        "C:/Temp/fixture.sql",
      ],
      expect.objectContaining({ cwd: "D:\\repo", encoding: "utf8" }),
    );
  });

  it("fails clearly when bash cannot produce a POSIX path", () => {
    execFileSyncMock.mockReturnValue("C:/Temp/fixture.sql\n" as never);

    expect(() =>
      translateWindowsAbsolutePathForBash(
        "C:\\Temp\\fixture.sql",
        "D:\\repo",
      ),
    ).toThrow("Cannot translate cross-volume Windows fixture path");
  });

  it.skipIf(process.platform !== "win32")(
    "routes a real cross-drive relative calculation through the translator",
    () => {
      execFileSyncMock.mockReturnValue("/mnt/c/Temp/fixture.sql\n" as never);

      expect(bashFixturePath("C:\\Temp\\fixture.sql", "D:\\repo")).toBe(
        "/mnt/c/Temp/fixture.sql",
      );
    },
  );
});
