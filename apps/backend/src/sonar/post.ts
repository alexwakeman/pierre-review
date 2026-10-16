import type { SonarPostRecord, SonarSnapshot } from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import type { SonarDb } from './settings.js';
import { readSonarAccessForPr } from './settings.js';
import { claimSonarPost, readSonarSnapshot, writeSonarPost } from './store.js';
import { sonarCommentBody, sonarHasSomethingToPost } from './comment.js';

// POSTING A SNAPSHOT AS ONE PR COMMENT (docs/SONARCLOUD.md § Posting) — by hand ("Post SonarCloud
// findings" in the review tab) or after an AUTO review when the workspace's auto-posting is on with
// its SonarCloud kind (claude-review/auto-post.ts's rules: open, not a draft, not a bot's PR, and
// under scope 'mine' yours).
//
// THE RULE, both ways:
//   1. a snapshot at that head that READ successfully and has something to post;
//   2. ONCE PER (PR, head): `sonar_snapshots.post` NULL → claimed (`posting`) by compare-and-set
//      BEFORE the GitHub write. A second press, a second tab or a restart can never post twice;
//   3. the LIVE PR is open and still at that head (a moved head posts nothing);
//   4. ONE comment; record posted / failed; then settle the PR (the GitHub-write rule).
// ⚠ NEVER RETRIED: a failure is recorded and shown; a post cut off mid-flight stays `posting` for good
// (it may be on GitHub). An AUTO decision NOT to post writes nothing, so a person can still post.

export interface SonarPostDeps {
  livePr(owner: string, name: string, prNumber: number): Promise<{ headSha: string; state: string; draft: boolean; merged: boolean }>;
  postComment(owner: string, name: string, prNumber: number, body: string): Promise<{ commentId: string }>;
  settle(a: { accountId: number; prId: number; log: AgentContext['log'] }): Promise<{ visible: boolean }>;
}

export const defaultSonarPostDeps: SonarPostDeps = {
  async livePr(owner, name, prNumber) {
    const { defaultAutoPostDeps } = await import('../review/claude-review/auto-post.js');
    return defaultAutoPostDeps.livePr(owner, name, prNumber);
  },
  async postComment(owner, name, prNumber, body) {
    const { submitGithubIssueComment } = await import('../review/post-review.js');
    return submitGithubIssueComment({ owner, name, prNumber, body });
  },
  async settle(a) {
    const { settlePrAfterWrite } = await import('../sync/resync-after-write.js');
    return settlePrAfterWrite(a);
  },
};

export type SonarPostOutcome =
  | { kind: 'not_found' }
  | { kind: 'nothing_to_post' }
  | { kind: 'already_posted'; snapshot: SonarSnapshot }
  | { kind: 'head_moved' }
  | { kind: 'not_open' }
  | { kind: 'done'; snapshot: SonarSnapshot; visible: boolean };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Post (PR, head)'s snapshot. Throws only on a database error before the claim. */
export async function postSonarSnapshot(
  c: SonarDb & { log: AgentContext['log'] },
  a: { accountId: number; prId: number; headSha: string; trigger: 'manual' | 'auto' },
  deps: SonarPostDeps = defaultSonarPostDeps,
): Promise<SonarPostOutcome> {
  const { accountId, prId, headSha, trigger } = a;
  const snap = await readSonarSnapshot(c, accountId, prId, headSha);
  if (!snap) return { kind: 'not_found' };
  if (snap.post != null) return { kind: 'already_posted', snapshot: snap };
  if (!sonarHasSomethingToPost(snap)) return { kind: 'nothing_to_post' };
  const access = await readSonarAccessForPr(c, accountId, prId);
  if (!access) return { kind: 'not_found' };

  const live = await deps.livePr(access.owner, access.name, access.prNumber);
  if (live.merged || live.state !== 'open') return { kind: 'not_open' };
  if (live.headSha !== headSha) return { kind: 'head_moved' };

  const { body, issueCount, truncated } = sonarCommentBody(snap, { auto: trigger === 'auto' });
  const base: SonarPostRecord = {
    status: 'posting',
    at: new Date().toISOString(),
    trigger,
    commentId: null,
    error: null,
    issueCount,
    truncated,
  };
  // ⚠ THE CLAIM, BEFORE THE WRITE.
  if (!(await claimSonarPost(c, accountId, prId, headSha, base))) {
    const now = await readSonarSnapshot(c, accountId, prId, headSha);
    return now ? { kind: 'already_posted', snapshot: now } : { kind: 'not_found' };
  }
  let final: SonarPostRecord;
  try {
    const { commentId } = await deps.postComment(access.owner, access.name, access.prNumber, body);
    // GitHub has 201'd: nothing below may throw or retry.
    final = { ...base, status: 'posted', at: new Date().toISOString(), commentId };
  } catch (err) {
    final = { ...base, status: 'failed', at: new Date().toISOString(), error: errText(err) };
  }
  await writeSonarPost(c, accountId, prId, headSha, final).catch((err) =>
    c.log.warn(`sonar post pr ${prId}: could not record the result: ${errText(err)}`),
  );
  let visible = false;
  if (final.status === 'posted') {
    visible = (await deps.settle({ accountId, prId, log: c.log }).catch(() => ({ visible: false }))).visible;
  }
  const after = await readSonarSnapshot(c, accountId, prId, headSha).catch(() => null);
  return { kind: 'done', snapshot: after ?? { ...snap, post: final }, visible };
}

export type SonarAutoPostOutcome =
  | { kind: 'off' }
  | { kind: 'skipped'; reason: string }
  | SonarPostOutcome;

/**
 * After a SUCCEEDED AUTO review at `headSha`: post the head's snapshot when the workspace's
 * auto-posting AND its SonarCloud kind are on and the PR passes the auto-post eligibility rule.
 * Never throws.
 */
export async function maybeAutoPostSonar(
  ctx: AgentContext,
  a: { accountId: number; prId: number; headSha: string },
  deps: SonarPostDeps = defaultSonarPostDeps,
): Promise<SonarAutoPostOutcome> {
  try {
    const [{ readWorkspaceAutoPostForPr }, ap] = await Promise.all([
      import('../review/claude-review/auto-settings.js'),
      import('../review/claude-review/auto-post.js'),
    ]);
    const ws = await readWorkspaceAutoPostForPr(ctx, a.accountId, a.prId);
    if (!ws || !ws.settings.enabled || !ws.settings.kinds.sonar) return { kind: 'off' };
    const facts = await ap.readAutoPostPrFacts(ctx, ap.defaultAutoPostDeps, a.accountId, ws.workspaceId, a.prId);
    if (!facts) return { kind: 'not_found' };
    const notEligible = ap.autoPostEligibility(facts, ws.settings.scope);
    if (notEligible) return { kind: 'skipped', reason: notEligible };
    // The review started on receipt of the head, usually before SonarCloud finished analysing it:
    // read again now when that read found no analysis of this commit (snapshot.ts decides; a good
    // read is reused, and only an analysis OF THIS COMMIT is ever stored).
    const { ensureSonarSnapshot } = await import('./snapshot.js');
    await ensureSonarSnapshot(ctx, a.accountId, a.prId, a.headSha, { log: { warn: (m) => ctx.log.warn(m) } });
    return await postSonarSnapshot(ctx, { ...a, trigger: 'auto' }, deps);
  } catch (err) {
    ctx.log.warn(`sonar auto post pr ${a.prId}: ${errText(err)}`);
    return { kind: 'not_found' };
  }
}
