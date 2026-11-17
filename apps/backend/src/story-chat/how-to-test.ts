// HOW TO TEST AFTER A BUILD (docs/STORY-BUILD.md § How to test after a build). When an Implement story
// build turn stores work, Ensemble asks the story's chat the ready-made "How to test" question
// (`STORY_CHAT_PRESETS`), so the answer is waiting in the story view; the build tab points the reader at it
// until they open or dismiss it (`story_builds.how_to_test_seen_at`).
//
//   - ONCE PER VERSION OF THE WORK: `how_to_test_key` (the stored work's hash) is CLAIMED compare-and-set
//     before the question is asked; the same work never asks twice, new work asks again.
//   - AN AUTOMATIC RUN: it asks the ONE spend gate first and is SKIPPED (never queued) when over.
//   - READ-ONLY, like every story chat: it answers; it writes nothing to GitHub or the tracker.
//   - Never throws (the session manager fires it and forgets it).
import { createHash } from 'node:crypto';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { STORY_CHAT_PRESETS } from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import { db, schema } from '../db/client.js';
import type { BuildWork } from './live.js';

/** The ready-made "How to test" question, word for word. */
export function howToTestQuestion(): string {
  const p = STORY_CHAT_PRESETS.find((x) => x.label === 'How to test');
  if (!p) throw new Error('The "How to test" question is missing.');
  return p.question;
}

/** The stored work's identity: changes when any patch changes. Pure. */
export function workKey(work: readonly BuildWork[]): string | null {
  if (work.length === 0) return null;
  const h = createHash('sha256');
  for (const w of work) h.update(`${w.repo}\0${w.label}\0${w.patch}\0`);
  return h.digest('hex');
}

export interface HowToTestDeps {
  aiEnabled(): Promise<boolean>;
  work(accountId: number, buildId: number): Promise<BuildWork[]>;
  allowed(ctx: AgentContext, accountId: number): Promise<boolean>;
  ask(ctx: AgentContext, accountId: number, workspaceId: number, ident: string, question: string): Promise<{ chatId: number }>;
}

const realDeps: HowToTestDeps = {
  aiEnabled: async () => (await import('../config.js')).config.aiEnabled,
  work: async (accountId, buildId) => (await import('./build-work.js')).buildWorkOf(accountId, buildId),
  allowed: async (ctx, accountId) => (await import('../review/budget-gate.js')).automaticRunAllowed(ctx, accountId, 'story_chat'),
  ask: async (ctx, accountId, workspaceId, ident, question) => (await import('./live.js')).ask(ctx, accountId, workspaceId, ident, null, question),
};

let deps: HowToTestDeps = realDeps;
/** Tests only. */
export function setHowToTestDepsForTest(d: Partial<HowToTestDeps> | null): void {
  deps = d == null ? realDeps : { ...realDeps, ...d };
}

export type HowToTestOutcome = 'asked' | 'same_work' | 'no_work' | 'over_budget' | 'off' | 'not_found' | 'failed';

/** Ask "How to test" for this build's stored work, unless it was already asked for this work. */
export async function maybeAskHowToTest(ctx: AgentContext, a: { accountId: number; buildId: number }): Promise<HowToTestOutcome> {
  try {
    if (!(await deps.aiEnabled())) return 'off';
    const b = schema.storyBuilds;
    const [row] = await db
      .select({ workspaceId: b.workspaceId, ident: b.ident, status: b.status, key: b.howToTestKey })
      .from(b)
      .where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId)))
      .limit(1)
      .execute();
    if (!row || row.status === 'discarded') return 'not_found';
    const key = workKey(await deps.work(a.accountId, a.buildId));
    if (key == null) return 'no_work';
    if (row.key === key) return 'same_work';
    if (!(await deps.allowed(ctx, a.accountId))) return 'over_budget';
    // THE CLAIM: one question per version of the work, whoever gets here first.
    const claimed = await db
      .update(b)
      .set({ howToTestKey: key })
      .where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId), or(isNull(b.howToTestKey), ne(b.howToTestKey, key))))
      .returning({ id: b.id })
      .execute();
    if (claimed.length === 0) return 'same_work';
    try {
      const { chatId } = await deps.ask(ctx, a.accountId, row.workspaceId, row.ident, howToTestQuestion());
      await db
        .update(b)
        .set({ howToTestChatId: chatId, howToTestSeenAt: null })
        .where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId), eq(b.howToTestKey, key)))
        .execute();
      return 'asked';
    } catch {
      // Not asked (the story's chat was busy, or could not start): release the claim so the next stored
      // work asks again. Nothing was written anywhere else.
      await db
        .update(b)
        .set({ howToTestKey: row.key })
        .where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId), eq(b.howToTestKey, key)))
        .execute()
        .catch(() => {});
      return 'failed';
    }
  } catch {
    return 'failed';
  }
}

/** The reader opened or dismissed it from the build tab. false ⇒ no such build. */
export async function markHowToTestSeen(accountId: number, buildId: number, now: Date = new Date()): Promise<boolean> {
  const b = schema.storyBuilds;
  const got = await db
    .update(b)
    .set({ howToTestSeenAt: now })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId)))
    .returning({ id: b.id })
    .execute();
  return got.length > 0;
}
