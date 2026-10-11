import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  SPRINT_ASSESS_MODEL,
  foldStoryIssues,
  isBlockingRelation,
  sprintAssessModeOf,
  storyBlockerPhrase,
  storyReferencesByKey,
  usableStoryLabel,
  type KnownTicket,
  type StoryTicketReference,
  type TicketLinkBlocker,
  type SprintAssessmentCurrency,
  type SprintAssessmentErrorCode,
  type SprintAssessmentPhase,
  type SprintAssessmentRecord,
  type SprintAssessMode,
  type SprintRepoRef,
} from '@pierre-review/shared';
import { db, schema } from '../../db/client.js';
import {
  readSprintTicket,
  sprintAssessFingerprint,
  sprintAssessmentRecordOf,
  sprintTicketTextHash,
  type SprintAssessmentRow,
  type SprintTicketDbRow,
} from '../../db/sprint-store.js';
import { sprintAssessmentCurrencyFrom, sprintTicketStage } from '../../db/sprint-stories.js';
import { acceptedSprintRepoDetails } from '../../db/sprint-ticket-repos.js';
import type { AgentContext } from '../agent-context.js';
import { cleanupCloneCache, prepDefaultBranchCheckouts } from '../clone-manager.js';
import {
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../claude-review/manager.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import type { SprintAssessRunResult, SprintAssessRunner } from './agent.js';
import { buildSprintAssessPrompt, sprintAssessSystemPrompt, sprintAssessUntrustedTexts, type PromptReference } from './prompts.js';
import { validateSprintAssessment } from './validate.js';
import { storyLabelInput } from '../../db/story-label-input.js';
import { buildStoryIssueInput, knownTicketsFor, linksOfRow, namedTicketKeys } from '../../db/story-issue-input.js';

/** What code already knows about the ticket — open blockers (links + named), the current label's
 *  spec gaps, and every ticket it REFERENCES with the relation the label read and the status Limn
 *  holds (sprint tickets, PR tickets, the sprint read's lookup) — handed to the agent as fenced DATA.
 *  Never fails the run. */
export async function knownIssuesForPrompt(
  accountId: number,
  ticket: SprintTicketDbRow,
  criteria: readonly string[],
): Promise<{ blockers: string[]; gaps: string[]; references: PromptReference[] }> {
  const provider = ticket.provider as 'jira' | 'github' | 'linear';
  const input = storyLabelInput(
    { title: ticket.title, description: ticket.description ?? '', acceptanceCriteria: ticket.acceptanceCriteria ?? '' },
    provider,
  );
  const { currentLabelRowsFor } = await import('../../db/story-health.js');
  const label = input != null ? ((await currentLabelRowsFor(accountId, [ticket.ident])).get(ticket.ident)?.get(input.textHash) ?? null) : null;
  const knownTickets = await knownTicketsFor(accountId, provider, ticket.apiRoot, namedTicketKeys([label]));
  const issues = foldStoryIssues(buildStoryIssueInput({ criteria, label, links: linksOfRow(ticket), knownTickets }));
  const blocked = issues.find((i) => i.id === 'blocked');
  const gaps = issues.find((i) => i.id === 'spec_gaps');
  const usable = usableStoryLabel({ criteria, label });
  return {
    blockers: (blocked?.blockers ?? []).filter((b) => !b.resolved).map(storyBlockerPhrase),
    gaps: (gaps?.gaps ?? []).map((g) => g.text),
    references: promptReferencesOf(linksOfRow(ticket), usable?.story.references ?? null, knownTickets, ticket.issueKey),
  };
}

/** The "Referenced tickets" the prompt lists (pure): the tracker links (blocked_by / linked, with the
 *  status the tracker sent), then the label's references (one per key, `storyReferencesByKey`), each
 *  with the stored status. The ticket itself is left out; ≤ PROMPT_REFERENCES_MAX. */
export const PROMPT_REFERENCES_MAX = 30;
export function promptReferencesOf(
  links: readonly TicketLinkBlocker[] | null,
  references: readonly StoryTicketReference[] | null,
  known: ReadonlyMap<string, KnownTicket>,
  selfKey: string,
): PromptReference[] {
  const out = new Map<string, PromptReference>();
  const self = selfKey.trim().toUpperCase();
  for (const l of links ?? []) {
    const k = l.key.trim().toUpperCase();
    if (k === self || out.has(k)) continue;
    out.set(k, {
      key: l.key,
      title: l.title,
      status: l.status,
      done: l.category == null ? null : l.category === 'done',
      relation: isBlockingRelation(l.relation) ? 'blocked_by' : 'linked',
      quote: null,
    });
  }
  for (const [k, r] of storyReferencesByKey(references)) {
    if (k === self || out.has(k)) continue;
    const t = known.get(k) ?? null;
    out.set(k, {
      key: r.ticketKey,
      title: t?.title ?? null,
      status: t?.status ?? null,
      done: t?.category == null ? null : t.category === 'done',
      relation: r.relation,
      quote: r.quote,
    });
  }
  return [...out.values()].slice(0, PROMPT_REFERENCES_MAX);
}

// THE SPRINT ASSESSMENT'S RUNS ("Check against code", Reports → This sprint; docs/CLAUDE-REVIEW.md §
// Sprint assessment). LOCAL ONLY — reached only through routes registered by `registerAgenticRoutes`.
//
//   • ONE RUN PER (account, ticket), claimed SYNCHRONOUSLY before the route's first await
//     (`claimSprintAssessSlot`), released on every path: a refusal, a thrown lookup, the run's end,
//     a cancel while still queued.
//   • ⚠ IT SHARES THE ONE REVIEW_CONCURRENCY (`registerReviewSlotPeer`) — it is a Sonnet agent run
//     over clone-cache checkouts like the PR and ticket reviews. It starts only while a shared slot is
//     free and no PR-review CLICK is waiting; when it ends it pumps the other lanes.
//   • THE PIPELINE: running/checking_out → one read-only DEFAULT-BRANCH checkout per accepted repo
//     (clone-manager `prepDefaultBranchCheckouts`; none at all → failed `no_checkout`) → reading →
//     the agent (agent.ts; Read/Glob/Grep behind the path guard; first `submit_assessment` wins and
//     flips the phase to writing) → the server validator (validate.ts: every cited path checked
//     against the checkout, unverified ones DROPPED) → succeeded. The `finally` removes every
//     checkout and the scratch directory, then runs a deferred clone-cache eviction.
//   • THE MODE (plan / verify) is the CALLER's, from the ticket's stage at start (`sprintAssessModeOf`);
//     stored on the row (`mode`) and folded into the fingerprint, and it picks the system prompt, the
//     tool's shape and what the validator keeps.
//   • CURRENCY: `fingerprint` is taken at START from SYNCED columns (mode + ticket text hash + the
//     accepted repos' `default_branch_head_sha`), so it is re-checkable from the DB alone (the stage
//     re-derived through the workspace's status layout); `repos_json` keeps the commit each checkout
//     actually read.
//   • The terminal write is a compare-and-set on queued/running, so a cancel that lands as the run
//     finishes wins. Spend is recorded for every finished run that cost money (`recordAiUsage`,
//     seam 'agent', feature 'sprint_assess').

type Ctx = Pick<AgentContext, 'log' | 'recordAiUsage' | 'llm'>;
type Row = SprintAssessmentRow;

export interface SprintAssessRepo extends SprintRepoRef {
  owner: string;
  name: string;
  defaultBranch: string | null;
  syncedSha: string | null;
}

export interface StartSprintAssessmentArgs {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticket: SprintTicketDbRow;
  criteria: string[];
  repos: SprintAssessRepo[];
  /** From the ticket's stage at start (`sprintAssessModeOf`). */
  mode: SprintAssessMode;
}

interface Job extends StartSprintAssessmentArgs {
  ctx: Ctx;
  id: number;
  abort: AbortController;
}

type CheckoutFn = typeof prepDefaultBranchCheckouts;

const claimed = new Map<string, number>(); // `${accountId}:${ident}` → run id (-1 until its row exists)
const lane: Job[] = [];
const running = new Map<number, Job>();
const runs = new Map<number, Promise<void>>();
const keyOf = (accountId: number, ident: string): string => `${accountId}:${ident}`;

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

let runnerOverride: SprintAssessRunner | null = null;
let checkoutOverride: CheckoutFn | null = null;

/** Tests inject a fake runner (never a real model call); null restores the SDK runner. */
export function setSprintAssessRunnerForTests(fn: SprintAssessRunner | null): void {
  runnerOverride = fn;
}
/** Tests inject a fake checkout (never a real clone); null restores the clone manager. */
export function setSprintAssessCheckoutForTests(fn: CheckoutFn | null): void {
  checkoutOverride = fn;
}
/** The background run of `id`, for tests to await; undefined when none. */
export function sprintAssessRunPromise(id: number): Promise<void> | undefined {
  return runs.get(id);
}

/** Claim the (account, ticket) slot. SYNCHRONOUS — call before any await. false = already taken. */
export function claimSprintAssessSlot(accountId: number, ident: string): boolean {
  const k = keyOf(accountId, ident);
  if (claimed.has(k)) return false;
  claimed.set(k, -1);
  return true;
}

export function releaseSprintAssessSlot(accountId: number, ident: string): void {
  claimed.delete(keyOf(accountId, ident));
}

const t = () => schema.sprintAssessments;

/** One run by id — this account's only (another account's id → null → 404). */
export async function loadSprintAssessment(accountId: number, id: number): Promise<Row | null> {
  const rows = await db
    .select()
    .from(t())
    .where(and(eq(t().accountId, accountId), eq(t().id, id)))
    .limit(1)
    .execute();
  return (rows[0] as Row | undefined) ?? null;
}

/** The ticket's in-flight run id (queued/running), or null. */
export async function runningSprintAssessmentId(accountId: number, ident: string): Promise<number | null> {
  const [r] = await db
    .select({ id: t().id })
    .from(t())
    .where(and(eq(t().accountId, accountId), eq(t().ident, ident), inArray(t().status, ['queued', 'running'])))
    .orderBy(desc(t().createdAt), desc(t().id))
    .limit(1)
    .execute();
  return r?.id ?? null;
}

/** DB-only currency of a run against TODAY's ticket text and accepted repos. null unless succeeded. */
export async function sprintAssessmentCurrency(accountId: number, row: Row): Promise<SprintAssessmentCurrency> {
  if (row.status !== 'succeeded') return null;
  const ticket = await readSprintTicket(accountId, row.workspaceId, row.ident);
  const accepted = (await acceptedSprintRepoDetails(accountId, row.workspaceId, [row.ident])).get(row.ident) ?? [];
  const mode = ticket != null ? sprintAssessModeOf(await sprintTicketStage(accountId, row.workspaceId, ticket)) : 'plan';
  return sprintAssessmentCurrencyFrom(row, ticket, accepted, mode);
}

/**
 * Insert the queued row and put the run on the shared lane. The caller MUST hold the ticket's slot
 * (`claimSprintAssessSlot`); from here the run owns it. If the insert throws, the caller still owns
 * the slot and releases it.
 */
export async function startSprintAssessment(ctx: Ctx, a: StartSprintAssessmentArgs): Promise<SprintAssessmentRecord> {
  const k = keyOf(a.accountId, a.ident);
  if (!claimed.has(k)) throw new Error('sprint assessment: start without a claimed slot');
  const textHash = sprintTicketTextHash(a.ticket);
  const [row] = (await db
    .insert(t())
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.ident,
      model: SPRINT_ASSESS_MODEL,
      status: 'queued',
      mode: a.mode,
      phase: null,
      fingerprint: sprintAssessFingerprint(
        textHash,
        a.repos.map((r) => ({ repoId: r.repoId, sha: r.syncedSha })),
        a.mode,
      ),
      textHash,
      reposJson: a.repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName, sha: r.syncedSha })),
      createdAt: new Date(),
    })
    .returning()
    .execute()) as Row[];
  claimed.set(k, row!.id);
  lane.push({ ...a, ctx, id: row!.id, abort: new AbortController() });
  pump();
  return sprintAssessmentRecordOf(row!);
}

// Fill free shared slots; an assessment (always a click) yields only to a waiting PR-review click.
function pump(): void {
  for (;;) {
    if (lane.length === 0 || !reviewSlotFree()) return;
    if (reviewLaneWaiting().manual) return;
    launch(lane.shift()!);
  }
}

function launch(job: Job): void {
  running.set(job.id, job);
  const p = runAssessment(job).finally(() => {
    running.delete(job.id);
    runs.delete(job.id);
    if (claimed.get(keyOf(job.accountId, job.ident)) === job.id) claimed.delete(keyOf(job.accountId, job.ident));
    pump();
    pumpReviewLane();
  });
  runs.set(job.id, p);
}

/** Map an agent result with no usable assessment to its error code. */
export function sprintAssessFailureOf(res: SprintAssessRunResult): SprintAssessmentErrorCode {
  if (res.runtimeMissing) return 'runtime';
  if (res.subtype === 'error_max_turns') return 'max_turns';
  if (res.subtype === 'error_max_budget_usd') return 'budget_exceeded';
  if (res.subtype == null && res.failureReason != null) return 'failed';
  return 'no_assessment';
}

async function finish(id: number, set: Partial<typeof schema.sprintAssessments.$inferInsert>, cas: boolean): Promise<void> {
  await db
    .update(t())
    .set({ ...set, phase: null, completedAt: new Date() })
    .where(cas ? and(eq(t().id, id), inArray(t().status, ['queued', 'running'])) : eq(t().id, id))
    .execute();
}

async function setPhase(id: number, phase: SprintAssessmentPhase): Promise<void> {
  await db
    .update(t())
    .set({ phase })
    .where(and(eq(t().id, id), eq(t().status, 'running')))
    .execute();
}

async function runAssessment(job: Job): Promise<void> {
  const { ctx, id } = job;
  let cleanup: (() => Promise<void>) | null = null;
  let scratch: string | null = null;
  try {
    const started = await db
      .update(t())
      .set({ status: 'running', phase: 'checking_out' })
      .where(and(eq(t().id, id), eq(t().status, 'queued')))
      .returning({ id: t().id })
      .execute();
    if (started.length === 0 || job.abort.signal.aborted) return; // cancelled before it started
    if (ctx.llm.detectAuth().status !== 'ok') {
      await finish(id, { status: 'failed', error: 'auth' }, true);
      return;
    }

    // ---- checkouts ----
    const prep = await (checkoutOverride ?? prepDefaultBranchCheckouts)(
      job.repos.map((r) => ({ owner: r.owner, name: r.name, branch: r.defaultBranch })),
    );
    cleanup = prep.cleanup;
    const byName = new Map(prep.checkouts.map((c) => [`${c.owner}/${c.name}`.toLowerCase(), c]));
    const read = job.repos.map((r) => {
      const c = byName.get(r.fullName.toLowerCase());
      return { repo: r, path: c?.path ?? null, sha: c?.path != null ? (c.sha ?? null) : null, error: c?.error ?? null };
    });
    await db
      .update(t())
      .set({ reposJson: read.map((x) => ({ repoId: x.repo.repoId, fullName: x.repo.fullName, sha: x.sha })) })
      .where(eq(t().id, id))
      .execute();
    for (const x of read) if (x.path == null) ctx.log.warn({ assessmentId: id, repo: x.repo.fullName, err: x.error }, 'sprint assess: checkout failed');
    const ok = read.filter((x): x is typeof x & { path: string } => x.path != null);
    if (ok.length === 0) {
      await finish(id, { status: 'failed', error: 'no_checkout' }, true);
      return;
    }
    // What code already knows (DB only), read BEFORE the last abort check so a cancel during it wins.
    const known = await knownIssuesForPrompt(job.accountId, job.ticket, job.criteria).catch((err) => {
      ctx.log.warn({ assessmentId: id, err: String(err).slice(0, 200) }, 'sprint assess: known issues read failed');
      return { blockers: [], gaps: [], references: [] as PromptReference[] };
    });
    if (job.abort.signal.aborted) return;

    // ---- the agent ----
    await setPhase(id, 'reading');
    scratch = mkdtempSync(join(tmpdir(), 'limn-sprint-assess-'));
    const promptTicket = {
      key: job.ticket.issueKey,
      title: job.ticket.title,
      description: job.ticket.description ?? '',
      criteria: job.criteria,
      blockers: known.blockers,
      gaps: known.gaps,
      references: known.references,
    };
    const nonce = pickReviewNonce(sprintAssessUntrustedTexts(promptTicket));
    const promptRepos = ok.map((x) => ({ fullName: x.repo.fullName, path: x.path, sha: x.sha }));
    const runner = runnerOverride ?? (await import('./agent.js')).runSprintAssessAgent;
    const res = await runner({
      prompt: buildSprintAssessPrompt(promptTicket, promptRepos, nonce, job.mode),
      systemPrompt: sprintAssessSystemPrompt(job.mode),
      mode: job.mode,
      cwd: scratch,
      worktrees: ok.map((x) => x.path),
      model: SPRINT_ASSESS_MODEL,
      abortController: job.abort,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      onSubmit: () => void setPhase(id, 'writing').catch(() => {}),
    });
    const usage = {
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
    };
    if (res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: job.accountId,
          seam: 'agent',
          feature: 'sprint_assess',
          model: SPRINT_ASSESS_MODEL,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
        })
        .catch((err) => ctx.log.warn({ err }, 'sprint assess: usage record failed'));
    }
    if (res.aborted || job.abort.signal.aborted) {
      await finish(id, { status: 'cancelled', ...usage }, false);
      return;
    }
    if (res.failureReason != null) ctx.log.warn({ assessmentId: id, err: res.failureReason }, 'sprint assess: run ended without an assessment');
    if (res.submitted == null) {
      await finish(id, { status: 'failed', error: sprintAssessFailureOf(res), ...usage }, true);
      return;
    }
    const v = validateSprintAssessment(res.submitted, {
      mode: job.mode,
      criteriaCount: job.criteria.length,
      repos: ok.map((x) => ({ fullName: x.repo.fullName, path: x.path })),
      references: known.references,
      ticket: {
        title: job.ticket.title,
        description: job.ticket.description ?? '',
        criteria: [...job.criteria, job.ticket.acceptanceCriteria ?? ''],
      },
    });
    if (!v.ok) {
      await finish(id, { status: 'failed', error: 'invalid_assessment', ...usage }, true);
      return;
    }
    if (v.dropped.paths + v.dropped.items + (v.dropped.quotes ?? 0) > 0) ctx.log.info({ assessmentId: id, dropped: v.dropped }, 'sprint assess: validation removed items');
    await finish(id, { status: 'succeeded', bodyJson: v.body, droppedJson: v.dropped, error: null, ...usage }, true);
  } catch (err) {
    ctx.log.warn({ err, assessmentId: id }, 'sprint assess: run threw');
    await finish(id, { status: 'failed', error: 'failed' }, true).catch(() => {});
  } finally {
    await cleanup?.().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    if (cleanup != null && checkoutOverride == null) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}

/**
 * Cancel this account's run `id`. Queued → off the lane, slot released; running → aborted; either
 * way 'cancelled' is written now (compare-and-set). Finished → unchanged. null when not this account's.
 */
export async function cancelSprintAssessment(accountId: number, id: number): Promise<Row | null> {
  const row = await loadSprintAssessment(accountId, id);
  if (row == null) return null;
  if (row.status !== 'queued' && row.status !== 'running') return row;
  const idx = lane.findIndex((j) => j.id === id && j.accountId === accountId);
  if (idx >= 0) {
    const [job] = lane.splice(idx, 1);
    job!.abort.abort();
    if (claimed.get(keyOf(accountId, job!.ident)) === id) claimed.delete(keyOf(accountId, job!.ident));
  }
  const live = running.get(id);
  if (live != null && live.accountId === accountId) live.abort.abort();
  await finish(id, { status: 'cancelled' }, true);
  return loadSprintAssessment(accountId, id);
}

/** Boot sweep: a queued/running row from an earlier process can never finish — mark it interrupted. */
export async function reconcileSprintAssessmentsOnStartup(): Promise<number> {
  const rows = await db
    .update(t())
    .set({ status: 'failed', error: 'interrupted', phase: null, completedAt: new Date() })
    .where(inArray(t().status, ['queued', 'running']))
    .returning({ id: t().id })
    .execute();
  return rows.length;
}
