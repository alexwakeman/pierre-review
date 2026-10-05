// FAILED CI ON A HEAD — the pure half: which failing checks Claude is shown, the bounded log excerpt
// each one gets, how its report is reconciled and what carries forward unchanged. Used by the CI
// REVIEW (review/ci-review/), the one process that explains failing checks; the PR review used it
// until the CI review split out, and its stored `claude_reviews.ci_failures` are read-only history.
// The GitHub reads (the head's checks, an Actions job's log window and its failed step) are `ctx.ci`
// (review/agent-context.ts); ci-review/prepare.ts drives them.
//
// ⚠ NEVER INVENT A CAUSE (the follow-up's rule, again). Every failing check on the head gets
// EXACTLY ONE entry: Claude's first report for its ref, or 'not_checked' with the server's reason —
// no Actions log (a third-party check), a log that could not be read, over the cap, or not
// reported. A check Claude was never shown is never given a cause.
//
// ⚠ BOUNDED, AND ONLY WHEN SOMETHING FAILED. The log reads happen only for a FAILING Actions job on
// the reviewed head, at most CI_FAILURES_MAX of them, each a single tail window of
// CI_LOG_WINDOW_BYTES (github/actions-logs.ts — a ranged read, never the whole log). The excerpt is
// cut to CI_EXCERPT_CHARS per check and CI_BLOCK_CHARS in total. The signed log URL never leaves
// the server: only the excerpt text enters the prompt, and only the check's details page is stored.
//
// ⚠ ONLY A NEW RUN CHANGES A DIAGNOSIS. On a run at the same head, a failure already diagnosed at
// this head for the SAME job is CARRIED — no log read, not re-sent. A re-run of the workflow is a
// new job id, so it is read again.
//
// The log is the output of code from an untrusted pull request, so the CI review's prompt
// (ci-review/prompts.ts) fences every excerpt (and the check's own name, which the PR's workflow
// file sets) with the run's nonce.
import type {
  CheckRun,
  ClaudeCiFailure,
  ClaudeCiFailureCategory,
  ClaudeCiFailuresRecord,
  ClaudeCiNotCheckedReason,
  ClaudeReviewCiStateKind,
} from '@pierre-review/shared';
import { CLAUDE_CI_FAILURE_CATEGORIES } from '@pierre-review/shared';
import type { ReviewCiFailureReport } from '../../pro/contract.js';

// ---- caps ----
// Failing checks whose logs one review reads (and shows Claude). The rest are 'over_cap'.
export const CI_FAILURES_MAX = 6;
// The tail window read from each job's log (one ranged GET).
export const CI_LOG_WINDOW_BYTES = 128 * 1024;
// One check's excerpt in the prompt, and every excerpt together.
export const CI_EXCERPT_CHARS = 6_000;
export const CI_BLOCK_CHARS = 24_000;
// One log line (minified output and base64 blobs make single lines enormous).
export const CI_LINE_CHARS = 400;
// Excerpt shape: context around the first error, the log's last lines.
export const CI_CONTEXT_BEFORE = 8;
export const CI_CONTEXT_AFTER = 20;
export const CI_TAIL_LINES = 30;
// Stored clips.
export const CI_CAUSE_CHARS = 160;
export const CI_EXPLANATION_CHARS = 1_000;
export const CI_STEP_CHARS = 200;
export const CI_RELATED_FILES_MAX = 5;
export const CI_PATH_CHARS = 300;

// ---- the head's CI ----

/** GitHub's rollup state → the stored kind. A commit with no rollup has no checks. */
export function ciStateKind(rollupState: string | null | undefined): ClaudeReviewCiStateKind {
  if (rollupState == null || rollupState === '') return 'none';
  switch (rollupState.toUpperCase()) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'unknown';
  }
}

export const isFailingCheck = (c: CheckRun): boolean => c.state === 'failure' || c.state === 'error';

/** The identity a diagnosis is carried by: the same job (a re-run is a new job id). */
const failureKey = (checkName: string, jobId: number | null): string => `${checkName}\u0000${jobId ?? ''}`;

// ---- the log excerpt ----

// GitHub Actions prefixes each line with an ISO-8601 timestamp; ANSI colour codes are noise.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
// The strongest marker: the runner's own error annotation.
const RUNNER_ERROR_RE = /##\[error\]/;
// Weaker markers that usually sit at the failure.
const ERROR_RE =
  /npm ERR!|ELIFECYCLE|Traceback \(most recent call last\)|error TS\d|\b[Ee]rror(\[E\d+\])?:|\bERROR\b|\bFAILED\b|\bFAIL\b|AssertionError|panicked at|exit code [1-9]|✕|✗|\bnot ok\b/;
// A runner error that only reports the exit code points at the step's end, not its cause.
const EXIT_ONLY_RE = /##\[error\]\s*Process completed with exit code \d+\.?\s*$/;

function cleanLine(line: string): string {
  const s = line.replace(TIMESTAMP_RE, '').replace(ANSI_RE, '').replace(/\s+$/, '');
  return s.length > CI_LINE_CHARS ? `${s.slice(0, CI_LINE_CHARS)}…(line shortened)` : s;
}

/** The index of the line to centre the excerpt on, or -1 when nothing looks like an error. */
function firstErrorIndex(lines: string[]): number {
  // A specific error first; the runner's "Process completed with exit code N" only when nothing
  // else is marked (it sits at the step's end, after the real cause).
  const specific = lines.findIndex((l) => ERROR_RE.test(l) || (RUNNER_ERROR_RE.test(l) && !EXIT_ONLY_RE.test(l)));
  if (specific >= 0) return specific;
  return lines.findIndex((l) => RUNNER_ERROR_RE.test(l));
}

export interface CiExcerpt {
  text: string;
  // Lines of the read window shown, and lines in it.
  shownLines: number;
  windowLines: number;
  // The window did not start at the log's first byte (earlier output exists and was not read).
  windowTruncated: boolean;
}

/**
 * The excerpt of one job's log that Claude is shown: the lines around the FIRST error in the read
 * window (CI_CONTEXT_BEFORE before, CI_CONTEXT_AFTER after) and the window's last CI_TAIL_LINES
 * lines, in log order, with "… N lines not shown …" between gaps; timestamps and colour codes
 * stripped; each line ≤ CI_LINE_CHARS; the whole ≤ `maxChars` (the tail is shortened first, then
 * the error block from its end). No error marker ⇒ the tail alone. Pure.
 */
export function extractFailureExcerpt(
  raw: string,
  opts: { maxChars?: number; windowTruncated?: boolean } = {},
): CiExcerpt {
  const maxChars = opts.maxChars ?? CI_EXCERPT_CHARS;
  const lines = raw.replace(/\r\n/g, '\n').split('\n').map(cleanLine);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const n = lines.length;
  const keep = new Set<number>();
  const err = firstErrorIndex(lines);
  let errFrom = -1;
  let errTo = -1;
  if (err >= 0) {
    errFrom = Math.max(0, err - CI_CONTEXT_BEFORE);
    errTo = Math.min(n - 1, err + CI_CONTEXT_AFTER);
  }
  let tailFrom = Math.max(0, n - CI_TAIL_LINES);

  const render = (): string => {
    keep.clear();
    if (err >= 0) for (let i = errFrom; i <= errTo; i++) keep.add(i);
    for (let i = tailFrom; i < n; i++) keep.add(i);
    const idx = [...keep].sort((a, b) => a - b);
    const out: string[] = [];
    let prev = -1;
    if (idx.length > 0 && idx[0]! > 0) out.push(`… ${idx[0]} earlier lines not shown …`);
    for (const i of idx) {
      if (prev >= 0 && i > prev + 1) out.push(`… ${i - prev - 1} lines not shown …`);
      out.push(lines[i]!);
      prev = i;
    }
    return out.join('\n');
  };

  let text = render();
  // Over budget: shorten the tail first (the error block is the point), then the error block.
  // Each loop is bounded by its own line count (≤ CI_TAIL_LINES, ≤ CI_CONTEXT_AFTER).
  while (text.length > maxChars && tailFrom < n - 1) {
    tailFrom += 1;
    text = render();
  }
  while (text.length > maxChars && err >= 0 && errTo > err) {
    errTo -= 1;
    text = render();
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(shortened)`;
  return {
    text,
    shownLines: keep.size,
    windowLines: n,
    windowTruncated: opts.windowTruncated ?? false,
  };
}

// ---- the plan ----

export interface FailingCheck {
  checkName: string;
  jobId: number | null;
  url: string | null;
}

export interface CiSelection {
  headSha: string;
  state: ClaudeReviewCiStateKind;
  checkCount: number;
  // Copied unchanged: diagnosed at this head, same job.
  carried: ClaudeCiFailure[];
  // Actions jobs whose logs this run reads, in rollup order, ≤ CI_FAILURES_MAX.
  toRead: FailingCheck[];
  // Not an Actions job: nothing to read.
  noLog: FailingCheck[];
  // Actions jobs past CI_FAILURES_MAX.
  overCap: FailingCheck[];
}

/**
 * Decide which failing checks this run reads. `prior` is the previous succeeded run's stored
 * failures (null when it has none); only one diagnosed AT THIS HEAD for the SAME job carries.
 */
export function selectCiFailures(
  checks: readonly CheckRun[],
  rollupState: string | null,
  headSha: string,
  prior: readonly ClaudeCiFailure[] | null | undefined,
): CiSelection {
  const carryable = new Map<string, ClaudeCiFailure>();
  for (const p of prior ?? []) {
    if (p && p.assessedAtHead === headSha && p.status === 'diagnosed' && p.jobId != null) {
      carryable.set(failureKey(p.checkName, p.jobId), p);
    }
  }
  const sel: CiSelection = {
    headSha,
    state: ciStateKind(rollupState),
    checkCount: checks.length,
    carried: [],
    toRead: [],
    noLog: [],
    overCap: [],
  };
  for (const c of checks) {
    if (!isFailingCheck(c)) continue;
    const f: FailingCheck = { checkName: c.name, jobId: c.jobId, url: c.url };
    if (c.jobId == null) {
      sel.noLog.push(f);
      continue;
    }
    const p = carryable.get(failureKey(c.name, c.jobId));
    if (p) {
      sel.carried.push({ ...p, ref: null, sent: false, carried: true, url: c.url ?? p.url });
      continue;
    }
    if (sel.toRead.length < CI_FAILURES_MAX) sel.toRead.push(f);
    else sel.overCap.push(f);
  }
  return sel;
}

/** What the manager read for one job (`ctx.ci`). `log` null ⇒ unreadable. */
export interface CiLogRead {
  check: FailingCheck;
  step: string | null;
  log: { text: string; windowTruncated: boolean } | null;
}

export interface SentCiFailure {
  ref: string;
  check: FailingCheck;
  step: string | null;
  excerpt: CiExcerpt;
}

export interface CiPlan {
  headSha: string;
  state: ClaudeReviewCiStateKind;
  checkCount: number;
  // What the model is shown, in F order.
  sent: SentCiFailure[];
  carried: ClaudeCiFailure[];
  // Not shown, each with its reason.
  unsent: Array<{ check: FailingCheck; step: string | null; reason: ClaudeCiNotCheckedReason }>;
}

/** Turn the selection + the log reads into what is sent. Over CI_BLOCK_CHARS ⇒ over_cap. */
export function planCiReview(sel: CiSelection, reads: readonly CiLogRead[]): CiPlan {
  const plan: CiPlan = {
    headSha: sel.headSha,
    state: sel.state,
    checkCount: sel.checkCount,
    sent: [],
    carried: sel.carried,
    unsent: [],
  };
  const byKey = new Map(reads.map((r) => [failureKey(r.check.checkName, r.check.jobId), r]));
  let size = 0;
  for (const c of sel.toRead) {
    const r = byKey.get(failureKey(c.checkName, c.jobId));
    const step = r?.step ?? null;
    if (!r?.log || r.log.text.trim() === '') {
      plan.unsent.push({ check: c, step, reason: 'log_unavailable' });
      continue;
    }
    const excerpt = extractFailureExcerpt(r.log.text, {
      maxChars: CI_EXCERPT_CHARS,
      windowTruncated: r.log.windowTruncated,
    });
    if (size + excerpt.text.length > CI_BLOCK_CHARS) {
      plan.unsent.push({ check: c, step, reason: 'over_cap' });
      continue;
    }
    size += excerpt.text.length;
    plan.sent.push({ ref: `F${plan.sent.length + 1}`, check: c, step, excerpt });
  }
  for (const c of sel.overCap) plan.unsent.push({ check: c, step: null, reason: 'over_cap' });
  for (const c of sel.noLog) plan.unsent.push({ check: c, step: null, reason: 'no_log' });
  return plan;
}

// ---- reconcile ----

function clip(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const CATEGORIES: ReadonlySet<string> = new Set(CLAUDE_CI_FAILURE_CATEGORIES);

function relatedFilesOf(v: unknown): ClaudeCiFailure['relatedFiles'] {
  if (!Array.isArray(v)) return [];
  const out: ClaudeCiFailure['relatedFiles'] = [];
  const seen = new Set<string>();
  for (const f of v) {
    if (out.length >= CI_RELATED_FILES_MAX) break;
    const path = clip((f as { path?: unknown } | null)?.path, CI_PATH_CHARS);
    if (!path) continue;
    const rawLine = (f as { line?: unknown }).line;
    const line = typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
    const key = `${path}:${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, line });
  }
  return out;
}

function notChecked(
  plan: CiPlan,
  check: FailingCheck,
  step: string | null,
  ref: string | null,
  reason: ClaudeCiNotCheckedReason,
): ClaudeCiFailure {
  return {
    ref,
    checkName: check.checkName,
    jobId: check.jobId,
    step,
    url: check.url,
    sent: ref != null,
    carried: false,
    status: 'not_checked',
    notCheckedReason: reason,
    cause: null,
    explanation: null,
    category: null,
    fixableInPr: null,
    relatedFiles: [],
    assessedAtHead: plan.headSha,
  };
}

/**
 * Reconcile the model's CI report against the plan. Unknown refs and malformed entries (no cause,
 * an unknown category) are dropped; a duplicate ref keeps its FIRST report; a sent ref never
 * reported is 'not_checked' / 'not_reported'. GitHub's own failed-step record beats Claude's.
 * Output: sent (F order), carried, then the unsent (log unavailable, over the cap, no log).
 */
export function reconcileCiFailures(
  plan: CiPlan,
  reported: ReadonlyArray<ReviewCiFailureReport> | undefined,
): ClaudeCiFailuresRecord {
  const known = new Set(plan.sent.map((s) => s.ref));
  const byRef = new Map<string, ReviewCiFailureReport>();
  for (const r of reported ?? []) {
    if (!r || typeof r.ref !== 'string') continue;
    const ref = r.ref.trim().toUpperCase();
    if (!known.has(ref) || byRef.has(ref)) continue;
    if (!CATEGORIES.has(r.category) || !clip(r.cause, CI_CAUSE_CHARS)) continue;
    byRef.set(ref, r);
  }
  const failures: ClaudeCiFailure[] = [];
  for (const s of plan.sent) {
    const hit = byRef.get(s.ref);
    if (!hit) {
      failures.push(notChecked(plan, s.check, s.step, s.ref, 'not_reported'));
      continue;
    }
    failures.push({
      ref: s.ref,
      checkName: s.check.checkName,
      jobId: s.check.jobId,
      step: s.step ?? clip(hit.step, CI_STEP_CHARS),
      url: s.check.url,
      sent: true,
      carried: false,
      status: 'diagnosed',
      notCheckedReason: null,
      cause: clip(hit.cause, CI_CAUSE_CHARS),
      explanation: clip(hit.explanation, CI_EXPLANATION_CHARS),
      category: hit.category as ClaudeCiFailureCategory,
      fixableInPr: typeof hit.fixableInPr === 'boolean' ? hit.fixableInPr : null,
      relatedFiles: relatedFilesOf(hit.relatedFiles),
      assessedAtHead: plan.headSha,
    });
  }
  failures.push(...plan.carried);
  for (const u of plan.unsent) failures.push(notChecked(plan, u.check, u.step, null, u.reason));
  return { state: plan.state, checkCount: plan.checkCount, failures };
}

/** The stored record when nothing was sent (all carried, or none failing): no model involved. */
export function ciRecordWithoutModel(plan: CiPlan): ClaudeCiFailuresRecord {
  return reconcileCiFailures(plan, undefined);
}
