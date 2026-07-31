/**
 * A minimal line diff, used by the email template editor (#2269 F3) to show an
 * admin how their saved override differs from the current built-in wording
 * before they decide whether to keep it or press Restore Default.
 *
 * Deliberately dependency-free: this is a few dozen lines of textbook LCS over
 * inputs the schema caps at 10,000 characters, and a new runtime dependency on
 * a diff library would have to be justified to the audit gate for the sake of
 * one read-only admin panel.
 */

export type TextDiffLineType = "equal" | "removed" | "added";

export interface TextDiffLine {
  type: TextDiffLineType;
  value: string;
}

/**
 * Above this many lines on either side the quadratic table stops being a
 * sensible thing to build in a browser, so the diff degrades to "all of this
 * was replaced by all of that" — still truthful, just not line-precise. Email
 * bodies are capped at 10,000 characters, so this is a safety net rather than
 * an expected path.
 */
const MAX_DIFFABLE_LINES = 1500;

function splitLines(value: string): string[] {
  // A trailing newline would otherwise produce a phantom empty final line on
  // one side only, which reads as a spurious change.
  const normalised = value.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalised.length === 0 ? [] : normalised.split("\n");
}

function wholeBlockDiff(before: string[], after: string[]): TextDiffLine[] {
  return [
    ...before.map((value): TextDiffLine => ({ type: "removed", value })),
    ...after.map((value): TextDiffLine => ({ type: "added", value })),
  ];
}

/**
 * Diff two blocks of text line by line.
 *
 * `removed` lines belong to `before`, `added` lines belong to `after`, and the
 * result reads top to bottom as a single document.
 */
export function diffLines(before: string, after: string): TextDiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (
    beforeLines.length > MAX_DIFFABLE_LINES ||
    afterLines.length > MAX_DIFFABLE_LINES
  ) {
    return wholeBlockDiff(beforeLines, afterLines);
  }

  // lcs[i][j] = length of the longest common subsequence of beforeLines[i..]
  // and afterLines[j..]. Built backwards so the walk below emits in order.
  const lcs: number[][] = Array.from(
    { length: beforeLines.length + 1 },
    () => new Array<number>(afterLines.length + 1).fill(0),
  );
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        beforeLines[i] === afterLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: "equal", value: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "removed", value: beforeLines[i] });
      i += 1;
    } else {
      result.push({ type: "added", value: afterLines[j] });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    result.push({ type: "removed", value: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    result.push({ type: "added", value: afterLines[j] });
    j += 1;
  }

  return result;
}

/** True when the two blocks are the same text (ignoring line-ending style). */
export function isSameText(before: string, after: string): boolean {
  return splitLines(before).join("\n") === splitLines(after).join("\n");
}
