import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import {
  SPRINT_ASSESS_CAPS,
  type SprintAssessmentBody,
  type SprintAssessmentDropped,
  type SprintCodeRef,
  type SprintCriterionAssessment,
  type SprintExisting,
} from '@pierre-review/shared';
import { isWithin } from '../path-guard.js';

// THE SPRINT ASSESSMENT'S SERVER VALIDATOR — the contract for what a `submit_assessment` call may
// store (the tool's zod shape is deliberately lenient). Pure apart from the filesystem check.
//
//   • CAPS (`SPRINT_ASSESS_CAPS`): over-long text is CUT with "…", never refused; lists over their
//     cap keep the first N and count the rest in `dropped.items`.
//   • CRITERIA are keyed by the ticket's own numbers: an unknown or repeated `n` is dropped; the
//     criterion text is the SERVER's (what the agent was sent), never the model's echo.
//   • EVERY CITED PATH IS VERIFIED: normalised to POSIX, refused when absolute (outside a checkout),
//     containing `..` or NUL, naming a repo the reader did not accept, or not existing in that
//     repo's checkout (realpath must stay inside it — a symlink pointing out is refused). A refused
//     path is DROPPED and counted in `dropped.paths`. An absolute path INSIDE a listed checkout is
//     re-expressed relative to it (the agent sees absolute checkout paths).
//   • An EMPTY result (no criterion entries AND no suggestion summary) is refused → the run fails
//     `invalid_assessment`.

export interface ValidateContext {
  /** The ticket's numbered criteria as sent, in order. */
  criteria: readonly string[];
  /** The accepted repos that were checked out: owner/name + absolute checkout path. */
  repos: ReadonlyArray<{ fullName: string; path: string }>;
}

type Result =
  | { ok: true; body: SprintAssessmentBody; dropped: SprintAssessmentDropped }
  | { ok: false; reason: string };

const EXISTING: ReadonlySet<string> = new Set<SprintExisting>(['none', 'partial', 'full', 'unclear']);
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
  const top = obj(raw);
  if (raw == null || typeof raw !== 'object') return { ok: false, reason: 'not an object' };

  const repoByName = new Map(ctx.repos.map((r) => [r.fullName.toLowerCase(), r]));
  const onlyRepo = ctx.repos.length === 1 ? ctx.repos[0]! : null;

  const textList = (v: unknown, max: number): string[] => {
    const out: string[] = [];
    for (const item of arr(v)) {
      const t = cut(item, max);
      if (t === '') {
        dropped.items += 1;
        continue;
      }
      if (out.length >= caps.listItems) {
        dropped.items += 1;
        continue;
      }
      out.push(t);
    }
    return out;
  };

  // ── criteria ──
  const seen = new Set<number>();
  const criteria: SprintCriterionAssessment[] = [];
  for (const item of arr(top.criteria)) {
    const c = obj(item);
    const n = typeof c.n === 'number' && Number.isInteger(c.n) ? c.n : NaN;
    const sent = Number.isInteger(n) ? ctx.criteria[n - 1] : undefined;
    if (sent == null || n < 1 || seen.has(n) || criteria.length >= caps.criteria) {
      dropped.items += 1;
      continue;
    }
    seen.add(n);
    const landsIn: SprintCodeRef[] = [];
    for (const refRaw of arr(c.landsIn)) {
      const ref = obj(refRaw);
      const repoName = typeof ref.repo === 'string' ? ref.repo.trim().toLowerCase() : '';
      const repo = repoByName.get(repoName) ?? (repoName === '' ? onlyRepo : null);
      const path = repo != null ? normaliseCitedPath(ref.path, repo.path) : null;
      if (repo == null || path == null || !existsInCheckout(repo.path, path)) {
        dropped.paths += 1;
        continue;
      }
      if (landsIn.length >= caps.landsInPerCriterion || landsIn.some((x) => x.repo === repo.fullName && x.path === path)) {
        dropped.items += 1;
        continue;
      }
      const symbol = cut(ref.symbol, caps.text.short);
      landsIn.push({ repo: repo.fullName, path, symbol: symbol === '' ? null : symbol });
    }
    const existing = typeof c.existing === 'string' && EXISTING.has(c.existing) ? (c.existing as SprintExisting) : 'unclear';
    criteria.push({
      n,
      criterion: cut(sent, caps.text.long),
      testableAgainstCode: c.testableAgainstCode === true,
      landsIn,
      existing,
      note: cut(c.note, caps.text.long),
    });
  }
  criteria.sort((a, b) => a.n - b.n);

  // ── gaps ──
  const g = obj(top.gaps);
  const gaps = {
    unnamedDependencies: textList(g.unnamedDependencies, caps.text.long),
    unstatedBehaviourChanges: textList(g.unstatedBehaviourChanges, caps.text.long),
    dataOrMigrationImpact: textList(g.dataOrMigrationImpact, caps.text.long),
    edgeCases: textList(g.edgeCases, caps.text.long),
  };

  // ── suggestion ──
  const s = obj(top.suggestion);
  const rewritten: Array<{ n: number; text: string }> = [];
  const rewrittenSeen = new Set<number>();
  for (const item of arr(s.rewrittenCriteria)) {
    const r = obj(item);
    const n = typeof r.n === 'number' && Number.isInteger(r.n) ? r.n : NaN;
    const text = cut(r.text, caps.text.long);
    if (!(n >= 1 && n <= ctx.criteria.length) || rewrittenSeen.has(n) || text === '' || rewritten.length >= caps.criteria) {
      dropped.items += 1;
      continue;
    }
    rewrittenSeen.add(n);
    rewritten.push({ n, text });
  }
  rewritten.sort((a, b) => a.n - b.n);
  let split: Array<{ title: string; criteria: string[] }> | null = null;
  if (Array.isArray(s.split)) {
    const parts: Array<{ title: string; criteria: string[] }> = [];
    for (const item of s.split) {
      const p = obj(item);
      const title = cut(p.title, caps.text.short);
      if (title === '' || parts.length >= caps.splitParts) {
        dropped.items += 1;
        continue;
      }
      parts.push({ title, criteria: textList(p.criteria, caps.text.long) });
    }
    split = parts.length > 0 ? parts : null;
  }
  const suggestion = {
    rewrittenCriteria: rewritten,
    addedCriteria: textList(s.addedCriteria, caps.text.long),
    split,
    questionsForOwner: textList(s.questionsForOwner, caps.text.long),
    summary: cut(s.summary, caps.text.summary),
  };

  if (criteria.length === 0 && suggestion.summary === '') {
    return { ok: false, reason: 'no criteria entries and no summary' };
  }
  return { ok: true, body: { criteria, gaps, suggestion }, dropped };
}
