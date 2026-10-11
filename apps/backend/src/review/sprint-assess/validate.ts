import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import {
  SPRINT_ASSESS_CAPS,
  STORY_ISSUE_IDS,
  isModelStoryRule,
  isStoryIssueId,
  verifyStoryQuote,
  type SprintAssessmentBody,
  type SprintAssessmentDropped,
  type SprintAssessmentFinding,
  type SprintAssessMode,
  type SprintCodeRef,
  type SprintCriterionCheck,
  type SprintCriterionStatus,
  type SprintPlanStep,
  type StoryQuoteSources,
} from '@pierre-review/shared';
import { isWithin } from '../path-guard.js';
import { isBlockingReference, type PromptReference } from './prompts.js';

// THE SPRINT ASSESSMENT'S SERVER VALIDATOR — the contract for what a `submit_assessment` call may
// store (the tool's zod shape is deliberately lenient). Pure apart from the filesystem check.
//
//   • CAPS (`SPRINT_ASSESS_CAPS`): over-long text is CUT with "…", never refused; `revisedCriteria`
//     over its cap keeps the first N and counts the rest in `dropped.items`.
//   • FINDINGS (format 4): `issue` one of the three story ids and `rule` from THAT issue's closed
//     vocabulary (story-rules.ts; a code-only rule is refused). An unknown issue, a rule of another
//     issue, an empty sentence, or one past `SPRINT_ASSESS_CAPS.findings` is dropped and counted in
//     `dropped.items`. Kept findings are sorted in STORY_ISSUES order (stable within an issue).
//   • EVERY QUOTE IS VERIFIED against the ticket text (`verifyStoryQuote`: whitespace-normalised,
//     case-sensitive then insensitive; a leading "3. " criterion number is forgiven) and stored in the
//     ticket's own spelling with `where`. One that does not verify becomes null (the finding is KEPT,
//     unanchored) and is counted in `dropped.quotes`; its `suggestion` goes with it (a rewrite of
//     nothing). Without `ctx.ticket` every quote is null.
//   • `revisedDescription` is kept only when non-blank and different from the description.
//   • EVERY CITED PATH IS VERIFIED: normalised to POSIX, refused when absolute (outside a checkout),
//     containing `..` or NUL, naming a repo the reader did not accept, or not existing in that
//     repo's checkout (realpath must stay inside it — a symlink pointing out is refused). A refused
//     path sets `ref: null` and is counted in `dropped.paths`; the SENTENCE IS KEPT. An absolute
//     path INSIDE a listed checkout is re-expressed relative to it (the agent sees absolute paths).
//     The repo may be left out when only one repo was checked out.
//   • THE MODE (format 5) is the server's, never the model's: `ctx.mode`. PLAN keeps `plan` (≤ planSteps;
//     each step names an accepted repo — or the only one — and either a `path` that EXISTS in that
//     checkout, file or directory, or a `newPath` that is a clean relative path and does NOT exist; a
//     step whose path does not hold keeps its sentence with path null, counted in `dropped.paths`).
//     VERIFY keeps `criterionChecks` (n within 1..criteriaCount when the ticket has criteria, one per
//     n, sorted by n; status from the four; evidence cut to its cap; `ref` and `tests` VERIFIED like
//     any cited path — `tests` is looked up in the criterion's repo, then in every accepted repo) and
//     `coverage`. The other mode's fields are ignored.
//   • A BLOCKED FINDING ABOUT A TICKET THAT CANNOT BLOCK IS DROPPED (counted in `dropped.items`): the
//     ticket keys its text + quote name are matched against the references the run was given
//     (`ctx.references`); when at least one is named and EVERY named key is a known reference that is
//     not blocking (`isBlockingReference`: not blocked_by / depends_on, or done), the finding goes.
//     Conservative: a key the list does not hold, or no key at all, keeps it.
//   • An EMPTY result (no summary, findings, plan / checks or revisions) is refused → the run fails
//     `invalid_assessment`.

export interface ValidateContext {
  /** The check the server started (from the ticket's stage). */
  mode: SprintAssessMode;
  /** The ticket's numbered criteria count (verify mode bounds `n` by it when > 0). */
  criteriaCount?: number;
  /** The accepted repos that were checked out: owner/name + absolute checkout path. */
  repos: ReadonlyArray<{ fullName: string; path: string }>;
  /** The ticket text the run was given — every quote is verified against it. */
  ticket?: StoryQuoteSources;
  /** The referenced tickets the prompt listed (relation + done) — a blocked finding about only
   *  non-blocking ones is dropped. */
  references?: ReadonlyArray<Pick<PromptReference, 'key' | 'relation' | 'done'>>;
}

const FINDING_KEY_RE = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9_]{0,19}-\d{1,9}(?![A-Za-z0-9_-])/g;

/** Is this blocked finding only about tickets known NOT to block? Pure (exported for its test). */
export function blockedFindingNamesOnlyNonBlocking(
  text: string,
  quote: string | null,
  references: ValidateContext['references'],
): boolean {
  if (references == null || references.length === 0) return false;
  const byKey = new Map(references.map((r) => [r.key.trim().toUpperCase(), r]));
  const named = new Set([...`${text}\n${quote ?? ''}`.toUpperCase().matchAll(FINDING_KEY_RE)].map((m) => m[0]));
  if (named.size === 0) return false;
  for (const k of named) {
    const r = byKey.get(k);
    if (r == null || isBlockingReference(r)) return false;
  }
  return true;
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

/** A model quote → the ticket's passage, or null. A leading criterion number ("3. ") is forgiven. */
export function verifyAssessQuote(quote: string, ticket: StoryQuoteSources | undefined) {
  if (ticket == null) return null;
  const q = quote.replace(/\u0000/g, '');
  return verifyStoryQuote(q, ticket) ?? (/^\s*\d{1,3}[.)]\s+/.test(q) ? verifyStoryQuote(q.replace(/^\s*\d{1,3}[.)]\s+/, ''), ticket) : null);
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

  const findings: SprintAssessmentFinding[] = [];
  let quotesDropped = 0;
  for (const item of arr(top.findings)) {
    const it = obj(item);
    const text = cut(it.text, caps.findingText);
    if (!isStoryIssueId(it.issue) || !isModelStoryRule(it.rule, it.issue) || text === '' || findings.length >= caps.findings) {
      dropped.items += 1;
      continue;
    }
    if (it.issue === 'blocked' && blockedFindingNamesOnlyNonBlocking(text, typeof it.quote === 'string' ? it.quote : null, ctx.references)) {
      dropped.items += 1;
      continue;
    }
    const ref = refOf(it);
    if (ref === 'refused') dropped.paths += 1;
    const quoted = typeof it.quote === 'string' && it.quote.trim() !== '';
    const hit = quoted ? verifyAssessQuote(it.quote as string, ctx.ticket) : null;
    if (quoted && hit == null) quotesDropped += 1;
    const suggestion = hit != null ? cut(it.suggestion, caps.suggestion) : '';
    findings.push({
      issue: it.issue,
      rule: it.rule,
      quote: hit?.quote ?? null,
      where: hit?.where ?? null,
      text,
      suggestion: suggestion === '' ? null : suggestion,
      ref: ref === 'refused' ? null : ref,
    });
  }
  // Stable sort: STORY_ISSUES order, the model's order within an issue.
  const sorted = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => STORY_ISSUE_IDS.indexOf(a.f.issue) - STORY_ISSUE_IDS.indexOf(b.f.issue) || a.i - b.i)
    .map((x) => x.f);
  dropped.quotes = quotesDropped;

  const revisedCriteria: string[] = [];
  for (const item of arr(top.revisedCriteria)) {
    const t = cut(item, caps.criterionText);
    if (t === '' || revisedCriteria.length >= caps.revisedCriteria) {
      dropped.items += 1;
      continue;
    }
    revisedCriteria.push(t);
  }

  const rawDescription = typeof top.revisedDescription === 'string' ? top.revisedDescription.replace(/\u0000/g, '').trim() : '';
  let revisedDescription: string | null = null;
  if (rawDescription !== '') {
    if (rawDescription.length > caps.revisedDescription) dropped.items += 1;
    else if (ctx.ticket == null || rawDescription !== ctx.ticket.description.trim()) revisedDescription = rawDescription;
  }

  // ---- PLAN ----
  const plan: SprintPlanStep[] = [];
  if (ctx.mode === 'plan') {
    for (const item of arr(top.plan)) {
      const it = obj(item);
      const change = cut(it.change, caps.planChange);
      const repoName = typeof it.repo === 'string' ? it.repo.trim().toLowerCase() : '';
      const repo = repoByName.get(repoName) ?? (repoName === '' || ctx.repos.length === 1 ? onlyRepo : null);
      if (change === '' || repo == null || plan.length >= caps.planSteps) {
        dropped.items += 1;
        continue;
      }
      let path: string | null = null;
      let newPath: string | null = null;
      const citedPath = typeof it.path === 'string' && it.path.trim() !== '';
      const citedNew = typeof it.newPath === 'string' && it.newPath.trim() !== '';
      if (citedPath) {
        const p = normaliseCitedPath(it.path, repo.path);
        if (p != null && existsInCheckout(repo.path, p)) path = p;
        else dropped.paths += 1;
      }
      if (path == null && citedNew) {
        const p = normaliseCitedPath(it.newPath, repo.path);
        // A NEW file's path: clean and relative, and not already there (then it is no new file).
        if (p != null && !existsInCheckout(repo.path, p)) newPath = p;
        else if (p != null) path = p;
        else dropped.paths += 1;
      }
      plan.push({ repo: repo.fullName, path, newPath, change });
    }
  }

  // ---- VERIFY ----
  const criterionChecks: SprintCriterionCheck[] = [];
  let coverage: string | null = null;
  if (ctx.mode === 'verify') {
    const statuses: readonly SprintCriterionStatus[] = ['met', 'partly', 'not_met', 'unclear'];
    const max = ctx.criteriaCount ?? 0;
    const seen = new Set<number>();
    for (const item of arr(top.criterionChecks)) {
      const it = obj(item);
      const n = typeof it.n === 'number' && Number.isInteger(it.n) ? it.n : NaN;
      const evidence = cut(it.evidence, caps.evidence);
      if (
        !(n >= 1) ||
        (max > 0 && n > max) ||
        seen.has(n) ||
        !statuses.includes(it.status as SprintCriterionStatus) ||
        evidence === '' ||
        criterionChecks.length >= caps.criterionChecks
      ) {
        dropped.items += 1;
        continue;
      }
      seen.add(n);
      const ref = refOf(it);
      if (ref === 'refused') dropped.paths += 1;
      let tests: SprintCodeRef | null = null;
      if (typeof it.tests === 'string' && it.tests.trim() !== '') {
        const home = ref !== 'refused' && ref != null ? ctx.repos.find((r) => r.fullName === ref.repo) : null;
        const named = typeof it.repo === 'string' ? repoByName.get(it.repo.trim().toLowerCase()) : undefined;
        const order = [home, named, ...ctx.repos].filter((r, i, a): r is NonNullable<typeof r> => r != null && a.indexOf(r) === i);
        for (const r of order) {
          const p = normaliseCitedPath(it.tests, r.path);
          if (p != null && existsInCheckout(r.path, p)) {
            tests = { repo: r.fullName, path: p };
            break;
          }
        }
        if (tests == null) dropped.paths += 1;
      }
      criterionChecks.push({
        n,
        status: it.status as SprintCriterionStatus,
        evidence,
        ref: ref === 'refused' ? null : ref,
        tests,
      });
    }
    criterionChecks.sort((a, b) => a.n - b.n);
    const cov = cut(top.coverage, caps.coverage);
    coverage = cov === '' ? null : cov;
  }

  const summary = cut(top.summary, caps.summary);
  if (
    summary === '' &&
    sorted.length === 0 &&
    revisedCriteria.length === 0 &&
    revisedDescription == null &&
    plan.length === 0 &&
    criterionChecks.length === 0
  ) {
    return { ok: false, reason: 'no summary, findings, plan, checks or revisions' };
  }
  return {
    ok: true,
    body: { mode: ctx.mode, summary, plan, criterionChecks, coverage, findings: sorted, revisedCriteria, revisedDescription },
    dropped,
  };
}
