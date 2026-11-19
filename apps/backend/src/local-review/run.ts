// REVIEW A LOCAL BRANCH — THE RUN (docs/CLAUDE-REVIEW.md § Reviewing a local branch). The server half of
// `ensemble mcp` / `ensemble review`: a reader's coding agent asks for a review of the branch it works on,
// before anything is pushed.
//
//   POST ──► the repository (origin owner/name → a SYNCED repo of this account; its HOME workspace gives the
//            review settings, the reference docs and the tracker)
//        ──► THE CLAIM (one run in flight per repository and branch: a second start gets the running id)
//        ──► THE INTAKE (the bundle → the clone cache, fsck on, under the repo lock, OUTSIDE any transaction;
//            pinned as refs/pierre/local/local-review/<id>/head and HELD while the run reads it)
//        ──► (in the background) the code review — the SAME halves as the review loops
//            (coding/review-loop/branch-review.ts `runBranchReviewHalf`, head {localRef, sha}); a Claude + Codex
//            pair from Settings → AI → Review runs AT ONCE, blind, and is consolidated into ONE review —
//            beside the story check when a ticket resolves (`runBranchStoryCheck`)
//        ──► the row, the findings; the ref is dropped.
//
// RULES:
//   • It is a READER'S CLICK: never asked of the spend gate (`byReader: true`), spend recorded under
//     LOCAL_REVIEW_FEATURE / LOCAL_REVIEW_CHECK_FEATURE.
//   • NOTHING reaches GitHub but the base fetch: no post, no push, no team claim, no My Turn card, no Slack, no
//     auto fix, no claude_reviews or ticket_reviews row (local-review/no-side-effects.test.ts pins it).
//   • The ticket is read on the reader's ask (a LABELLED exception to "read when a PR is received",
//     docs/TRACKERS.md).
//   • FOLLOW-UP: answers to the branch's previous run (F<id> findings, AC<n> / M<n> criteria) use the review
//     loop's vocabulary and validator (coding/review-loop/response.ts); the next review judges the findings as
//     the loop does (`priorForTarget`); a `cannot_meet` criterion stays NOT MET, with its reason.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  LOCAL_REVIEW_CHECK_FEATURE,
  LOCAL_REVIEW_FEATURE,
  type AiEffort,
  type AiProviderId,
  type ClaudeReview,
  type ClaudeReviewTicket,
  type ClaudeReviewVerdict,
  type LocalReview,
  type LocalReviewAnswer,
  type LocalReviewCriterion,
  type LocalReviewKind,
  type LocalReviewListItem,
  type LocalReviewStartResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import type { BranchPairConsolidation, BranchReviewHalfInput, BranchReviewHalfResult } from '../coding/review-loop/branch-review.js';
import { pairConsolidationRecord, pairRoleOf } from '../coding/review-loop/branch-review.js';
import type { BranchStoryCheckInput, BranchStoryCheckResult, StoryCheckClaim } from '../coding/review-loop/story-check.js';
import { acceptedNa, notCheckedFindingsOf, openCriteriaOf, openFindingsOf, priorForTarget } from '../coding/review-loop/rounds.js';
import { validateReviewResponse } from '../coding/review-loop/response.js';
import { holdLocalRefs, localRefName, registerLocalRefKeeper } from '../review/local-refs.js';
import { extractTicketKeys } from '../tracker/detect.js';
import {
  BRANCH_TARGET,
  claimLocalReview,
  failOrphanedLocalReviews,
  finishLocalReview,
  getLocalReview,
  insertLocalFindings,
  listLocalFindings,
  listLocalReviews,
  loopChecksOf,
  loopFindingsOf,
  loopRunsOf,
  runningLocalReviewIds,
  updateLocalFinding,
  updateLocalReview,
  type LocalReviewFindingRow,
  type LocalReviewHalf,
  type LocalReviewRow,
} from './persist.js';

/** The local refs' owner kind (review/local-refs.ts): refs/pierre/local/local-review/<id>/head. */
export const LOCAL_REVIEW_REF_KIND = 'local-review';

/** A start the server refuses: one plain line, with the HTTP status the route answers. */
export class LocalReviewRefusal extends Error {
  constructor(
    readonly code: 'not_tracked' | 'not_synced' | 'no_reviewer' | 'bad_bundle' | 'no_ticket' | 'bad_request',
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'LocalReviewRefusal';
  }
}

export interface LocalReviewStartInput {
  owner: string;
  name: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  bundle: Buffer;
  subjects: string[];
  includeUncommitted: boolean;
  uncommittedChanges: boolean;
  kind: LocalReviewKind;
  ticket: string | null;
  provider: AiProviderId | null;
  effort: AiEffort | null;
  answers: unknown[];
}

export interface ResolvedTicket {
  ident: string;
  key: string;
  title: string;
  url: string | null;
  ticket: ClaudeReviewTicket;
}

export interface LocalReviewSeams {
  now(): Date;
  /** The reader's GitHub token (the base fetch), or null. */
  token(accountId: number): Promise<string | null>;
  /** The bundle → the clone cache under `destRef` (clone-manager.ts `fetchBundleIntoClone`). */
  intake(a: { owner: string; name: string; bundle: Buffer; baseSha: string; headSha: string; destRef: string; token: string | null }): Promise<void>;
  holdRefs(id: number): () => void;
  dropRefs(owner: string, name: string, id: number): Promise<void>;
  /** Who reviews: the reader's one vendor, else Settings → AI → Review (a pair when both are on and signed in). */
  providers(ctx: AgentContext, choice: AiProviderId | null): Promise<AiProviderId[]>;
  storyProvider(ctx: AgentContext, choice: AiProviderId | null): Promise<AiProviderId | null>;
  /** Why nobody can run `kind` (the pre-flight's own sentence: not signed in, switched off, not installed …). */
  whyNoProvider(ctx: AgentContext, choice: AiProviderId | null, kind: 'review' | 'ticket_review'): Promise<string>;
  /** How long a start waits for the intake before it answers with the id (the intake then goes on behind it). */
  intakeWaitMs: number;
  /** The workspace's tracker project keys (the detection allowlist), or null when none. */
  allowKeys(ctx: AgentContext, accountId: number, workspaceId: number): Promise<string[] | null>;
  /** The ticket of `key` as the story view shows it — read on the reader's ask — or a plain reason. */
  ticket(ctx: AgentContext, accountId: number, workspaceId: number, key: string): Promise<ResolvedTicket | { note: string }>;
  runHalf(ctx: AgentContext, i: BranchReviewHalfInput): Promise<BranchReviewHalfResult>;
  runStoryCheck(ctx: AgentContext, i: BranchStoryCheckInput): Promise<BranchStoryCheckResult>;
  consolidate(ctx: AgentContext, accountId: number, a: ClaudeReview, b: ClaudeReview): Promise<BranchPairConsolidation>;
}

export function defaultLocalReviewSeams(): LocalReviewSeams {
  return {
    now: () => new Date(),
    async token(accountId) {
      try {
        const { getAccessToken } = await import('../auth/account.js');
        return await getAccessToken(accountId);
      } catch {
        return null;
      }
    },
    async intake(a) {
      const [{ fetchBundleIntoClone }] = await Promise.all([import('../review/clone-manager.js')]);
      const dir = mkdtempSync(join(tmpdir(), 'ensemble-local-review-'));
      try {
        const file = join(dir, 'branch.bundle');
        writeFileSync(file, a.bundle, { mode: 0o600 });
        await fetchBundleIntoClone(a.owner, a.name, { bundlePath: file, baseSha: a.baseSha, headSha: a.headSha, destRef: a.destRef }, a.token);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    holdRefs: (id) => holdRefsSync(id),
    async dropRefs(owner, name, id) {
      const { dropLocalRefs } = await import('../review/local-refs.js');
      await dropLocalRefs(owner, name, LOCAL_REVIEW_REF_KIND, id);
    },
    async providers(ctx, choice) {
      const [{ preflightFor }, { reviewPairProviders, reviewDefaultProvider }, { isLockedOut, anyUsageLockout }] = await Promise.all([
        import('../ai/run-choice.js'),
        import('../ai/run-profile.js'),
        import('../ai/usage-lockout.js'),
      ]);
      const detect = preflightFor(ctx);
      const ok = (p: AiProviderId) => detect(p, 'review').status === 'ok';
      if (choice != null) return ok(choice) ? [choice] : [];
      const locked = (p: AiProviderId) => anyUsageLockout() && isLockedOut(p);
      const pair = reviewPairProviders(detect).filter((p) => !locked(p));
      if (pair.length >= 2) return pair.slice(0, 2);
      if (pair.length === 1) return pair;
      const one = reviewDefaultProvider(detect);
      return ok(one) ? [one] : [];
    },
    async storyProvider(ctx, choice) {
      const { preflightFor } = await import('../ai/run-choice.js');
      const detect = preflightFor(ctx);
      if (choice != null) return detect(choice, 'ticket_review').status === 'ok' ? choice : null;
      const { storyCheckProvider } = await import('../coding/review-loop/branch-review.js');
      const p = await storyCheckProvider();
      return detect(p, 'ticket_review').status === 'ok' ? p : null;
    },
    async whyNoProvider(ctx, choice, kind) {
      const [{ preflightFor }, { reviewDefaultProvider }, { usageLockedUntilIso }] = await Promise.all([
        import('../ai/run-choice.js'),
        import('../ai/run-profile.js'),
        import('../ai/usage-lockout.js'),
      ]);
      const detect = preflightFor(ctx);
      const p = choice ?? reviewDefaultProvider(detect);
      const vendor = p === 'codex' ? 'Codex' : 'Claude';
      const until = usageLockedUntilIso(p);
      if (until) return `${vendor} is over its usage limit until ${until.slice(0, 16).replace('T', ' ')} UTC.`;
      const said = detect(p, kind).message?.trim();
      return said ? said : `${vendor} cannot run in Ensemble now. Check Settings → AI.`;
    },
    intakeWaitMs: 20_000,
    async allowKeys(ctx, accountId, workspaceId) {
      const { parseProjectKeys } = await import('../tracker/detect.js');
      const t = ctx.schema.workspaceTrackers;
      const rows = (await ctx.db
        .select({ projectKeys: t.projectKeys })
        .from(t)
        .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
        .limit(1)
        .execute()) as Array<{ projectKeys: string | null }>;
      const keys = parseProjectKeys(rows[0]?.projectKeys ?? null);
      return keys.length > 0 ? keys : null;
    },
    ticket: (ctx, accountId, workspaceId, key) => readLocalTicket(ctx, accountId, workspaceId, key),
    runHalf: async (ctx, i) => (await import('../coding/review-loop/branch-review.js')).runBranchReviewHalf(ctx, i),
    runStoryCheck: async (ctx, i) => (await import('../coding/review-loop/story-check.js')).runBranchStoryCheck(ctx, i),
    consolidate: async (ctx, accountId, a, b) => (await import('../coding/review-loop/branch-review.js')).consolidateBranchPair(ctx, accountId, a, b),
  };
}

// The hold is taken SYNCHRONOUSLY at the claim (before any await): local-refs.ts is imported eagerly.
function holdRefsSync(id: number): () => void {
  return holdLocalRefs(LOCAL_REVIEW_REF_KIND, id);
}

let seams: LocalReviewSeams = defaultLocalReviewSeams();

/** Test seam: replace any of the seams (null ⇒ the real ones). */
export function setLocalReviewSeamsForTests(s: Partial<LocalReviewSeams> | null): void {
  seams = s == null ? defaultLocalReviewSeams() : { ...defaultLocalReviewSeams(), ...s };
}

// ---- in-process state ---------------------------------------------------------------------------------------

interface Active {
  abort: AbortController;
  releaseRefs: () => void;
  done: Promise<void>;
}

const active = new Map<number, Active>();
const waiters = new Map<number, Set<() => void>>();

function wake(id: number): void {
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  for (const f of w) f();
}

/** Wait (at most `ms`) for a run to end. Resolves at once when it is not running in this process. */
export function waitForLocalReview(id: number, ms: number): Promise<void> {
  if (!active.has(id) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set<() => void>();
    waiters.set(id, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

/** Test seam: wait until no run works in this process. */
export async function _localReviewsIdleForTest(): Promise<void> {
  await Promise.all([...active.values()].map((a) => a.done.catch(() => {})));
}

export function _resetLocalReviewsForTest(): void {
  for (const a of active.values()) {
    a.abort.abort();
    a.releaseRefs();
  }
  active.clear();
  waiters.clear();
}

/**
 * The keeper of this kind's refs (review/local-refs.ts): a run's head is kept only while its row is still
 * 'running' (a restart fails those first, so the boot sweep drops what they left). Registered once at boot.
 */
export function bindLocalReviews(ctx: AgentContext): void {
  registerLocalRefKeeper(LOCAL_REVIEW_REF_KIND, (ids) => runningLocalReviewIds(ctx, ids));
}

/** A run this process lost is failed at boot (its ref is then swept). Never throws. */
export async function reconcileLocalReviewsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await failOrphanedLocalReviews(ctx).catch(() => 0);
  if (n > 0) ctx.log.info(`local reviews: ${n} run(s) a restart cut off were marked failed`);
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0]! : String(err));

// ---- the repository ------------------------------------------------------------------------------------------

export interface LocalRepo {
  repoId: number;
  owner: string;
  name: string;
  workspaceId: number;
}

/** origin owner/name → this account's SYNCED repository and its home workspace, or a refusal. */
export async function resolveLocalRepo(ctx: Pick<AgentContext, 'db' | 'schema'>, accountId: number, owner: string, name: string): Promise<LocalRepo> {
  const r = ctx.schema.repos;
  const rows = (await ctx.db
    .select({ id: r.id, owner: r.owner, name: r.name })
    .from(r)
    .where(and(eq(r.accountId, accountId), sql`lower(${r.owner}) = ${owner.toLowerCase()}`, sql`lower(${r.name}) = ${name.toLowerCase()}`))
    .limit(1)
    .execute()) as Array<{ id: number; owner: string; name: string }>;
  const repo = rows[0];
  const full = `${owner}/${name}`;
  if (!repo) throw new LocalReviewRefusal('not_tracked', `Ensemble does not track ${full}. Add it to a workspace in Ensemble first.`);
  const wr = ctx.schema.workspaceRepos;
  const home = (await ctx.db
    .select({ workspaceId: wr.workspaceId })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), eq(wr.repoId, repo.id)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number }>;
  if (!home[0]) throw new LocalReviewRefusal('not_tracked', `${full} is in no workspace. Add it to a workspace in Ensemble first.`);
  const ss = ctx.schema.syncState;
  const synced = (await ctx.db.select({ at: ss.lastFullSyncAt }).from(ss).where(eq(ss.repoId, repo.id)).limit(1).execute()) as Array<{ at: Date | null }>;
  if (synced[0]?.at == null) throw new LocalReviewRefusal('not_synced', `Ensemble has not finished its first sync of ${full}. Try again when it has.`);
  return { repoId: repo.id, owner: repo.owner, name: repo.name, workspaceId: home[0].workspaceId };
}

// ---- the start ------------------------------------------------------------------------------------------------

/** The answers the previous run can take: its open findings (F<id>) and open criteria (AC<n> / M<n>). */
async function answerableRefs(ctx: AgentContext, accountId: number, branchRuns: readonly LocalReviewRow[]): Promise<{ shown: string[]; prior: LocalReviewRow | null }> {
  const prior = branchRuns.find((r) => r.status === 'succeeded') ?? null;
  if (!prior) return { shown: [], prior: null };
  const findings = await listLocalFindings(ctx, accountId, branchRuns.map((r) => r.id));
  const { reviews, roundOf } = loopRunsOf(branchRuns);
  const round = roundOf.get(prior.id)!;
  const runIds = new Set(reviews.filter((r) => r.round === round && r.status === 'succeeded').map((r) => r.id));
  const lf = loopFindingsOf(findings);
  const open = [...openFindingsOf(lf, runIds), ...notCheckedFindingsOf(reviews, lf, round)];
  const checks = loopChecksOf(branchRuns, roundOf);
  const check = checks.find((c) => c.round === round && c.status === 'succeeded') ?? null;
  return { shown: [...new Set(open.map((f) => `F${f.id}`)), ...openCriteriaOf(check, checks).map((c) => c.ref.toUpperCase())], prior };
}

/**
 * START a run (see the header). Returns the running id at once; the review goes on in the background. A second
 * start of the same branch while one runs returns that run's id (`alreadyRunning`). Throws `LocalReviewRefusal`.
 */
export async function startLocalReview(ctx: AgentContext, accountId: number, input: LocalReviewStartInput): Promise<LocalReviewStartResponse> {
  const repo = await resolveLocalRepo(ctx, accountId, input.owner, input.name);
  // Who runs, before anything is claimed: nobody signed in is a plain refusal.
  const providers = input.kind === 'review' ? await seams.providers(ctx, input.provider) : [];
  if (input.kind === 'review' && providers.length === 0) {
    throw new LocalReviewRefusal('no_reviewer', await seams.whyNoProvider(ctx, input.provider, 'review'));
  }
  if (input.kind === 'story' && (await seams.storyProvider(ctx, input.provider)) == null) {
    throw new LocalReviewRefusal('no_reviewer', await seams.whyNoProvider(ctx, input.provider, 'ticket_review'));
  }

  // The answers to the previous run, checked with the review loop's own validator.
  const branchRuns = await listLocalReviews(ctx, accountId, repo.repoId, input.branch, 20);
  const { shown, prior } = await answerableRefs(ctx, accountId, branchRuns);
  const raw = (input.answers ?? []).map((a) => (a && typeof a === 'object' ? { ...(a as object), ref: String((a as { ref?: unknown }).ref ?? '').trim().toUpperCase() } : a));
  const checked = validateReviewResponse({ items: raw }, shown);
  const answers: LocalReviewAnswer[] = (checked.payload?.items ?? []).map((it) => ({ ref: it.ref, action: it.action, reply: it.reply }));
  const ignoredAnswers = raw.length === 0 ? [] : localAnswerProblems(checked.problems, shown);

  const claim = await claimLocalReview(ctx, accountId, {
    repoId: repo.repoId,
    workspaceId: repo.workspaceId,
    kind: input.kind,
    branch: input.branch,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    includeUncommitted: input.includeUncommitted,
    uncommittedChanges: input.uncommittedChanges,
    subjects: input.subjects,
    providerChoice: input.provider,
    effortChoice: input.effort,
  });
  if (claim.alreadyRunning) {
    // The running run took its answers when it started: these are not used (said, never dropped silently).
    const unused = raw.length > 0 ? [`A review of this branch is already running (id ${claim.id}), so ${raw.length === 1 ? 'the answer was' : `the ${raw.length} answers were`} not used. Send ${raw.length === 1 ? 'it' : 'them'} with the next review.`] : [];
    return { id: claim.id, status: 'running', alreadyRunning: true, ignoredAnswers: unused };
  }
  const id = claim.id;
  const a: Active = { abort: new AbortController(), releaseRefs: seams.holdRefs(id), done: Promise.resolve() };
  active.set(id, a);
  // ⚠ From the claim on, EVERY failure finishes the row and lets go of the run (`giveUp`): a row left 'running'
  // would hold the branch (the one-running index) and make every read wait its full long-poll.
  let given = false;
  const giveUp = async (reason: string, status: 'failed' | 'cancelled' = 'failed'): Promise<void> => {
    if (given) return;
    given = true;
    await finishLocalReview(ctx, accountId, id, status, { failureReason: reason, completedAt: seams.now() }).catch(() => {});
    a.releaseRefs();
    active.delete(id);
    await seams.dropRefs(repo.owner, repo.name, id).catch(() => {});
    wake(id);
  };

  // THE INTAKE (outside any transaction; the repo lock is the clone manager's). A start waits for it at most
  // `intakeWaitMs` — a first clone of the repository can take minutes, and an MCP tool call must answer sooner —
  // then answers with the id; the intake goes on behind it and a refusal then FAILS the run (read with get).
  const destRef = localRefName({ kind: LOCAL_REVIEW_REF_KIND, id, name: 'head' });
  const intake: Promise<string | null> = (async () => {
    try {
      await seams.intake({ owner: repo.owner, name: repo.name, bundle: input.bundle, baseSha: input.baseSha, headSha: input.headSha, destRef, token: await seams.token(accountId) });
      return null;
    } catch (err) {
      return err instanceof Error && err.name === 'BundleRefusedError' ? err.message : `Ensemble could not read the branch: ${errMsg(err)}`;
    }
  })();
  // After the intake: the answers, then the background run. Every throw here gives the run up.
  const afterIntake = async (refused: string | null): Promise<void> => {
    if (refused != null) return giveUp(refused);
    if (a.abort.signal.aborted) return giveUp('Cancelled.', 'cancelled');
    try {
      await updateLocalReview(ctx, accountId, id, { localRef: destRef, answers, priorReviewId: prior?.id ?? null });
      // The finding answers land on the earlier findings (the next review judges them as the loop does).
      for (const ans of answers) {
        const m = /^F(\d+)$/.exec(ans.ref);
        if (!m || (ans.action !== 'fixed' && ans.action !== 'answered' && ans.action !== 'pushed_back')) continue;
        await updateLocalFinding(ctx, accountId, Number(m[1]), { response: ans.action, responseText: ans.reply, responseReviewId: id });
      }
    } catch (err) {
      return giveUp(`Ensemble could not start the review: ${errMsg(err)}`);
    }
    if (a.abort.signal.aborted) return giveUp('Cancelled.', 'cancelled');
    given = true; // runLocalReview owns the cleanup from here
    await runLocalReview(ctx, accountId, id, repo, providers, input, a).catch((err) => {
      ctx.log.warn(`local review ${id}: ${errMsg(err)}`);
    });
  };

  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([intake, new Promise<'pending'>((r) => (timer = setTimeout(() => r('pending'), seams.intakeWaitMs)))]);
  clearTimeout(timer);
  if (waited === 'pending') {
    a.done = intake.then(afterIntake).catch((err) => giveUp(`Ensemble could not start the review: ${errMsg(err)}`));
    return { id, status: 'running', alreadyRunning: false, ignoredAnswers };
  }
  if (waited != null) {
    await giveUp(waited);
    throw new LocalReviewRefusal('bad_bundle', waited);
  }
  a.done = afterIntake(null).catch((err) => giveUp(`Ensemble could not start the review: ${errMsg(err)}`));
  return { id, status: 'running', alreadyRunning: false, ignoredAnswers };
}

/**
 * The validator's problems, worded for THIS surface (an agent calling a tool: it has no REVIEW.md and sent
 * `answers`, not `items`). An answer missing for an open item is not a problem here (answers are optional).
 */
export function localAnswerProblems(problems: readonly string[], shown: readonly string[]): string[] {
  const open = shown.length > 0 ? ` The open ones are ${shown.join(', ')}.` : ' The last review of this branch left nothing open.';
  return problems
    .filter((p) => !p.endsWith(' has no answer.'))
    .map((p) =>
      p
        .replace(/^"items"\[(\d+)\]\.ref "([^"]*)" is not an item in REVIEW\.md\.$/, (_m, n: string, ref: string) => `answers[${n}]: "${ref}" is not an open finding or criterion of the last review of this branch.${open}`)
        .replace(/^"items"\[(\d+)\]\.ref must be the ref of an item in REVIEW\.md\.$/, (_m, n: string) => `answers[${n}].ref must name an open finding (F<id>) or criterion (AC<n> / M<n>) of the last review of this branch.`)
        .replace(/"items"\[(\d+)\]/g, 'answers[$1]')
        .replace(/"items"/g, '"answers"'),
    );
}

/** CANCEL: abort a running run (its reviews stop at the next checkpoint). false ⇒ it was not running. */
export async function cancelLocalReview(ctx: AgentContext, accountId: number, id: number): Promise<boolean> {
  const row = await getLocalReview(ctx, accountId, id);
  if (!row || row.status !== 'running') return false;
  const ok = await finishLocalReview(ctx, accountId, id, 'cancelled', { failureReason: 'Cancelled.', completedAt: seams.now() });
  const a = active.get(id);
  a?.abort.abort();
  if (!a) wake(id);
  return ok;
}

// ---- the background run ---------------------------------------------------------------------------------------

async function runLocalReview(ctx: AgentContext, accountId: number, id: number, repo: LocalRepo, providers: AiProviderId[], input: LocalReviewStartInput, a: Active): Promise<void> {
  const head = { localRef: localRefName({ kind: LOCAL_REVIEW_REF_KIND, id, name: 'head' }), sha: input.headSha };
  const fullName = `${repo.owner}/${repo.name}`;
  try {
    if (a.abort.signal.aborted) return;
    const branchRuns = (await listLocalReviews(ctx, accountId, repo.repoId, input.branch, 20)).filter((r) => r.id !== id);
    const row = (await getLocalReview(ctx, accountId, id))!;
    const answers = row.answers ?? [];

    // THE TICKET: the explicit key, else the workspace's detection (allowlist: branch + subjects; none:
    // upper-case keys in the commit subjects only, as a PR title is read).
    const ticket = await resolveTicket(ctx, accountId, repo.workspaceId, input);
    if (a.abort.signal.aborted) return;
    if ('note' in ticket) {
      await updateLocalReview(ctx, accountId, id, { ticketNote: ticket.note, ...(ticket.key ? { ticketKey: ticket.key } : {}) });
      if (input.kind === 'story') {
        await finishLocalReview(ctx, accountId, id, 'failed', { failureReason: ticket.note, completedAt: seams.now() });
        return;
      }
    } else {
      await updateLocalReview(ctx, accountId, id, { ticketKey: ticket.key, ticketIdent: ticket.ident, ticketTitle: ticket.title, ticketUrl: ticket.url });
    }
    const storyProvider = 'note' in ticket ? null : await seams.storyProvider(ctx, input.provider);
    if (!('note' in ticket) && storyProvider == null) {
      await updateLocalReview(ctx, accountId, id, { ticketNote: 'No AI is signed in to check the story.' });
    }

    // THE STORY CHECK (beside the code review).
    const findingsBefore = await listLocalFindings(ctx, accountId, branchRuns.map((r) => r.id));
    const prevCheck = [...branchRuns].filter((r) => r.storyStatus === 'succeeded' && r.assessment != null)[0] ?? null;
    const claims: StoryCheckClaim[] = answers
      .filter((x) => /^(AC|M)\d+$/.test(x.ref) && x.action !== 'fixed' && x.reply.trim() !== '')
      .map((x) => ({ ref: x.ref, kind: x.action === 'not_applicable' ? ('not_applicable' as const) : ('answer' as const), text: x.reply }));
    const checkP: Promise<void> =
      !('note' in ticket) && storyProvider
        ? (async () => {
            await updateLocalReview(ctx, accountId, id, { storyStatus: 'running', storyProvider, claims });
            const res = await seams.runStoryCheck(ctx, {
              accountId,
              workspaceId: repo.workspaceId,
              ident: ticket.ident,
              ticket: ticket.ticket,
              targets: [{ ref: 'PR1', id: 1, repoId: repo.repoId, repo: fullName, owner: repo.owner, name: repo.name, branch: input.branch, head, baseSha: input.baseSha, title: input.subjects[0] ?? input.branch }],
              prior: prevCheck?.assessment ? { assessment: prevCheck.assessment, changedTargetIds: [1] } : null,
              claims,
              provider: storyProvider,
              abort: a.abort,
              feature: LOCAL_REVIEW_CHECK_FEATURE,
            });
            await updateLocalReview(ctx, accountId, id, {
              storyStatus: res.status,
              storyModel: res.model,
              storyFailure: res.failureReason,
              assessment: res.assessment,
              claimVerdicts: res.claimVerdicts,
            });
            await addSpend(ctx, accountId, id, res);
          })().catch(async (err) => {
            await updateLocalReview(ctx, accountId, id, { storyStatus: 'failed', storyFailure: errMsg(err) }).catch(() => {});
          })
        : Promise.resolve();

    // THE CODE REVIEW: a pair's halves AT ONCE (blind), consolidated — ONE review.
    let halves: LocalReviewHalf[] = [];
    if (input.kind === 'review') {
      const all = [...branchRuns, row];
      const { reviews } = loopRunsOf(all);
      const lf = loopFindingsOf(findingsBefore);
      const round = loopRunsOf([...branchRuns, row]).roundOf.get(id)!;
      const title = input.subjects[0] ?? input.branch;
      const body = [
        input.subjects.length > 1 ? `Commits on this branch (newest first):\n${input.subjects.slice(0, 30).map((s) => `- ${s}`).join('\n')}` : '',
        input.uncommittedChanges ? 'This review includes uncommitted changes (not committed or pushed yet).' : '',
      ]
        .filter((x) => x !== '')
        .join('\n\n');
      const results = await Promise.all(
        providers.map(async (p, n) => {
          const res = await seams.runHalf(ctx, {
            accountId,
            workspaceId: repo.workspaceId,
            repo: { owner: repo.owner, name: repo.name, fullName, repoId: repo.repoId },
            branch: input.branch,
            title,
            body,
            baseRef: input.baseRef,
            baseSha: input.baseSha,
            head,
            provider: p,
            prior: priorForTarget(reviews, lf, BRANCH_TARGET.kind, BRANCH_TARGET.id, round, p),
            abort: a.abort,
            byReader: true,
            feature: LOCAL_REVIEW_FEATURE,
            ledgerFeature: LOCAL_REVIEW_FEATURE,
            ...(input.effort ? { effort: input.effort } : {}),
          });
          if (res.status === 'succeeded') {
            await insertLocalFindings(
              ctx,
              accountId,
              res.findings.map((f) => ({
                localReviewId: id,
                half: n,
                provider: res.ranOn.provider,
                severity: f.severity,
                path: f.path,
                line: f.line,
                side: f.side,
                title: f.title,
                body: f.body,
                suggestion: f.suggestion,
                diffHunk: f.diffHunk,
                anchored: f.anchored,
                fileInDiff: f.fileInDiff,
                priorFindingId: f.priorFindingId,
                lens: f.lens ?? null,
              })),
            );
          }
          await addSpend(ctx, accountId, id, res);
          return res;
        }),
      );
      halves = results.map((res, n) => ({
        provider: res.ranOn.provider,
        model: res.ranOn.model,
        effort: res.ranOn.effort,
        status: res.status,
        failureReason: res.failureReason,
        pairRole: pairRoleOf(n, providers.length),
        followUp: res.followUp,
      }));
      const ok = results.map((r, n) => ({ r, n })).filter((x) => x.r.status === 'succeeded');
      const lead = ok[0]?.r ?? null;
      let summary = lead?.summary ?? null;
      let verdict = lead?.verdict ?? null;
      let pairConsolidation: Record<string, unknown> | null = null;
      // A PAIR whose two halves succeeded: ONE consolidated review (duplicates merged, one verdict).
      if (ok.length === 2) {
        const fs = await listLocalFindings(ctx, accountId, [id]);
        const c = await seams.consolidate(ctx, accountId, halfWire(id, 0, halves[0]!, results[0]!, input.headSha, fs), halfWire(id, 1, halves[1]!, results[1]!, input.headSha, fs)).catch(() => null);
        if (c) {
          for (const [dropped, keep] of Object.entries(c.mergedFrom)) await updateLocalFinding(ctx, accountId, Number(dropped), { mergedInto: keep });
          summary = c.summary ?? summary;
          verdict = c.verdict ?? verdict;
          pairConsolidation = pairConsolidationRecord(c, seams.now()) as unknown as Record<string, unknown>;
        }
      }
      await updateLocalReview(ctx, accountId, id, { reviewers: halves, summary, verdict, pairConsolidation });
    }
    await checkP;
    if (a.abort.signal.aborted) return;
    const now = await getLocalReview(ctx, accountId, id);
    if (!now || now.status !== 'running') return;
    const reviewOk = input.kind === 'story' || halves.some((h) => h.status === 'succeeded');
    const storyOk = now.storyStatus == null || now.storyStatus === 'succeeded';
    if (input.kind === 'story' && now.storyStatus !== 'succeeded') {
      await finishLocalReview(ctx, accountId, id, 'failed', { failureReason: now.storyFailure ?? 'The story check did not finish.', completedAt: seams.now() });
    } else if (!reviewOk) {
      const why = halves.map((h) => h.failureReason).find((x) => x != null) ?? 'The review did not finish.';
      await finishLocalReview(ctx, accountId, id, halves.every((h) => h.status === 'cancelled') ? 'cancelled' : 'failed', { failureReason: why, completedAt: seams.now() });
    } else {
      await finishLocalReview(ctx, accountId, id, 'succeeded', { completedAt: seams.now(), ...(storyOk ? {} : { failureReason: null }) });
    }
  } catch (err) {
    await finishLocalReview(ctx, accountId, id, 'failed', { failureReason: errMsg(err), completedAt: seams.now() }).catch(() => {});
  } finally {
    a.releaseRefs();
    active.delete(id);
    await seams.dropRefs(repo.owner, repo.name, id).catch(() => {});
    wake(id);
  }
}

/** Add one run's spend to the row's totals (the ledger itself is written by the runners). */
async function addSpend(ctx: AgentContext, accountId: number, id: number, r: { costUsd: number | null; inputTokens: number | null; outputTokens: number | null }): Promise<void> {
  if (r.costUsd == null && r.inputTokens == null && r.outputTokens == null) return;
  const t = ctx.schema.localReviews;
  await ctx.db
    .update(t)
    .set({
      costUsd: sql`coalesce(${t.costUsd}, 0) + ${r.costUsd ?? 0}`,
      inputTokens: sql`coalesce(${t.inputTokens}, 0) + ${r.inputTokens ?? 0}`,
      outputTokens: sql`coalesce(${t.outputTokens}, 0) + ${r.outputTokens ?? 0}`,
    })
    .where(and(eq(t.id, id), eq(t.accountId, accountId)))
    .execute()
    .catch(() => {});
}

// ---- the ticket -------------------------------------------------------------------------------------------------

/** The explicit key, else detection (see the run). A refusal is a plain note (the code review still runs). */
export async function resolveTicket(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  input: Pick<LocalReviewStartInput, 'ticket' | 'branch' | 'subjects'>,
): Promise<ResolvedTicket | { note: string; key?: string }> {
  let key: string | null = null;
  if (input.ticket != null && input.ticket.trim() !== '') {
    const { canonicalTicketKey } = await import('@pierre-review/shared');
    key = canonicalTicketKey(input.ticket);
    if (key == null) return { note: `"${input.ticket.trim().slice(0, 60)}" is not a ticket key.` };
  } else {
    const allow = await seams.allowKeys(ctx, accountId, workspaceId).catch(() => null);
    key = detectTicketKey(input.branch, input.subjects, allow);
    if (key == null) {
      return {
        note:
          allow == null
            ? 'No ticket found in the commit subjects. The workspace has no project keys, so the branch name is not read: pass the ticket (for example PAY-142) to check the story.'
            : 'No ticket found in the branch name or the commit subjects. Pass the ticket (for example PAY-142) to check the story.',
      };
    }
  }
  const got = await seams.ticket(ctx, accountId, workspaceId, key).catch((err: unknown) => ({ note: `Ensemble could not read ${key}: ${errMsg(err)}` }));
  return 'note' in got ? { ...got, key } : got;
}

/**
 * THE DETECTION (tracker/detect.ts `extractTicketKeys`): with the workspace's project keys, the branch name and
 * each commit subject; without them, only keys written in upper case in a commit subject (a subject is read as a
 * PR title is) — never the branch (the precision rule). The first key found. Pure.
 */
export function detectTicketKey(branch: string, subjects: readonly string[], allow: readonly string[] | null): string | null {
  for (const s of subjects.length > 0 ? subjects : [null]) {
    const keys = extractTicketKeys(s, allow != null ? branch : null, allow);
    if (keys.length > 0) return keys[0]!;
  }
  return null;
}

/** The ticket as the story view shows it (read FRESH on the reader's ask), or a plain note. */
async function readLocalTicket(ctx: AgentContext, accountId: number, workspaceId: number, key: string): Promise<ResolvedTicket | { note: string }> {
  const [{ workspaceSite }, { trackerTicketIdent }] = await Promise.all([import('../db/stories.js'), import('@pierre-review/shared')]);
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return { note: `The workspace has no issue tracker, so ${key} cannot be read. Set one up under Settings → Integrations.` };
  const ident = trackerTicketIdent(site.provider, site.apiRoot, key);
  const { readSessionTicket } = await import('../sandbox/workspace/ticket.js');
  const t = await readSessionTicket(ctx, accountId, workspaceId, ident);
  if (t == null) return { note: `Ensemble could not read ${key} from the tracker.` };
  const criteria = t.criteria.map((c) => `${c.n}. ${c.text}`).join('\n');
  return {
    ident,
    key: t.key,
    title: t.title,
    url: t.url,
    ticket: { title: t.title, description: t.description, acceptanceCriteria: criteria !== '' ? criteria : t.acceptanceCriteriaText || null, key: t.key, url: t.url },
  };
}

// ---- the pair's wire ---------------------------------------------------------------------------------------------

/** One half as the pair consolidation reads it (the PR pair's `ClaudeReview` shape). */
function halfWire(id: number, half: number, h: LocalReviewHalf, res: BranchReviewHalfResult, headSha: string, findings: readonly LocalReviewFindingRow[]): ClaudeReview {
  const runId = id * 2 + half;
  return {
    id: runId,
    prId: 0,
    headSha,
    status: 'succeeded',
    model: h.model ?? '',
    provider: h.provider,
    effort: h.effort,
    scope: null,
    reviewMode: res.reviewMode === 'worktree' || res.reviewMode === 'diff_only' ? res.reviewMode : null,
    routeReason: null,
    summary: res.summary,
    verdict: res.verdict,
    userBody: null,
    userVerdict: null,
    costUsd: res.costUsd,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: res.numTurns,
    diffBytes: null,
    diffCapped: null,
    error: null,
    excludedFiles: [],
    postedReviewId: null,
    postedAt: null,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    findings: findings
      .filter((f) => f.localReviewId === id && f.half === half)
      .map((f) => ({
        id: f.id,
        reviewId: runId,
        path: f.path,
        line: f.line,
        side: f.side,
        diffAnchorId: createHash('sha256').update(f.path, 'utf8').digest('hex'),
        severity: f.severity,
        title: f.title,
        body: f.body,
        editedBody: null,
        suggestion: f.suggestion,
        diffHunk: f.diffHunk,
        anchored: f.anchored,
        fileInDiff: f.fileInDiff,
        included: true,
        postedAt: null,
        githubCommentId: null,
        postedCommentKind: null,
        createdAt: new Date(0).toISOString(),
        priorFindingId: f.priorFindingId,
        lens: (f.lens as never) ?? null,
      })),
    trigger: 'manual',
    ...(h.pairRole ? { pair: { pairId: id * 2, role: h.pairRole, otherReviewId: null } } : {}),
  };
}

// ---- the wire ---------------------------------------------------------------------------------------------------

/** One run on the wire (findings, follow-up, criteria). `branchRuns` are the branch's runs (for carried verdicts). */
export async function localReviewWire(ctx: AgentContext, accountId: number, row: LocalReviewRow, repoFullName: string): Promise<LocalReview> {
  const branchRuns = (await listLocalReviews(ctx, accountId, row.repoId, row.branch, 20)).filter((r) => r.id <= row.id);
  if (!branchRuns.some((r) => r.id === row.id)) branchRuns.push(row);
  const findings = await listLocalFindings(ctx, accountId, [row.id]);
  const sourceOf = ((row.pairConsolidation as { sourceOf?: Record<string, string> } | null)?.sourceOf ?? {}) as Record<string, string>;
  const halves = row.reviewers ?? [];
  const lead = halves.find((h) => h.pairRole !== 'second' && h.status === 'succeeded') ?? halves.find((h) => h.status === 'succeeded') ?? null;
  const { roundOf } = loopRunsOf(branchRuns);
  const checks = loopChecksOf(branchRuns, roundOf);
  const check = checks.find((c) => c.round === roundOf.get(row.id)) ?? null;
  const open = new Set(openCriteriaOf(check, checks).map((c) => c.ref.toUpperCase()));
  const na = acceptedNa(check, checks);
  const cannot = new Map((row.answers ?? []).filter((x) => x.action === 'cannot_meet').map((x) => [x.ref.toUpperCase(), x.reply]));
  const a = row.storyStatus === 'succeeded' ? row.assessment : null;
  const criteria: LocalReviewCriterion[] = a
    ? [
        ...a.criteria.map((c) => ({ ref: c.ref, text: c.text, status: c.status, explanation: c.explanation, open: open.has(c.ref.toUpperCase()), cannotMeet: cannot.get(c.ref.toUpperCase()) ?? null, notApplicable: na.has(c.ref.toUpperCase()) })),
        ...a.missing.map((m) => ({ ref: m.ref, text: m.title, status: 'missing' as const, explanation: m.explanation, open: open.has(m.ref.toUpperCase()), cannotMeet: cannot.get(m.ref.toUpperCase()) ?? null, notApplicable: na.has(m.ref.toUpperCase()) })),
      ]
    : [];
  const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    repo: repoFullName,
    branch: row.branch,
    baseSha: row.baseSha,
    headSha: row.headSha,
    includeUncommitted: row.includeUncommitted,
    uncommittedChanges: row.uncommittedChanges,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    failureReason: row.failureReason,
    review:
      row.kind === 'review'
        ? {
            reviewers: halves.map((h) => ({ provider: h.provider, model: h.model, effort: h.effort, status: h.status, failureReason: h.failureReason })),
            summary: row.summary,
            verdict: (row.verdict as ClaudeReviewVerdict | null) ?? null,
            findings: findings
              .filter((f) => f.mergedInto == null && f.severity !== 'praise')
              .map((f) => ({
                id: f.id,
                file: f.path,
                line: f.line,
                severity: f.severity,
                title: f.title,
                body: f.body,
                suggestion: f.suggestion,
                raisedBy: sourceOf[String(f.id)] === 'both' ? ['claude', 'codex'] : [f.provider === 'codex' ? 'codex' : 'claude'],
                earlierFindingId: f.priorFindingId,
              })),
            followUp: (lead?.followUp?.items ?? []).map((it) => ({ findingId: it.priorFindingId, status: it.status, explanation: it.explanation })),
          }
        : null,
    ticket: row.ticketKey && row.ticketIdent ? { key: row.ticketKey, title: row.ticketTitle ?? row.ticketKey, url: row.ticketUrl } : null,
    ticketNote: row.ticketNote,
    storyCheck:
      row.storyStatus != null
        ? { status: row.storyStatus, failureReason: row.storyFailure, summary: a?.summary ?? null, criteria, open: criteria.filter((c) => c.open).length }
        : null,
    answers: row.answers ?? [],
  };
}

/** A run in a list. */
export async function localReviewListItems(ctx: AgentContext, accountId: number, rows: readonly LocalReviewRow[]): Promise<LocalReviewListItem[]> {
  const findings = await listLocalFindings(ctx, accountId, rows.map((r) => r.id));
  return rows.map((r) => {
    const { roundOf } = loopRunsOf([r]);
    const checks = loopChecksOf([r], roundOf);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      branch: r.branch,
      headSha: r.headSha,
      createdAt: r.createdAt.toISOString(),
      findings: findings.filter((f) => f.localReviewId === r.id && f.mergedInto == null && f.severity !== 'praise').length,
      openCriteria: r.storyStatus === 'succeeded' ? openCriteriaOf(checks[0] ?? null, checks).length : null,
    };
  });
}
