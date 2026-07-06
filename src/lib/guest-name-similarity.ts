// Same-person (typo-correction) guard for editing a free-text NON-MEMBER guest
// name AFTER a booking is fully paid (issue #1386).
//
// The paid-name lock exists to stop swapping in a DIFFERENT person after
// payment — an unauthorised booking transfer/resale. We relax it ONLY for an
// unambiguous spelling correction of the SAME name, and we draw the line
// CONSERVATIVELY: a false reject just sends the member to the office (the prior
// status quo), while a false accept opens a transfer hole. When in doubt, reject.
//
// A change counts as a typo correction only when ALL of the following hold, on
// names normalised as: trim + lowercase + collapse internal whitespace.
//
//   1. Neither NEW name part is blank — never drop a name to nothing.
//   2. First name and last name each keep the SAME word/token count: a typo
//      fixes letters, it never adds or removes a name part. This alone rejects
//      "John" -> "Johnathan Smith".
//   3. The Damerau-Levenshtein distance between the normalised FULL names
//      (an adjacent-character transposition counts as a single edit) is at most
//         min(2, floor(0.25 * lengthOfLongerNormalisedFullName))
//      i.e. at most TWO edits, and never more than a quarter of the longer
//      name — whichever bound is smaller. Distance 0 (a pure case/whitespace
//      fix) is allowed: it is unambiguously the same identity.
//
// Token overlap alone is deliberately NOT used as the test: it would pass a
// same-surname given-name swap ("John Smith" -> "Jane Smith"). This guard
// REJECTS that (full-name distance 3 > 2), and rejects a full swap
// ("John Smith" -> "Aroha Ngata") the same way.
//
// Residual accepted by design: two names that genuinely differ by <= 2 edits
// (e.g. "Ann" <-> "Amy") are treated as the same person. That is the conscious
// trade-off for allowing real typo fixes; the office remains the fallback for
// anything wider, and the server records an audit row for every allowed fix.

function normalizeNamePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenCount(normalized: string): number {
  return normalized ? normalized.split(" ").length : 0;
}

/**
 * Damerau-Levenshtein (optimal string alignment) edit distance: counts
 * insertions, deletions, substitutions, and adjacent transpositions each as a
 * single edit. Pure and deterministic.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d: number[][] = Array.from({ length: al + 1 }, () =>
    new Array<number>(bl + 1).fill(0),
  );
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
    }
  }

  return d[al][bl];
}

/**
 * True only when changing (prevFirst, prevLast) to (newFirst, newLast) is an
 * unambiguous spelling correction of the SAME name — see the file header for
 * the exact rule. Rejects anything that could be a different person.
 */
export function isLikelyTypoCorrection(
  prevFirst: string,
  prevLast: string,
  newFirst: string,
  newLast: string,
): boolean {
  const newFirstNorm = normalizeNamePart(newFirst);
  const newLastNorm = normalizeNamePart(newLast);
  // Never allow dropping a name part to blank after payment.
  if (!newFirstNorm || !newLastNorm) {
    return false;
  }

  const prevFirstNorm = normalizeNamePart(prevFirst);
  const prevLastNorm = normalizeNamePart(prevLast);

  // A typo fixes letters; it never adds or removes a name part.
  if (tokenCount(prevFirstNorm) !== tokenCount(newFirstNorm)) {
    return false;
  }
  if (tokenCount(prevLastNorm) !== tokenCount(newLastNorm)) {
    return false;
  }

  const prevFull = `${prevFirstNorm} ${prevLastNorm}`.trim();
  const newFull = `${newFirstNorm} ${newLastNorm}`.trim();

  const distance = damerauLevenshtein(prevFull, newFull);
  const longerLength = Math.max(prevFull.length, newFull.length);
  const threshold = Math.min(2, Math.floor(longerLength * 0.25));

  return distance <= threshold;
}
