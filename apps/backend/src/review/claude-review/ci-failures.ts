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
// the reviewed head, at most CI_FAILURES_MAX of them, each the WHOLE log up to CI_LOG_READ_BYTES
// (github/actions-logs.ts `tail: 0`, capped at its MAX_LOG_BYTES and anchored at the end). The
// whole log is PRE-SCANNED for culprit lines (`extractFailureExcerpt`) — an npm audit report names
// the offending package in the MIDDLE of a long log, where a tail window never reached — and only
// the excerpt, cut to CI_EXCERPT_CHARS per check and CI_BLOCK_CHARS in total, enters the prompt.
// The signed log URL never leaves the server, and only the check's details page is stored.
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
// How much of each job's log is read: the whole log, up to github/actions-logs.ts MAX_LOG_BYTES
// (a longer log is read from its end). Only the excerpt below leaves this module.
export const CI_LOG_READ_BYTES = 8 * 1024 * 1024;
// One check's excerpt in the prompt, and every excerpt together.
export const CI_EXCERPT_CHARS = 8_000;
export const CI_BLOCK_CHARS = 32_000;
// One log line (minified output and base64 blobs make single lines enormous).
export const CI_LINE_CHARS = 400;
// Excerpt shape: context around the primary culprit, the log's last lines.
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
// The runner's own error annotation.
const RUNNER_ERROR_RE = /##\[error\]/;
// A runner error that only reports the exit code points at the step's end, not its cause.
const EXIT_ONLY_RE = /##\[error\]\s*Process completed with exit code \d+\.?\s*$/;
// A step's header in an Actions log ("##[group]Run npm audit").
const STEP_HEADER_RE = /^##\[group\]/;

// THE PRE-SCAN'S MARKERS, three classes (all case-insensitive). A line can be a "culprit" at
// several places in one log — an npm audit report names each offending package on its own short
// block in the MIDDLE of a long log — so the excerpt anchors a window on EVERY distinct culprit line
// the budget holds, specific errors first, then generic ones, then warnings.
//   specific  a marker that names the failure itself
//   generic   words that usually sit at a failure
//   warning   worth showing only when the budget has room
const SPECIFIC_RE =
  /npm ERR!|\bERR!|\b\w+(Error|Exception):|ELIFECYCLE|Traceback \(most recent call last\)|\berror TS\d|AssertionError|panicked at|\bpanic:|found [1-9]\d* vulnerabilit|[1-9]\d* (critical|high) severity vulnerabilit|severity: (critical|high)\b|^\s*(FAIL|FAILED)\b|✕|✗|✘|\bnot ok\b/i;
// A word, not part of a path or a name ("src/error.ts", "error-ex", "on-failure").
const GENERIC_RE =
  /(?<![\w/.-])(errors?|fail|failed|failures?|failing|assert|assertion|panic|fatal|exception|critical)(?![\w/-])(?!\.\w)|exit (code|status) [1-9]|vulnerab|\bhigh severity\b/i;
const WARNING_RE = /\bwarn(ing)?\b|severity: (moderate|low)\b|\bdeprecated\b/i;
// A summary line that reports ZERO of something ("0 failed", "found 0 vulnerabilities") is not a
// culprit, whatever words it contains.
const ZERO_RE = /\b(found )?0 (errors?|failed|failures?|failing|vulnerabilit\w*|warnings?|critical|high)\b/i;

// Window shapes: the primary culprit (the first specific error, else the first generic one) gets the
// wide window the excerpt always had; every other culprit a short one.
const ANCHOR_BEFORE = 3;
const ANCHOR_AFTER = 6;
// How many culprit lines the pre-scan considers, and how many misses in a row end the greedy fill.
const MAX_ANCHORS_CONSIDERED = 400;
const MAX_MISSES_IN_A_ROW = 25;

function cleanLine(line: string): string {
  const s = line.replace(TIMESTAMP_RE, '').replace(ANSI_RE, '').replace(/\s+$/, '');
  return s.length > CI_LINE_CHARS ? `${s.slice(0, CI_LINE_CHARS)}…(line shortened)` : s;
}

/** A line's culprit class: 0 specific, 1 generic, 2 warning, -1 none. Exported for the tests. */
export function culpritClass(line: string): 0 | 1 | 2 | -1 {
  if (line.trim() === '' || ZERO_RE.test(line)) return -1;
  // The runner's "Process completed with exit code N" sits at the step's end, after the real cause:
  // the tail always shows it.
  if (EXIT_ONLY_RE.test(line)) return -1;
  if (RUNNER_ERROR_RE.test(line) || SPECIFIC_RE.test(line)) return 0;
  if (GENERIC_RE.test(line)) return 1;
  if (WARNING_RE.test(line)) return 2;
  return -1;
}

export interface CiExcerpt {
  text: string;
  // Lines of the read log shown, and lines in it.
  shownLines: number;
  windowLines: number;
  // The read did not start at the log's first byte (earlier output exists and was not read).
  windowTruncated: boolean;
  // Culprit lines the excerpt anchored a window on (the primary included).
  anchors: number;
}

/**
 * The excerpt of one job's log that Claude is shown, built by a PRE-SCAN of the whole read log:
 *   1. the window's last CI_TAIL_LINES lines (always);
 *   2. the PRIMARY culprit — the first specific error, else the first generic one, else the first
 *      runner error — with CI_CONTEXT_BEFORE / CI_CONTEXT_AFTER lines around it, and the header of
 *      the step it sits in;
 *   3. then, while the budget holds, a short window (ANCHOR_BEFORE / ANCHOR_AFTER) on every other
 *      DISTINCT culprit line — specific errors first, then generic ones, then warnings, each class
 *      in log order — plus each error's step header. Overlapping windows merge.
 * In log order, with "… N lines not shown …" between gaps; timestamps and colour codes stripped;
 * each line ≤ CI_LINE_CHARS; the whole ≤ `maxChars` (the tail is shortened first, then the primary
 * window from its end; a later window that does not fit is skipped). No culprit ⇒ the tail alone.
 * Pure.
 */
export function extractFailureExcerpt(
  raw: string,
  opts: { maxChars?: number; windowTruncated?: boolean } = {},
): CiExcerpt {
  const maxChars = opts.maxChars ?? CI_EXCERPT_CHARS;
  const lines = raw.replace(/\r\n/g, '\n').split('\n').map(cleanLine);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const n = lines.length;

  // ---- the pre-scan ----
  const byClass: [number[], number[], number[]] = [[], [], []];
  const seen = new Set<string>();
  let firstRunnerError = -1;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (firstRunnerError < 0 && RUNNER_ERROR_RE.test(l)) firstRunnerError = i;
    const c = culpritClass(l);
    if (c < 0) continue;
    // One window per distinct message: a warning repeated 500 times is anchored once.
    const key = l.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    byClass[c as 0 | 1 | 2].push(i);
  }
  const primary = byClass[0][0] ?? byClass[1][0] ?? firstRunnerError;
  const stepHeaderBefore = (i: number): number => {
    for (let j = i; j >= 0; j--) if (STEP_HEADER_RE.test(lines[j]!)) return j;
    return -1;
  };

  // ---- rendering ----
  const tailFloor = Math.max(0, n - CI_TAIL_LINES);
  let tailFrom = tailFloor;
  let errFrom = -1;
  let errTo = -1;
  let primaryHeader = -1;
  if (primary >= 0) {
    errFrom = Math.max(0, primary - CI_CONTEXT_BEFORE);
    errTo = Math.min(n - 1, primary + CI_CONTEXT_AFTER);
    primaryHeader = stepHeaderBefore(primary);
  }
  // Lines added by the later windows (never shrunk: a window that does not fit is not added).
  const extra = new Set<number>();
  let anchors = primary >= 0 ? 1 : 0;

  const keptSet = (): Set<number> => {
    const keep = new Set<number>(extra);
    if (primary >= 0) {
      for (let i = errFrom; i <= errTo; i++) keep.add(i);
      if (primaryHeader >= 0) keep.add(primaryHeader);
    }
    for (let i = tailFrom; i < n; i++) keep.add(i);
    return keep;
  };
  const render = (keep: Set<number>): string => {
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

  let keep = keptSet();
  let text = render(keep);
  // Over budget: shorten the tail first (the error block is the point), then the error block.
  // Each loop is bounded by its own line count (≤ CI_TAIL_LINES, ≤ CI_CONTEXT_AFTER).
  while (text.length > maxChars && tailFrom < n - 1) {
    tailFrom += 1;
    keep = keptSet();
    text = render(keep);
  }
  while (text.length > maxChars && primary >= 0 && errTo > primary) {
    errTo -= 1;
    keep = keptSet();
    text = render(keep);
  }

  // ---- the other culprits, greedily, while the budget holds ----
  if (text.length <= maxChars) {
    const order = [...byClass[0], ...byClass[1], ...byClass[2]].filter((i) => i !== primary).slice(0, MAX_ANCHORS_CONSIDERED);
    let misses = 0;
    for (const at of order) {
      if (misses >= MAX_MISSES_IN_A_ROW) break;
      const add: number[] = [];
      for (let i = Math.max(0, at - ANCHOR_BEFORE); i <= Math.min(n - 1, at + ANCHOR_AFTER); i++) add.push(i);
      if (culpritClass(lines[at]!) !== 2) {
        const h = stepHeaderBefore(at);
        if (h >= 0) add.push(h);
      }
      const fresh = add.filter((i) => !keep.has(i));
      if (fresh.length === 0) {
        anchors += 1;
        continue;
      }
      const trial = new Set(keep);
      for (const i of fresh) trial.add(i);
      const t = render(trial);
      if (t.length > maxChars) {
        misses += 1;
        continue;
      }
      misses = 0;
      for (const i of fresh) extra.add(i);
      keep = trial;
      text = t;
      anchors += 1;
    }
  }

  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(shortened)`;
  return {
    text,
    shownLines: keep.size,
    windowLines: n,
    windowTruncated: opts.windowTruncated ?? false,
    anchors,
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
    confidence: null,
  };
}

/** Claude's 0-100 confidence, rounded and clamped; null when absent or not a number. */
export function confidenceOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
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
      confidence: confidenceOf(hit.confidence),
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
