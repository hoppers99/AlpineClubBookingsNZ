import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareFragmentNames,
  compileChangelog,
  parseArgs,
  POINTER_NOTE_END,
  POINTER_NOTE_START,
  readFragments,
  todayInNewZealand,
} from "./compile-changelog.mjs";

const NOTE_BODY = "Entries for the next release live in `changelog.d/` — one file per PR.";
/** The note exactly as CHANGELOG.md carries it: prose inside its sentinels. */
const NOTE = [POINTER_NOTE_START, "", NOTE_BODY, "", POINTER_NOTE_END].join("\n");

const HISTORY = [
  "## 0.13.2 - 2026-07-23",
  "",
  "- **An older, already released entry (#1234).** Historical text that must be",
  "  copied through untouched.",
  "",
].join("\n");

function changelogWith(unreleasedBody) {
  return [
    "# Changelog",
    "",
    "All notable public reference-release changes should be recorded here.",
    "",
    "## Unreleased",
    "",
    NOTE,
    ...(unreleasedBody ? ["", unreleasedBody] : []),
    "",
    HISTORY,
  ].join("\n");
}

const tempRoots = [];

/** Build a throwaway repo root with a CHANGELOG.md and a changelog.d/ dir. */
function makeRepo({ changelog = changelogWith(""), fragments = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compile-changelog-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  const dir = path.join(root, "changelog.d");
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

function read(root) {
  return fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
}

function fragmentFiles(root) {
  return fs.readdirSync(path.join(root, "changelog.d")).sort();
}

function silentLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  log.text = () => lines.join("\n");
  return log;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("compile-changelog", () => {
  it("compiles fragments into a new release section and deletes them", () => {
    const root = makeRepo({
      fragments: {
        "2448-tolerant-reads.md": "- **Booking requests tolerate a slow read (#2448).** Body.\n",
        "2452-changelog-fragments.md": "- **Changelog entries move to fragments (#2452).** Body.\n",
        "README.md": "# How to write a fragment\n",
        ".gitkeep": "",
      },
    });
    const log = silentLog();

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(result.written).toBe(true);
    expect(result.fragments).toEqual([
      "2448-tolerant-reads.md",
      "2452-changelog-fragments.md",
    ]);
    const compiled = read(root);
    expect(compiled).toContain("## 0.14.0 - 2026-08-04");
    expect(compiled).toContain("- **Booking requests tolerate a slow read (#2448).** Body.");
    expect(compiled).toContain("- **Changelog entries move to fragments (#2452).** Body.");
    // The Unreleased heading and its pointer note survive, with no entries left.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0 - 2026-08-04`);
    // History is copied through byte-for-byte.
    expect(compiled.slice(compiled.indexOf("## 0.13.2"))).toBe(`${HISTORY.trimEnd()}\n`);
    // Consumed fragments are gone; the convention files stay.
    expect(fragmentFiles(root)).toEqual([".gitkeep", "README.md"]);
    expect(log.text()).toContain("Compiled and deleted 2 fragment(s)");
  });

  it("orders fragments by PR number, not by string comparison", () => {
    const root = makeRepo({
      fragments: {
        "2448-later.md": "- **Later PR (#2448).**\n",
        "999-earlier.md": "- **Earlier PR (#999).**\n",
      },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    expect(compiled.indexOf("(#999)")).toBeLessThan(compiled.indexOf("(#2448)"));
  });

  it("folds legacy entries written directly under Unreleased into the same section", () => {
    const legacy = [
      "- **A legacy entry written before fragments (#2400).** First paragraph.",
      "",
      "  A continuation paragraph that belongs to the same entry.",
      "- **A second legacy entry (#2401).** Body.",
    ].join("\n");
    const root = makeRepo({
      changelog: changelogWith(legacy),
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
    });
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      log,
    });

    expect(result.foldedLegacyEntries).toBe(true);
    const compiled = read(root);
    const section = compiled.slice(
      compiled.indexOf("## 0.14.0"),
      compiled.indexOf("## 0.13.2"),
    );
    expect(section).toContain("(#2400)");
    expect(section).toContain("A continuation paragraph that belongs to the same entry.");
    expect(section).toContain("(#2401)");
    expect(section).toContain("(#2452)");
    // Legacy entries lead the section; fragments follow in filename order.
    expect(section.indexOf("(#2400)")).toBeLessThan(section.indexOf("(#2452)"));
    // Nothing is left under Unreleased except the pointer note.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0`);
    expect(log.text()).toContain("Folded in the entries");
  });

  /*
    THE INVERTED-ORDER CASE, and the reason the note is sentinel-anchored.

    `CHANGELOG.md` is `merge=union` (#2451). Merging a branch that still writes
    its entry directly under `## Unreleased` can therefore put that entry ABOVE
    the pointer note — reproduced with real git: the branch side of a union
    merge wins the position. A compiler that split the section positionally
    ("everything above the first bullet is the note") would then read the note
    as part of the entries: it would be published inside the release section AND
    deleted from `## Unreleased` for good, with no error and nothing to notice.
  */
  it("keeps the pointer note in place when an entry sits above it (union-merge order)", () => {
    const inverted = [
      "# Changelog",
      "",
      "All notable public reference-release changes should be recorded here.",
      "",
      "## Unreleased",
      "",
      "- **An entry a union merge landed above the note (#2400).** First paragraph.",
      "",
      "  A continuation paragraph that belongs to the same entry.",
      "",
      NOTE,
      "",
      HISTORY,
    ].join("\n");
    const root = makeRepo({
      changelog: inverted,
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    // 1. The note survives, re-emitted canonically directly under Unreleased.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0 - 2026-08-04`);
    // 2. It never enters the release section.
    const section = compiled.slice(compiled.indexOf("## 0.14.0"), compiled.indexOf("## 0.13.2"));
    expect(section).not.toContain(POINTER_NOTE_START);
    expect(section).not.toContain(NOTE_BODY);
    // The entry that was above it is released, continuation and all.
    expect(section).toContain("(#2400)");
    expect(section).toContain("A continuation paragraph that belongs to the same entry.");
    expect(section).toContain("(#2452)");
    // And the note exists exactly once in the whole file — not duplicated.
    expect(compiled.split(POINTER_NOTE_START).length - 1).toBe(1);
  });

  it("restores the pointer note when Unreleased has lost it", () => {
    const root = makeRepo({
      changelog: [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "- **An entry with no pointer note above it (#2400).** Body.",
        "",
        HISTORY,
      ].join("\n"),
    });
    const log = silentLog();

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    const compiled = read(root);
    expect(compiled).toContain(`## Unreleased\n\n${POINTER_NOTE_START}\n`);
    expect(compiled).toContain("changelog.d/README.md");
    expect(compiled.indexOf(POINTER_NOTE_END)).toBeLessThan(compiled.indexOf("## 0.14.0"));
    expect(log.text()).toContain("Restored the changelog.d pointer note");
  });

  it("warns loudly about unrecognised content under Unreleased instead of silently keeping it", () => {
    const stray = "TODO: someone please turn the refund fix into a proper entry.";
    const root = makeRepo({
      changelog: changelogWith(`${stray}\n\n- **A real entry (#2400).** Body.`),
    });
    const log = silentLog();

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(log.text()).toContain('WARNING: unrecognised content left under "## Unreleased"');
    expect(log.text()).toContain(stray);
    const compiled = read(root);
    // Neither released...
    const section = compiled.slice(compiled.indexOf("## 0.14.0"), compiled.indexOf("## 0.13.2"));
    expect(section).not.toContain(stray);
    expect(section).toContain("(#2400)");
    // ...nor deleted: it stays under Unreleased, below the note.
    expect(compiled).toContain(`${NOTE}\n\n${stray}\n\n## 0.14.0 - 2026-08-04`);
  });

  it("refuses to guess when the pointer-note sentinel is malformed", () => {
    const unterminated = makeRepo({
      changelog: [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        POINTER_NOTE_START,
        "",
        NOTE_BODY,
        "",
        HISTORY,
      ].join("\n"),
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({
        repoRoot: unterminated,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
      }),
    ).toThrow(/unterminated/);

    const duplicated = makeRepo({
      changelog: changelogWith(NOTE),
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({
        repoRoot: duplicated,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
      }),
    ).toThrow(/more than one/);
  });

  it("keeps the real CHANGELOG.md pointer note inside its sentinels", () => {
    const real = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "CHANGELOG.md"),
      "utf8",
    );
    const unreleased = real.slice(
      real.indexOf("## Unreleased"),
      real.indexOf("\n## ", real.indexOf("## Unreleased") + 1),
    );
    expect(unreleased).toContain(POINTER_NOTE_START);
    expect(unreleased).toContain(POINTER_NOTE_END);
    expect(unreleased.indexOf(POINTER_NOTE_START)).toBeLessThan(
      unreleased.indexOf("changelog.d/README.md"),
    );
    expect(unreleased.indexOf("changelog.d/README.md")).toBeLessThan(
      unreleased.indexOf(POINTER_NOTE_END),
    );
  });

  it("is a no-op with a clear message when there is nothing to compile", () => {
    const root = makeRepo({ fragments: { "README.md": "# How to write a fragment\n" } });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      log,
    });

    expect(result.written).toBe(false);
    expect(read(root)).toBe(before);
    expect(log.text()).toContain("Nothing to compile");
    expect(log.text()).toContain("CHANGELOG.md was left unchanged");
  });

  it("leaves every file untouched in --dry-run and reports the plan", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
      changelog: changelogWith("- **A legacy entry (#2400).** Body."),
    });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      dryRun: true,
      log,
    });

    expect(result.written).toBe(false);
    expect(read(root)).toBe(before);
    expect(fragmentFiles(root)).toEqual(["2452-fragments.md"]);
    expect(log.text()).toContain('[dry run] Would add "## 0.14.0 - 2026-08-04"');
    expect(log.text()).toContain("changelog.d/2452-fragments.md (would be deleted)");
    expect(log.text()).toContain('the entries currently written directly under "## Unreleased"');
    expect(log.text()).toContain("No files were changed");
  });

  it("normalises a CRLF fragment written by a Windows editor", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **CRLF entry (#2452).**\r\n\r\n  Second paragraph.\r\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    expect(read(root)).not.toContain("\r");
  });

  it("refuses to compile a version that is already released", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.13.2", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/already has a "## 0.13.2" section/);
  });

  it("rejects a malformed version or date", () => {
    const root = makeRepo();
    expect(() => compileChangelog({ repoRoot: root, version: "v0.14", log: silentLog() })).toThrow(
      /Version must look like/,
    );
    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "4 Aug 2026", log: silentLog() }),
    ).toThrow(/Date must be YYYY-MM-DD/);
  });

  it("inserts above the newest release when there is no Unreleased heading", () => {
    const root = makeRepo({
      changelog: `# Changelog\n\nAll notable changes.\n\n${HISTORY}`,
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    expect(compiled.indexOf("## 0.14.0")).toBeLessThan(compiled.indexOf("## 0.13.2"));
    expect(compiled.endsWith("\n")).toBe(true);
  });

  it("reads only compilable fragments, in order", () => {
    const root = makeRepo({
      fragments: {
        "b.md": "- b\n",
        "a.md": "- a\n",
        "README.md": "# readme\n",
        ".gitkeep": "",
        "notes.txt": "ignored",
      },
    });
    expect(readFragments(path.join(root, "changelog.d")).map((f) => f.name)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(readFragments(path.join(root, "no-such-dir"))).toEqual([]);
  });

  it("sorts numeric filename chunks numerically and everything else stably", () => {
    expect(["2448-b.md", "999-a.md", "10-c.md"].sort(compareFragmentNames)).toEqual([
      "10-c.md",
      "999-a.md",
      "2448-b.md",
    ]);
    expect(["b.md", "a.md"].sort(compareFragmentNames)).toEqual(["a.md", "b.md"]);
    expect(compareFragmentNames("2452-a.md", "2452-a.md")).toBe(0);
  });

  it("parses CLI arguments", () => {
    expect(parseArgs(["0.14.0", "2026-08-04"])).toEqual({
      version: "0.14.0",
      date: "2026-08-04",
      dryRun: false,
    });
    expect(parseArgs(["--dry-run", "0.14.0"])).toEqual({
      version: "0.14.0",
      date: undefined,
      dryRun: true,
    });
  });

  it("formats today's date as an NZ date-only value", () => {
    expect(todayInNewZealand(new Date("2026-08-03T20:00:00Z"))).toBe("2026-08-04");
    expect(todayInNewZealand()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
