// How hard local scoring may lean on the machine. Scoring is a BACKGROUND chore — a fresh install
// can owe tens of thousands of comments, at about one CPU-second each — so three limits stack:
//
//   1. the scoring process runs at background priority (local-scorer.ts: `taskpolicy -b` on
//      macOS, nice 19 elsewhere), so ANY foreground work wins the CPU;
//   2. one ONNX thread by default (`LIMN_ML_THREADS`), so it never occupies more than one core;
//   3. a duty cycle (`LIMN_ML_CPU_SHARE`, default 0.5): after each comment it sleeps long enough
//      that its average use stays at that share of the one core, so even an idle machine's fans
//      do not spin up for a backlog drain;
//
// and on battery it does not run at all (power.ts), unless `LIMN_ML_ON_BATTERY=run`.

const DEFAULT_SHARE = 0.5;
const DEFAULT_THREADS = 1;

/** The share of one core scoring may use on average, from the env: (0, 1], default 0.5. */
export function cpuShareFrom(raw: string | undefined): number {
  const v = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(v) || v <= 0) return DEFAULT_SHARE;
  return Math.min(1, Math.max(0.05, v));
}

/** ONNX intra-op threads, from the env: 1..4, default 1. */
export function threadsFrom(raw: string | undefined): number {
  const v = Math.trunc(Number(raw));
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(v) || v < 1) return DEFAULT_THREADS;
  return Math.min(4, v);
}

/** The pause after `busyMs` of work that holds average use to `share` of a core. */
export function throttleDelayMs(busyMs: number, share: number): number {
  if (share >= 1 || busyMs <= 0) return 0;
  return busyMs * (1 / share - 1);
}
