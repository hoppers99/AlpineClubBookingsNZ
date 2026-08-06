// Dependency-free bounded load driver for the #2352 phase-2 comparison.
// Uses a monotonic clock for both the deadline and actual elapsed/RPS, applies
// a real per-request timeout, drains every response body, and preserves error
// classes rather than collapsing failures into one counter.
import { performance } from "node:perf_hooks";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid argument near ${flag ?? "end"}`);
    values[flag.slice(2)] = value;
  }
  const number = (name, fallback) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`);
    return value;
  };
  return {
    url: values.url ?? "http://localhost:8027/about",
    concurrency: number("concurrency", 10),
    durationMs: number("duration", 30) * 1000,
    timeoutMs: number("timeout-ms", 10_000),
  };
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isInteger(args.concurrency)) fail("concurrency must be an integer");

const firstByte = [];
const total = [];
const statuses = {};
const errorClasses = {};
let started = 0;
let completed = 0;
const runStart = performance.now();
const deadline = runStart + args.durationMs;

function classifyError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  const causeCode = error?.cause?.code;
  if (typeof causeCode === "string" && causeCode.length > 0) return `transport:${causeCode}`;
  if (error instanceof TypeError) return "transport:TypeError";
  return `other:${error?.name ?? "Error"}`;
}

async function worker() {
  while (performance.now() < deadline) {
    started += 1;
    const requestStart = performance.now();
    try {
      const res = await fetch(args.url, {
        headers: { "x-load": "phase2" },
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      if (!res.body) fail("response had no body stream");
      const reader = res.body.getReader();
      const first = await reader.read();
      const firstAt = performance.now();
      while (!(await reader.read()).done) {
        // Drain the body so completion latency and connection reuse are real.
      }
      const endAt = performance.now();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (!first.done) firstByte.push(firstAt - requestStart);
      total.push(endAt - requestStart);
      completed += 1;
    } catch (error) {
      const classification = classifyError(error);
      errorClasses[classification] = (errorClasses[classification] ?? 0) + 1;
    }
  }
}

function stats(list) {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    median_ms: Number(at(0.5).toFixed(3)),
    p95_ms: Number(at(0.95).toFixed(3)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

await Promise.all(Array.from({ length: args.concurrency }, worker));
const actualElapsedMs = performance.now() - runStart;
const errors = Object.values(errorClasses).reduce((sum, count) => sum + count, 0);

console.log(
  JSON.stringify(
    {
      schema_version: 2,
      url: args.url,
      concurrency: args.concurrency,
      requested_duration_s: args.durationMs / 1000,
      actual_elapsed_ms: Number(actualElapsedMs.toFixed(3)),
      request_timeout_ms: args.timeoutMs,
      requests_started: started,
      requests: completed,
      rps: Number((completed / (actualElapsedMs / 1000)).toFixed(3)),
      statuses,
      errors,
      error_classes: errorClasses,
      firstByte: stats(firstByte),
      total: stats(total),
    },
    null,
    2,
  ),
);
