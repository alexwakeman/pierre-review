import {
  STORY_LABEL_CONCURRENCY,
  STORY_LABEL_RUN_CAP,
  STORY_LABEL_MODEL,
  STORY_RUBRIC_VERSION,
  type StoryLabelRunStatus,
  type StoryLabelRunStop,
} from '@pierre-review/shared';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import type { StoryLabelInput } from '../../db/story-label-input.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { labelMaxTokens, STORY_LABEL_SYSTEM, storyLabelPrompt, storyLabelUntrusted } from './prompt.js';
import { validateStoryLabels } from './validate.js';

// THE STORY LABEL RUN (docs/CLAUDE-REVIEW.md § Story labels). Local-only and agentic: the routes
// register through `registerAgenticRoutes`, so nothing here exists in cloud.
//
//   • ONE RUN PER ACCOUNT, claimed SYNCHRONOUSLY (`claimStoryLabelRun`, before the route's first
//     await) and released on EVERY path — a refusal, a thrown lookup, the run's end.
//   • STATE LIVES IN MEMORY. The labels it writes (`story_labels`) are the durable part; a restart
//     loses the progress bar, never a label, and the next press simply carries on (a story with a
//     current label is never sent again).
//   • ONE `cheapComplete` PER STORY (Haiku 5.5, the core cheap seam — tool-less, connectors isolated),
//     STORY_LABEL_CONCURRENCY at a time. Each call's cost is recorded (`recordAiUsage`, feature
//     'story_labels') and counted against the run's `budgetUsd`: once the recorded spend reaches it,
//     no further call STARTS (calls already in flight finish — at most CONCURRENCY − 1 small calls
//     past the line). The ambient-session path reports tokens only, so cost is priced from tokens at
//     Haiku's rates.
//   • A FAILED LABEL (a thrown call, bad JSON, a wrong criterion count) is not stored and is retried
//     on the next press. A missing credential or AI runtime stops the run at once.

// Haiku 5.5's rates (US$ per token) — the plugin's `haikuCostUsd` figures, the one cheap model here.
const INPUT_USD_PER_TOKEN = 0.1 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 0.5 / 1_000_000;

export function labelCostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN;
}

export interface StoryToLabel {
  ident: string;
  input: StoryLabelInput;
}

export interface CompleteFn {
  (opts: { model: string; system: string; prompt: string; maxTokens: number }): Promise<{
    text: string;
    usage?: { inputTokens: number; outputTokens: number };
  }>;
}

interface Slot {
  status: StoryLabelRunStatus | null;
  abort: AbortController;
}

const slots = new Map<number, Slot>(); // accountId → the one in-flight run (status null while starting)
const lastRun = new Map<number, StoryLabelRunStatus>(); // accountId → most recent finished run
const pending = new Map<number, Promise<void>>(); // accountId → the in-flight run's background promise
let seq = 0;

/** Claim the account's slot. SYNCHRONOUS — call before any await. false = already taken. */
export function claimStoryLabelRun(accountId: number): boolean {
  if (slots.has(accountId)) return false;
  slots.set(accountId, { status: null, abort: new AbortController() });
  return true;
}

/** Release a claim that never started a run (a refusal or a thrown lookup). */
export function releaseStoryLabelRun(accountId: number): void {
  const s = slots.get(accountId);
  if (s != null && s.status == null) slots.delete(accountId);
}

const snapshot = (s: StoryLabelRunStatus): StoryLabelRunStatus => ({ ...s });

/** The account's run in flight, else its most recent finished run this process, else null. */
export function storyLabelRunOf(accountId: number): StoryLabelRunStatus | null {
  const s = slots.get(accountId)?.status;
  if (s != null) return snapshot(s);
  const last = lastRun.get(accountId);
  return last != null ? snapshot(last) : null;
}

/** The id holding the slot, for a 409 body. */
export function storyLabelRunningId(accountId: number): string | null {
  return slots.get(accountId)?.status?.id ?? null;
}

/** Cancel the account's run (no-op when none). Returns the run as it stands. */
export function cancelStoryLabelRun(accountId: number): StoryLabelRunStatus | null {
  const slot = slots.get(accountId);
  if (slot?.status != null && slot.status.state === 'running') slot.abort.abort();
  return storyLabelRunOf(accountId);
}

export interface StartStoryLabelRunArgs {
  accountId: number;
  workspaceId: number;
  stories: readonly StoryToLabel[];
  budgetUsd: number;
}

/**
 * Start the run for a CLAIMED slot and return its first status. The run continues in the background
 * and releases the slot when it ends. `complete` / `store` are seams for the test.
 */
export function startStoryLabelRun(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage' | 'db' | 'schema'>,
  a: StartStoryLabelRunArgs,
  seams: StoryLabelSeams = {},
): StoryLabelRunStatus {
  const slot = slots.get(a.accountId);
  if (slot == null || slot.status != null) throw new Error('story labels: start without a claimed slot');
  seq += 1;
  const status: StoryLabelRunStatus = {
    id: `sl-${Date.now().toString(36)}-${seq}`,
    workspaceId: a.workspaceId,
    state: 'running',
    total: a.stories.length,
    done: 0,
    labelled: 0,
    failed: 0,
    costUsd: 0,
    budgetUsd: a.budgetUsd,
    stoppedBy: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  slot.status = status;
  const store = seams.store ?? ((s, v) => storeLabel(ctx, a.accountId, s, v));
  const p = runLabels(ctx, a, slot, seams.complete, store).finally(() => {
    status.finishedAt = new Date().toISOString();
    lastRun.set(a.accountId, status);
    if (slots.get(a.accountId) === slot) slots.delete(a.accountId);
    if (pending.get(a.accountId) === p) pending.delete(a.accountId);
  });
  pending.set(a.accountId, p);
  return snapshot(status);
}

export interface StoryLabelSeams {
  complete?: CompleteFn;
  store?: (s: StoryToLabel, v: StoredLabel) => Promise<void>;
}

/**
 * Label stories AND WAIT for the run to end — the story report's automatic label pass (it reads the
 * labels it waited for). `stories` is evaluated AFTER the slot is claimed, so stories a run that was
 * already in flight just labelled are not sent twice. A busy slot is waited for ONCE (that run is
 * bounded by its own budget); still busy → null, nothing labelled. Nothing to label → null. `signal`
 * aborting cancels THIS run (never another caller's). Returns the finished run's status.
 */
export async function runStoryLabelsToEnd(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage' | 'db' | 'schema'>,
  a: Omit<StartStoryLabelRunArgs, 'stories'> & { stories: () => Promise<readonly StoryToLabel[]> },
  seams: StoryLabelSeams = {},
  signal?: AbortSignal,
): Promise<StoryLabelRunStatus | null> {
  if (!claimStoryLabelRun(a.accountId)) {
    await pending.get(a.accountId)?.catch(() => {});
    if (!claimStoryLabelRun(a.accountId)) return null;
  }
  let started: StoryLabelRunStatus | null = null;
  try {
    if (signal?.aborted) return null;
    const stories = await a.stories();
    if (stories.length === 0) return null;
    started = startStoryLabelRun(ctx, { ...a, stories: stories.slice(0, STORY_LABEL_RUN_CAP) }, seams);
  } finally {
    if (started == null) releaseStoryLabelRun(a.accountId);
  }
  const id = started.id;
  const onAbort = (): void => {
    const s = slots.get(a.accountId);
    if (s?.status?.id === id) s.abort.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await pending.get(a.accountId)?.catch(() => {});
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const last = lastRun.get(a.accountId);
  return last != null && last.id === id ? snapshot(last) : null;
}

export interface StoredLabel {
  criteria: import('@pierre-review/shared').StoryCriterionLabel[];
  story: import('@pierre-review/shared').StoryLevelLabels;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

async function storeLabel(
  ctx: Pick<AgentContext, 'db' | 'schema'>,
  accountId: number,
  s: StoryToLabel,
  v: StoredLabel,
): Promise<void> {
  const t = ctx.schema.storyLabels;
  await ctx.db
    .insert(t)
    .values({
      accountId,
      ident: s.ident,
      textHash: s.input.textHash,
      rubricVersion: STORY_RUBRIC_VERSION,
      criteriaJson: v.criteria,
      storyJson: v.story,
      criteriaCount: v.criteria.length,
      model: STORY_LABEL_MODEL,
      costUsd: v.costUsd,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      createdAt: new Date(),
    })
    // The same text under the same rubric was labelled meanwhile: the first answer stands.
    .onConflictDoNothing({ target: [t.accountId, t.ident, t.rubricVersion, t.textHash] })
    .execute();
}

async function runLabels(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  a: StartStoryLabelRunArgs,
  slot: Slot,
  completeSeam: CompleteFn | undefined,
  store: (s: StoryToLabel, v: StoredLabel) => Promise<void>,
): Promise<void> {
  const status = slot.status!;
  const stop = (why: StoryLabelRunStop): void => {
    if (status.stoppedBy == null) status.stoppedBy = why;
  };
  try {
    if (ctx.llm.detectAuth().status !== 'ok') {
      stop('auth');
      status.state = 'failed';
      return;
    }
    const complete: CompleteFn = completeSeam ?? (await import('../llm.js')).cheapComplete;
    let next = 0;
    // ONE retry on a refused answer (over a length cap, broken JSON): the agreement test saw ~15% of
    // first answers refused and almost all second answers accepted. Both calls are billed and recorded.
    const one = async (s: StoryToLabel): Promise<void> => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const nonce = pickReviewNonce(storyLabelUntrusted(s.input));
          const res = await complete({
            model: STORY_LABEL_MODEL,
            system: STORY_LABEL_SYSTEM,
            prompt: storyLabelPrompt(s.input, nonce),
            maxTokens: labelMaxTokens(s.input.criteria.length),
          });
          const inputTokens = res.usage?.inputTokens ?? 0;
          const outputTokens = res.usage?.outputTokens ?? 0;
          const costUsd = labelCostUsd(inputTokens, outputTokens);
          status.costUsd += costUsd;
          await ctx
            .recordAiUsage({
              accountId: a.accountId,
              seam: 'summary',
              feature: 'story_labels',
              model: STORY_LABEL_MODEL,
              costUsd,
              inputTokens,
              outputTokens,
            })
            .catch((err) => ctx.log.warn({ err }, 'story labels: usage record failed'));
          const v = validateStoryLabels(res.text, s.input.criteria.length, {
            title: s.input.title,
            description: s.input.description,
            criteria: s.input.criteria,
          });
          if (v.ok) {
            if (v.quotes.given > v.quotes.verified) {
              ctx.log.info({ accountId: a.accountId, quotes: v.quotes }, 'story labels: quotes that did not verify were dropped');
            }
            await store(s, { criteria: v.criteria, story: v.story, costUsd, inputTokens, outputTokens });
            status.labelled += 1;
            return;
          }
          ctx.log.info({ accountId: a.accountId, reason: v.reason, attempt }, 'story labels: answer refused by validation');
          if (status.costUsd >= a.budgetUsd) break;
        }
        status.failed += 1;
      } catch (err) {
        status.failed += 1;
        if (err instanceof AiRuntimeMissingError) stop('runtime');
        else ctx.log.warn({ accountId: a.accountId, err: String(err).slice(0, 200) }, 'story labels: label call failed');
      } finally {
        status.done += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STORY_LABEL_CONCURRENCY, a.stories.length) }, async () => {
        while (next < a.stories.length) {
          if (slot.abort.signal.aborted) return stop('cancelled');
          if (status.stoppedBy != null) return;
          if (status.costUsd >= a.budgetUsd) return stop('budget');
          const s = a.stories[next++]!;
          await one(s);
        }
      }),
    );
    status.state =
      status.stoppedBy === 'cancelled'
        ? 'cancelled'
        : status.stoppedBy === 'runtime' || (status.labelled === 0 && status.failed > 0)
          ? 'failed'
          : 'succeeded';
    if (status.state === 'failed' && status.stoppedBy == null) stop('failed');
  } catch (err) {
    ctx.log.warn({ accountId: a.accountId, err: String(err).slice(0, 200) }, 'story labels: run threw');
    status.state = 'failed';
    stop('failed');
  }
}

/** Test seam: forget every run. */
export function resetStoryLabelRuns(): void {
  slots.clear();
  lastRun.clear();
  pending.clear();
}
