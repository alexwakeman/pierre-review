import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import {
  SPRINT_ASSESS_CAPS,
  STORY_ISSUE_IDS,
  isStoryIssueId,
  type SprintAssessmentBody,
  type SprintAssessmentDropped,
  type SprintAssessmentIssue,
  type SprintCodeRef,
} from '@pierre-review/shared';
import { isWithin } from '../path-guard.js';

// THE SPRINT ASSESSMENT'S SERVER VALIDATOR — the contract for what a `submit_assessment` call may
// store (the tool's zod shape is deliberately lenient). Pure apart from the filesystem check.
//
//   • CAPS (`SPRINT_ASSESS_CAPS`): over-long text is CUT with "…", never refused; `revisedCriteria`
//     over its cap keeps the first N and counts the rest in `dropped.items`.
//   • ISSUES are the three story ids: an unknown, retired or repeated id, an empty sentence, or a fourth
//     entry is dropped and counted in `dropped.items`. Kept issues are sorted in STORY_ISSUES order.
//   • EVERY CITED PATH IS VERIFIED: normalised to POSIX, refused when absolute (outside a checkout),
//     containing `..` or NUL, naming a repo the reader did not accept, or not existing in that
//     repo's checkout (realpath must stay inside it — a symlink pointing out is refused). A refused
//     path sets `ref: null` and is counted in `dropped.paths`; the SENTENCE IS KEPT. An absolute
//     path INSIDE a listed checkout is re-expressed relative to it (the agent sees absolute paths).
//     The repo may be left out when only one repo was checked out.
//   • An EMPTY result (no summary, no issues and no revised criteria) is refused → the run fails
//     `invalid_assessment`.

export interface ValidateContext {
  /** The accepted repos that were checked out: owner/name + absolute checkout path. */
  repos: ReadonlyArray<{ fullName: string; path: string }>;
}

type Result =
  | { ok: true; body: SprintAssessmentBody; dropped: SprintAssessmentDropped }
  | { ok: false; reason: string };

const PATH_MAX = 500;

function cut(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/\u0000/g, '').trim();
  if (t.length <= max) return t;
  let end = max - 1;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${t.slice(0, end).trimEnd()}…`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Normalise a cited path to a repo-relative POSIX path, or null when it must be refused. An absolute
 * path is accepted only when it lies inside `checkout` (then made relative).
 */
export function normaliseCitedPath(raw: unknown, checkout: string): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (p === '' || p.length > PATH_MAX || p.includes('\u0000')) return null;
  p = p.replace(/\\/g, '/');
  if (isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    const inside = (root: string | null): string | null => {
      if (root == null) return null;
      const rel = relative(root, p);
      return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
    };
    const rel = inside(checkout) ?? inside(safeReal(checkout));
    if (rel == null) return null;
    p = rel.split(sep).join('/');
  }
  if (p.split('/').includes('..')) return null;
  p = posix.normalize(p).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (p === '' || p === '.' || p.startsWith('/') || p.split('/').includes('..')) return null;
  return p;
}

/** Does repo-relative `rel` exist inside `checkout`, with its real path still inside it? */
export function existsInCheckout(checkout: string, rel: string): boolean {
  const abs = join(checkout, rel);
  if (!existsSync(abs)) return false;
  const root = safeReal(checkout);
  const real = safeReal(abs);
  return root != null && real != null && isWithin(root, real);
}

export function validateSprintAssessment(raw: unknown, ctx: ValidateContext): Result {
  const caps = SPRINT_ASSESS_CAPS;
  const dropped: SprintAssessmentDropped = { paths: 0, items: 0 };
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const top = obj(raw);

  const repoByName = new Map(ctx.repos.map((r) => [r.fullName.toLowerCase(), r]));
  const onlyRepo = ctx.repos.length === 1 ? ctx.repos[0]! : null;

  /** A verified ref, null when none was cited, or 'refused' when one was cited and did not hold. */
  const refOf = (it: Record<string, unknown>): SprintCodeRef | null | 'refused' => {
    const cited = typeof it.path === 'string' && it.path.trim() !== '';
    if (!cited) return null;
    const repoName = typeof it.repo === 'string' ? it.repo.trim().toLowerCase() : '';
    const repo = repoByName.get(repoName) ?? (repoName === '' ? onlyRepo : null);
    const path = repo != null ? normaliseCitedPath(it.path, repo.path) : null;
    if (repo == null || path == null || !existsInCheckout(repo.path, path)) return 'refused';
    return { repo: repo.fullName, path };
  };

  const issues: SprintAssessmentIssue[] = [];
  for (const item of arr(top.issues)) {
    const it = obj(item);
    const text = cut(it.text, caps.issueText);
    if (!isStoryIssueId(it.id) || text === '' || issues.some((x) => x.id === it.id) || issues.length >= caps.issues) {
      dropped.items += 1;
      continue;
    }
    const ref = refOf(it);
    if (ref === 'refused') dropped.paths += 1;
    issues.push({ id: it.id, text, ref: ref === 'refused' ? null : ref });
  }
  issues.sort((a, b) => STORY_ISSUE_IDS.indexOf(a.id) - STORY_ISSUE_IDS.indexOf(b.id));

  const revisedCriteria: string[] = [];
  for (const item of arr(top.revisedCriteria)) {
    const t = cut(item, caps.criterionText);
    if (t === '' || revisedCriteria.length >= caps.revisedCriteria) {
      dropped.items += 1;
      continue;
    }
    revisedCriteria.push(t);
  }

  const summary = cut(top.summary, caps.summary);
  if (summary === '' && issues.length === 0 && revisedCriteria.length === 0) {
    return { ok: false, reason: 'no summary, issues or revised criteria' };
  }
  return { ok: true, body: { summary, issues, revisedCriteria }, dropped };
}
