import { CLAUDE_CI_FAILURE_CATEGORIES, type CiReviewItem } from '@pierre-review/shared';
import { reconcileCiFailures, type CiPlan } from '../claude-review/ci-failures.js';
import type { CiItemWrite } from './persist.js';
import { carryKey } from './prepare.js';
import type { SubmitCiReviewPayload } from './schema.js';

// THE SERVER RECONCILE — what the model submitted, checked against what it was shown.
//
// ⚠ NEVER INVENT A CAUSE. Every failing check on the head gets EXACTLY ONE item, built by
// claude-review/ci-failures.ts `reconcileCiFailures` (the one implementation): Claude's FIRST report
// for its ref, a carried diagnosis, or 'not_checked' with the server's reason. Unknown refs and
// malformed entries are dropped; a sent ref never reported is 'not_reported'.
//
// This module adds the CI review's own fields on top, per ref: the one file to change (`path`,
// `line` — a relative path inside the repository, else nothing) and the `suggestion`. A carried item
// keeps the ones it was explained with. A 'not_checked' item carries none of them.

export const CI_SUMMARY_CHARS = 1_500;
export const CI_SUGGESTION_CHARS = 1_000;
const PATH_CHARS = 300;
const CATEGORIES: ReadonlySet<string> = new Set(CLAUDE_CI_FAILURE_CATEGORIES);

function clip(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** A repository-relative path, or null (absolute, `..`, a URL or empty is refused). */
export function safeRepoPath(v: unknown): string | null {
  const p = clip(v, PATH_CHARS);
  if (!p) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z]+:/i.test(p)) return null;
  if (p.split(/[\\/]/).some((seg) => seg === '..')) return null;
  return p.replace(/^\.\//, '');
}

const lineOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

export interface ReconciledCiReview {
  summary: string | null;
  items: CiItemWrite[];
}

export function reconcileCiReview(
  plan: CiPlan,
  payload: SubmitCiReviewPayload | null,
  carriedExtras: ReadonlyMap<string, Pick<CiReviewItem, 'path' | 'line' | 'suggestion'>>,
): ReconciledCiReview {
  const reports = Array.isArray(payload?.failures) ? payload!.failures : [];
  const record = reconcileCiFailures(plan, reports);
  // First report per ref wins, as in reconcileCiFailures.
  const firstByRef = new Map<string, (typeof reports)[number]>();
  for (const r of reports) {
    if (!r || typeof r.ref !== 'string') continue;
    const ref = r.ref.trim().toUpperCase();
    // The same validity test reconcileCiFailures applies, so both pick the SAME report.
    if (!CATEGORIES.has(r.category) || !clip(r.cause, 1)) continue;
    if (!firstByRef.has(ref)) firstByRef.set(ref, r);
  }
  const items: CiItemWrite[] = record.failures.map((f) => {
    if (f.status !== 'diagnosed') return { ...f, path: null, line: null, suggestion: null };
    if (f.carried) {
      const x = carriedExtras.get(carryKey(f.checkName, f.jobId));
      return { ...f, path: x?.path ?? null, line: x?.line ?? null, suggestion: x?.suggestion ?? null };
    }
    const r = f.ref ? firstByRef.get(f.ref) : undefined;
    const related = f.relatedFiles.filter((rf) => safeRepoPath(rf.path) != null);
    const own = safeRepoPath(r?.path);
    const path = own ?? related[0]?.path ?? null;
    return {
      ...f,
      relatedFiles: related,
      path,
      line: own != null ? lineOf(r?.line) : (related[0]?.line ?? null),
      suggestion: clip(r?.suggestion, CI_SUGGESTION_CHARS),
    };
  });
  return { summary: clip(payload?.summary, CI_SUMMARY_CHARS), items };
}

/** The items when nothing was sent (all carried): no model involved. */
export function reconcileWithoutModel(
  plan: CiPlan,
  carriedExtras: ReadonlyMap<string, Pick<CiReviewItem, 'path' | 'line' | 'suggestion'>>,
): ReconciledCiReview {
  return reconcileCiReview(plan, null, carriedExtras);
}
