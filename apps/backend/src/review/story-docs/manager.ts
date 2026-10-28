import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STORY_DOCS_ALIGNMENT_MODEL,
  STORY_DOCS_ALIGNMENT_VERSION,
  STORY_DOCS_REFUSAL_TEXT,
  STORY_DOCS_SHORTLIST_MODEL,
  type ClaudeReviewModel,
} from '@pierre-review/shared';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import { loadLibrarySnapshot } from '../../reference-docs/context.js';
import { readIndex } from '../../reference-docs/library.js';
import { libraryDir } from '../../reference-docs/paths.js';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { listDocRows } from '../../reference-docs/store.js';
import type { AgentContext } from '../agent-context.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../claude-review/manager.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import type { CompleteFn } from '../story-labels/manager.js';
import type { RunStoryDocsAgentArgs, RunStoryDocsAgentResult } from './agent.js';
import { libraryHashOf, storyDocsFingerprint } from './fingerprint.js';
import { defaultInputSeams, resolveStoryDocsInputs, type StoryDocsInputSeams, type StoryDocsInputs } from './inputs.js';
import {
  insertQueuedStoryDocs,
  markReading,
  markShortlisting,
  markStoryDocsFailed,
  reconcileOrphanedStoryDocs,
  saveStoryDocsSuccess,
} from './persist.js';
import { buildStoryDocsPrompt, storyDocsRoots, storyDocsSystemPrompt, storyDocsUntrustedTexts } from './prompts.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import { claudeModelChoice, getProvider } from '../../ai/provider.js';
import { promptTools, providerName } from '../../ai/prompt-tools.js';
import { runShortlist, type ShortlistDoc } from './shortlist.js';
import { validateAlignment } from './validate.js';

// THE STORY DOCS CHECK QUEUE — a separate agentic process (docs/REFERENCE-DOCS.md § Check a story
// against the docs). Every run is a CLICK (never automatic, never on view).
//
//   CLAIM   `${accountId}:${workspaceId}:${ident}` — at most one queued-or-running check per story,
//           claimed SYNCHRONOUSLY (-1) before the first await, then the row id.
//   LANE    one FIFO, at most LANE_MAX waiting (more ⇒ 409 Busy).
//   SLOTS   the ONE shared REVIEW_CONCURRENCY as a registered PEER: a check starts only when a slot is
//           free and no PR-review CLICK is waiting; when one ends it pumps its lane and the others.
//   PIPELINE  re-resolve the inputs (a click checks what is there NOW) → Haiku shortlist (an empty list
//           ends the run 'no_relevant_docs', no second call) → Sonnet read of ONLY the shortlisted
//           documents → validate (shape refused, grounding dropped) → store.
//   RESTART  `reconcileStoryDocsOnStartup` fails every run a restart cut off — never stuck.

const LANE_MAX = 10;
/** Wall-clock cap on one check: a wedged read must not hold the claim and a shared review slot until
 *  a restart. Nothing else aborts a run (there is no cancel), so an abort always means this. */
export const STORY_DOCS_TIMEOUT_MS = 10 * 60_000;
/** The line when a run times out, naming the provider that ran it (default: the active one). */
const timedOut = (name: string = providerName()): string => `${name} took too long. Run it again.`;

export interface StoryDocsJob {
  ctx: AgentContext;
  accountId: number;
  workspaceId: number;
  ident: string;
  runId: number;
}

export interface StoryDocsSeams {
  complete?: CompleteFn;
  runAgent?: (args: RunStoryDocsAgentArgs) => Promise<RunStoryDocsAgentResult>;
  inputs?: StoryDocsInputSeams;
}

let seams: StoryDocsSeams = {};
/** Test seam: replace the model calls and the input sources (null restores the real ones). */
export function _setStoryDocsSeamsForTest(s: StoryDocsSeams | null): void {
  seams = s ?? {};
}

const claimed = new Map<string, number>();
const lane: StoryDocsJob[] = [];
const running = new Map<number, StoryDocsJob>();

const keyOf = (accountId: number, workspaceId: number, ident: string): string => `${accountId}:${workspaceId}:${ident}`;

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

// ---- the live state (route + pipeline) ----

export interface LiveStoryDocs {
  inputs: StoryDocsInputs | null;
  docCount: number;
  libraryHash: string;
}

/** The story's inputs and the built library, read now (DB + disk only). */
export async function liveStoryDocs(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<LiveStoryDocs> {
  const [inputs, rows] = await Promise.all([
    resolveStoryDocsInputs(ctx, accountId, workspaceId, ident, seams.inputs ?? defaultInputSeams),
    listDocRows(accountId, workspaceId),
  ]);
  const built = rows.filter((r) => r.builtAt != null);
  return { inputs, docCount: built.length, libraryHash: libraryHashOf(built) };
}

export function fingerprintOf(workspaceId: number, inputs: StoryDocsInputs, libraryHash: string): string {
  return storyDocsFingerprint({
    workspaceId,
    ident: inputs.ident,
    storyHash: inputs.storyHash,
    criteriaHash: inputs.criteriaHash,
    libraryHash,
  });
}

// ---- start ----

export type StartStoryDocsResult =
  | { outcome: 'queued'; runId: number }
  | { outcome: 'already_running'; runId: number | null }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

export async function startStoryDocs(
  ctx: AgentContext,
  a: { accountId: number; workspaceId: number; inputs: StoryDocsInputs; libraryHash: string },
): Promise<StartStoryDocsResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.workspaceId, a.inputs.ident);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', runId: held > 0 ? held : null };
  if (lane.length >= LANE_MAX) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await
  let runId: number;
  try {
    runId = await insertQueuedStoryDocs(ctx, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.inputs.ident,
      ticketKey: a.inputs.ticketKey,
      fingerprint: fingerprintOf(a.workspaceId, a.inputs, a.libraryHash),
      storyHash: a.inputs.storyHash,
      criteriaHash: a.inputs.criteriaHash,
      libraryHash: a.libraryHash,
      version: STORY_DOCS_ALIGNMENT_VERSION,
      criteriaSource: a.inputs.criteriaSource,
      criteria: a.inputs.criteria,
    });
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
  claimed.set(key, runId);
  lane.push({ ctx, accountId: a.accountId, workspaceId: a.workspaceId, ident: a.inputs.ident, runId });
  pump();
  return { outcome: 'queued', runId };
}

/** The held claim for this story: undefined when none, null while the row is still being inserted,
 *  else the run id. */
export function storyDocsClaim(accountId: number, workspaceId: number, ident: string): number | null | undefined {
  const held = claimed.get(keyOf(accountId, workspaceId, ident));
  return held == null ? undefined : held > 0 ? held : null;
}

/** Is a check of this story queued or running in this process? */
export function storyDocsHeld(accountId: number, workspaceId: number, ident: string): boolean {
  return claimed.has(keyOf(accountId, workspaceId, ident));
}

function pump(): void {
  while (lane.length > 0 && reviewSlotFree() && !reviewLaneWaiting().manual) launch(lane.shift()!);
}

function launch(job: StoryDocsJob): void {
  const { ctx, runId, accountId } = job;
  running.set(runId, job);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORY_DOCS_TIMEOUT_MS);
  void runPipeline(job, controller)
    .catch(async (err) => {
      ctx.log.warn(`story docs check ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      const sentence = err instanceof AiRuntimeMissingError ? err.message : 'The check failed. Run it again.';
      await markStoryDocsFailed(ctx, accountId, runId, sentence).catch(() => {});
    })
    .finally(() => {
      clearTimeout(timer);
      running.delete(runId);
      claimed.delete(keyOf(job.accountId, job.workspaceId, job.ident));
      pump();
      pumpReviewLane();
    });
}

// ---- the pipeline ----

/** What the shortlist prompt shows of each built document (CONTENTS.md, and the stored section list). */
export function shortlistDocsOf(lib: LibrarySnapshot): ShortlistDoc[] {
  return lib.docs.map((d) => ({
    slug: d.slug,
    title: d.title,
    contents: lib.read(`${d.slug}/CONTENTS.md`),
    sections: (d.sections ?? []).map((s) => ({ path: s.path, title: s.title })),
  }));
}

async function runPipeline(job: StoryDocsJob, controller: AbortController): Promise<void> {
  const { ctx, accountId, workspaceId, ident, runId } = job;
  const live = await liveStoryDocs(ctx, accountId, workspaceId, ident);
  const inputs = live.inputs;
  if (inputs == null || inputs.empty) {
    await markStoryDocsFailed(ctx, accountId, runId, STORY_DOCS_REFUSAL_TEXT.no_story);
    return;
  }
  if (live.docCount === 0) {
    await markStoryDocsFailed(ctx, accountId, runId, STORY_DOCS_REFUSAL_TEXT.no_docs);
    return;
  }
  // A click means "check what is there now": the row takes the inputs as they are at start.
  await markShortlisting(ctx, accountId, runId, {
    fingerprint: fingerprintOf(workspaceId, inputs, live.libraryHash),
    storyHash: inputs.storyHash,
    criteriaHash: inputs.criteriaHash,
    libraryHash: live.libraryHash,
    criteriaSource: inputs.criteriaSource,
    criteria: inputs.criteria,
    model: STORY_DOCS_SHORTLIST_MODEL,
  });

  const index = await readIndex(accountId, workspaceId);
  const lib = await loadLibrarySnapshot(accountId, workspaceId);
  const sl = await runShortlist({
    input: { story: inputs.story, criteriaSource: inputs.criteriaSource, criteria: inputs.criteria, index, docs: shortlistDocsOf(lib) },
    lib,
    ...(seams.complete ? { complete: seams.complete } : {}),
    onUsage: (u) =>
      ctx
        .recordAiUsage({
          accountId,
          seam: 'summary',
          feature: 'story_docs_shortlist',
          ...u,
        })
        .catch((err) => ctx.log.warn({ err }, 'story docs: usage record failed')),
  });
  const slTel = { costUsd: sl.costUsd, inputTokens: sl.inputTokens, outputTokens: sl.outputTokens };
  if (controller.signal.aborted) {
    await markStoryDocsFailed(ctx, accountId, runId, timedOut(), slTel);
    return;
  }
  if (sl.entries == null) {
    await markStoryDocsFailed(ctx, accountId, runId, `${providerName()} could not pick the sections to read.`, slTel);
    return;
  }
  if (sl.entries.length === 0) {
    await saveStoryDocsSuccess(
      ctx,
      accountId,
      runId,
      { result: { outcome: 'no_relevant_docs', overall: null, criteria: [], storyParts: [], shortlist: [], dropped: 0 }, criteria: null },
      slTel,
    );
    return;
  }

  const model = STORY_DOCS_ALIGNMENT_MODEL as ClaudeReviewModel;
  // The provider, resolved ONCE: the prompts are worded for it and the same provider runs them
  // (review/run-provider.ts). A provider that records its own usage (Codex) bills `usageRecord`. The
  // row names what runs the read (provider + its model id) from here on.
  const providerId = activeProviderId();
  await markReading(
    ctx,
    accountId,
    runId,
    sl.entries,
    { provider: providerId, model: getProvider(providerId).resolveModel(claudeModelChoice(model)) },
    slTel,
  );
  const dir = libraryDir(accountId, workspaceId);
  const alignment = { criteriaSource: inputs.criteriaSource, criteria: inputs.criteria };
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'pierre-storydocs-'));
    const promptInput = {
      story: inputs.story,
      criteriaSource: inputs.criteriaSource,
      criteria: inputs.criteria,
      shortlist: sl.entries,
      libraryDir: dir,
      comments: inputs.comments,
    };
    const nonce = pickReviewNonce(storyDocsUntrustedTexts(promptInput));
    const words = promptTools(providerId);
    const run = seams.runAgent ?? (await import('./agent.js')).runStoryDocsAgent;
    const res = await run({
      cwd: scratch,
      roots: storyDocsRoots(dir, sl.entries),
      systemPrompt: storyDocsSystemPrompt(words),
      prompt: buildStoryDocsPrompt({ ...promptInput, nonce }, words),
      alignment,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: controller,
      model,
      provider: providerId,
      usageRecord: { accountId, seam: 'agent', feature: 'story_docs_alignment' },
    });
    // The provider wrote the ledger row itself (Codex) ⇒ never a second one here.
    if (res.ledgerByProvider !== true && res.costUsd != null && Number.isFinite(res.costUsd) && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'agent',
          feature: 'story_docs_alignment',
          model,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens ?? null,
          outputTokens: res.outputTokens ?? null,
        })
        .catch((err) => ctx.log.warn({ err }, 'story docs: usage record failed'));
    }
    const total = {
      costUsd: sl.costUsd + (res.costUsd ?? 0),
      inputTokens: sl.inputTokens + (res.inputTokens ?? 0),
      outputTokens: sl.outputTokens + (res.outputTokens ?? 0),
      numTurns: res.numTurns,
    };
    if (res.aborted) {
      await markStoryDocsFailed(ctx, accountId, runId, timedOut(), total);
      return;
    }
    if (res.payload == null) {
      if (res.failureReason) ctx.log.warn(`story docs check ${runId}: ${res.failureReason}`);
      await markStoryDocsFailed(ctx, accountId, runId, `${providerName(providerId)} did not finish the check. Run it again.`, total);
      return;
    }
    // ⚠ Validated AGAIN here, against the shortlisted documents only: the tool's acceptance is not the
    // storage gate, and grounding is judged only here.
    const v = validateAlignment(res.payload, lib, alignment, sl.entries);
    if (!v.ok) {
      ctx.log.warn(`story docs check ${runId}: ${v.problems.join(' ')}`);
      await markStoryDocsFailed(ctx, accountId, runId, `${providerName(providerId)}'s answer could not be used. Run it again.`, total);
      return;
    }
    await saveStoryDocsSuccess(
      ctx,
      accountId,
      runId,
      { result: v.value.result, criteria: inputs.criteriaSource === 'derived' ? v.value.criteria : null },
      total,
    );
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
  }
}

export async function reconcileStoryDocsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await reconcileOrphanedStoryDocs(ctx);
  if (n > 0) ctx.log.info(`reconciled ${n} orphaned story docs check(s) -> failed`);
}

/** Test seam: wait until nothing is queued or running. */
export async function _storyDocsIdleForTest(timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((lane.length > 0 || running.size > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}
