// The one-shot generation constants — the ONE source of truth every generating path reads (bots, insights, synthesis, work plan, flow pointers, bot themes, the
// impact note). They lived in the per-repo activity digest until that feature was removed; the
// env var names keep their historical `PRO_DIGEST_*` spelling so existing deployments carry on.
export const DIGEST_MODEL = process.env.PRO_DIGEST_MODEL ?? 'claude-haiku-5-5';
export const MIN_INTERVAL_SEC = intEnv('PRO_DIGEST_MIN_INTERVAL_SEC', 60);

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function tsToIso(v: Date | number | null | undefined): string {
  if (v == null) return new Date(0).toISOString();
  const d = v instanceof Date ? v : new Date(Number(v));
  return d.toISOString();
}
export function tsToMs(v: Date | number | null | undefined): number {
  if (v == null) return 0;
  return v instanceof Date ? v.getTime() : Number(v);
}
