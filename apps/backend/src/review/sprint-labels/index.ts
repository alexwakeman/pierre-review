import { and, eq } from 'drizzle-orm';
import { STORY_LABEL_RUN_CAP } from '@pierre-review/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/client.js';
import { currentLabelRowsFor } from '../../db/story-health.js';
import { storyLabelInput } from '../../db/story-label-input.js';
import { setAfterSprintRead } from '../../tracker/sprint/hooks.js';
import type { AgentContext } from '../agent-context.js';
import {
  claimStoryLabelRun,
  releaseStoryLabelRun,
  startStoryLabelRun,
  type StoryToLabel,
} from '../story-labels/manager.js';

// REPORTS → THIS SPRINT — THE FREE LABELS. After each successful sprint list read, the in-sprint
// tickets with no CURRENT story label are sent through the EXISTING story label run
// (review/story-labels/: Haiku through `cheapComplete`, `STORY_RUBRIC_VERSION` + text-hash currency,
// one run per account) — so a sprint ticket's chips and Story health read the SAME label rows.
//
//   • Registered ONLY from `registerAgenticRoutes` (local; cloud registers nothing agentic), and
//     only acts when `config.aiEnabled`, the account has Reports (`periodReports`) and a Claude
//     credential is present.
//   • It never queues: a busy slot (a run already labelling) is skipped silently; the next read
//     (≤ 20 minutes) tries again, and a label that landed meanwhile is current and not sent twice.
//   • Done tickets are not labelled (the page counts them, it does not list them).

const STATUS_ORDER: Record<string, number> = { new: 0, indeterminate: 1 };

/** In-sprint, not-done tickets of the workspace with criteria and no CURRENT label, ≤ STORY_LABEL_RUN_CAP. */
export async function sprintStoriesToLabel(accountId: number, workspaceId: number): Promise<StoryToLabel[]> {
  const st = schema.sprintTickets;
  const rows = await db
    .select({
      ident: st.ident,
      provider: st.provider,
      title: st.title,
      description: st.description,
      acceptanceCriteria: st.acceptanceCriteria,
      statusCategory: st.statusCategory,
      issueKey: st.issueKey,
    })
    .from(st)
    .where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId), eq(st.inSprint, true)))
    .execute();
  const candidates = rows
    .filter((r) => r.statusCategory !== 'done')
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.statusCategory ?? ''] ?? 2) - (STATUS_ORDER[b.statusCategory ?? ''] ?? 2) ||
        a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }),
    )
    .flatMap((r) => {
      const input = storyLabelInput(r, r.provider);
      return input != null ? [{ ident: r.ident, input }] : [];
    });
  if (candidates.length === 0) return [];
  const current = await currentLabelRowsFor(accountId, candidates.map((c) => c.ident));
  return candidates.filter((c) => current.get(c.ident)?.has(c.input.textHash) !== true).slice(0, STORY_LABEL_RUN_CAP);
}

async function accountHasReports(accountId: number): Promise<boolean> {
  const [{ getAccountById }, { entitledProCapabilities }] = await Promise.all([
    import('../../auth/account.js'),
    import('../../pro/contract.js'),
  ]);
  const account = await getAccountById(accountId);
  return account != null && entitledProCapabilities(account).periodReports === true;
}

export interface SprintLabelSeams {
  aiEnabled?: boolean;
  entitled?: (accountId: number) => Promise<boolean>;
  start?: typeof startStoryLabelRun;
}

/**
 * Label this workspace's unlabelled sprint tickets, if allowed and the account's label slot is free.
 * Returns what happened (for the test). Never throws.
 */
export async function enqueueSprintLabels(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  seams: SprintLabelSeams = {},
): Promise<'off' | 'no_credential' | 'not_entitled' | 'busy' | 'nothing' | 'started' | 'failed'> {
  if (!(seams.aiEnabled ?? config.aiEnabled)) return 'off';
  try {
    if (ctx.llm.detectAuth().status !== 'ok') return 'no_credential';
    if (!(await (seams.entitled ?? accountHasReports)(accountId))) return 'not_entitled';
  } catch {
    return 'failed';
  }
  // ⚠ CLAIMED SYNCHRONOUSLY (no await between the check and the claim), released on every path that
  // does not hand off to a run.
  if (!claimStoryLabelRun(accountId)) return 'busy';
  let handedOff = false;
  try {
    const stories = await sprintStoriesToLabel(accountId, workspaceId);
    if (stories.length === 0) return 'nothing';
    (seams.start ?? startStoryLabelRun)(ctx, { accountId, workspaceId, stories, budgetUsd: config.storyLabelBudgetUsd });
    handedOff = true;
    return 'started';
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, route: 'sprint-labels', code: err instanceof Error ? err.name : 'unknown' }, 'sprint labelling failed (non-fatal)');
    return 'failed';
  } finally {
    if (!handedOff) releaseStoryLabelRun(accountId);
  }
}

/** Registered ONLY from registerAgenticRoutes (cloud never). Sets the after-read hook. */
export function registerSprintLabelling(ctx: AgentContext): void {
  setAfterSprintRead((accountId, workspaceId) => {
    void enqueueSprintLabels(ctx, accountId, workspaceId);
  });
}
