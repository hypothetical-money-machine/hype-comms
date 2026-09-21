export function summarize(samples) {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Expected nonempty finite, nonnegative samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    n: sorted.length,
    min: sorted[0],
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: quantile(0.95),
    max: sorted.at(-1),
    samples,
  };
}
