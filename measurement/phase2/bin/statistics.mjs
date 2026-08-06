export function conventionalMedian(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new Error("median requires finite values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// Explicit single-side percentile estimator retained from the original
// harness: zero-based sorted[floor(q*n)], capped at n-1.
export function rankedQuantile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new Error("quantile requires finite values");
  if (!(quantile >= 0 && quantile <= 1)) throw new Error("quantile must be between zero and one");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
}
