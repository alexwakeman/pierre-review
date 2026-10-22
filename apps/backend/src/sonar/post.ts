import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SonarInlinePost, SonarPostRecord, SonarSnapshot } from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import type { SonarDb } from './settings.js';
import { readSonarAccessForPr } from './settings.js';
import { claimSonarPost, readSonarSnapshot, writeSonarPost } from './store.js';
import { buildAnchorIndex, type AnchorIndex } from '../github/diff-anchor.js';
import {
  sonarCommentBody,
  sonarHasSomethingToPost,
  sonarInlineBody,
  sonarReviewMarker,
  splitSonarIssues,
} from './comment.js';

// POSTING A SNAPSHOT AS ONE GITHUB REVIEW (docs/SONARCLOUD.md § Posting) — by hand ("Post SonarCloud
// findings" in the review tab) or after an AUTO review when the workspace's auto-posting is on with
// its SonarCloud kind (claude-review/auto-post.ts's rules: open, not a draft, not a bot's PR, and
// under scope 'mine' yours).
//
// THE RULE, both ways:
//   1. a snapshot at that head that READ successfully and has something to post;
//   2. the LIVE PR is open and still at that head (a moved head posts nothing);
//   3. the issues are SPLIT against the live, noise-stripped diff (`splitSonarIssues`): an inline
//      thread for each issue on an addable RIGHT-side line, the summary for everything else, and an
//      issue already threaded on an EARLIER head of the PR (by SonarCloud issue key, from the earlier
//      snapshots' `post.inline` — a `posting` record counts: it may be on GitHub) is named in the
//      summary, never threaded twice. Nothing new to say ⇒ nothing posted, nothing claimed;
//   4. ONCE PER (PR, head): `sonar_snapshots.post` NULL → claimed (`posting`, with the planned inline
//      keys) by compare-and-set BEFORE the GitHub write. A second press, a second tab or a restart can
//      never post twice;
//   5. ONE review, event COMMENT, pinned to the head; an error is read back (the per-attempt nonce in
//      the body's marker), because GitHub has answered 422 for a review it published; the inline
//      comment ids are read back best-effort; record posted / failed; then settle the PR.
// ⚠ NEVER RETRIED: a failure is recorded and shown; a post cut off mid-flight stays `posting` for good
// (it may be on GitHub). An AUTO decision NOT to post writes nothing, so a person can still post.

export interface SonarReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface SonarPostDeps {
  livePr(owner: string, name: string, prNumber: number): Promise<{ headSha: string; state: string; draft: boolean; merged: boolean }>;
  // The PR's live diff with noise files (lockfiles, generated code) stripped — the same diff the
  // Claude review post anchors against.
  liveDiff(owner: string, name: string, prNumber: number): Promise<string>;
  postReview(
    owner: string,
    name: string,
    prNumber: number,
    review: { commitId: string; body: string; comments: SonarReviewComment[] },
  ): Promise<{ reviewId: string }>;
  // The review a failed POST created anyway (same commit, exactly this body, new since `sinceMs`).
  findLandedReview(owner: string, name: string, prNumber: number, want: { commitId: string; body: string; sinceMs: number }): Promise<string | null>;
  // The inline comments GitHub created for a review (best-effort read-back of their ids).
  reviewComments(
    owner: string,
    name: string,
    prNumber: number,
    reviewId: string,
  ): Promise<Array<{ id: number; path: string; line: number | null; original_line?: number | null; side?: 'LEFT' | 'RIGHT' | null; body: string }>>;
  settle(a: { accountId: number; prId: number; log: AgentContext['log'] }): Promise<{ visible: boolean }>;
}

export const defaultSonarPostDeps: SonarPostDeps = {
  async livePr(owner, name, prNumber) {
    const { defaultAutoPostDeps } = await import('../review/claude-review/auto-post.js');
    return defaultAutoPostDeps.livePr(owner, name, prNumber);
  },
  async liveDiff(owner, name, prNumber) {
    const [{ fetchPrDiff, stripNoiseFromDiff }, { isNoiseFile }] = await Promise.all([
      import('../review/post-review.js'),
      import('../review/prepare.js'),
    ]);
    return stripNoiseFromDiff(await fetchPrDiff(owner, name, prNumber), isNoiseFile).diff;
  },
  async postReview(owner, name, prNumber, r) {
    const { submitGithubReview } = await import('../review/post-review.js');
    return submitGithubReview({ owner, name, prNumber, commitId: r.commitId, body: r.body, event: 'COMMENT', comments: r.comments });
  },
  async findLandedReview(owner, name, prNumber, want) {
    const { findLandedReview } = await import('../review/post-seam.js');
    return findLandedReview(owner, name, prNumber, want);
  },
  async reviewComments(owner, name, prNumber, reviewId) {
    const { fetchReviewComments } = await import('../review/post-review.js');
    return fetchReviewComments(owner, name, prNumber, reviewId);
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

/**
 * The SonarCloud issue keys already threaded inline on ANOTHER head of this PR (account-scoped). A
 * `posting` record counts — cut off mid-flight, its threads may be on GitHub.
 */
export async function sonarKeysAlreadyInline(c: SonarDb, accountId: number, prId: number, exceptHead: string): Promise<Set<string>> {
  const t = c.schema.sonarSnapshots;
  const rows = (await c.db
    .select({ headSha: t.headSha, post: t.post })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId)))
    .execute()) as Array<{ headSha: string; post: SonarPostRecord | null }>;
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.headSha === exceptHead || r.post == null || r.post.status === 'failed') continue;
    for (const p of r.post.inline ?? []) keys.add(p.key);
  }
  return keys;
}

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

  // The live diff decides what may go inline. Unreadable (too large, gh failing) ⇒ everything goes
  // in the summary — never a guessed line.
  let index: AnchorIndex | null = null;
  try {
    index = buildAnchorIndex(await deps.liveDiff(access.owner, access.name, access.prNumber));
  } catch (err) {
    c.log.warn(`sonar post pr ${prId}: could not read the diff, so nothing goes inline: ${errText(err)}`);
  }
  const already = await sonarKeysAlreadyInline(c, accountId, prId, headSha);
  const split = splitSonarIssues(snap.issues, index, already);
  // Nothing new: every issue is already threaded and the gate did not fail.
  if (split.inline.length === 0 && split.summary.length === 0 && snap.qualityGate?.status !== 'ERROR') {
    return { kind: 'nothing_to_post' };
  }

  const auto = trigger === 'auto';
  const { body, issueCount, truncated } = sonarCommentBody(snap, {
    auto,
    split,
    marker: sonarReviewMarker(randomBytes(6).toString('hex')),
  });
  const comments: SonarReviewComment[] = split.inline.map((it) => ({
    path: it.path!,
    line: it.line!,
    side: 'RIGHT',
    body: sonarInlineBody(it, { auto }),
  }));
  const inline: SonarInlinePost[] = split.inline.map((it) => ({ key: it.key, path: it.path!, line: it.line!, commentId: null }));
  const base: SonarPostRecord = {
    status: 'posting',
    at: new Date().toISOString(),
    trigger,
    commentId: null,
    error: null,
    issueCount: issueCount + inline.length,
    truncated,
    githubReviewId: null,
    inline,
    summaryCount: issueCount,
    alreadyCount: split.already.length,
  };
  // ⚠ THE CLAIM, BEFORE THE WRITE.
  if (!(await claimSonarPost(c, accountId, prId, headSha, base))) {
    const now = await readSonarSnapshot(c, accountId, prId, headSha);
    return now ? { kind: 'already_posted', snapshot: now } : { kind: 'not_found' };
  }
  let final: SonarPostRecord;
  const startedAt = Date.now();
  let reviewId: string | null = null;
  let error: string | null = null;
  try {
    ({ reviewId } = await deps.postReview(access.owner, access.name, access.prNumber, { commitId: headSha, body, comments }));
  } catch (err) {
    // ⚠ AN ERROR IS NOT PROOF NOTHING WAS POSTED (post-seam.ts): look for THIS attempt's review.
    reviewId = await deps
      .findLandedReview(access.owner, access.name, access.prNumber, { commitId: headSha, body, sinceMs: startedAt })
      .catch(() => null);
    if (reviewId == null) error = errText(err);
  }
  if (reviewId != null) {
    // GitHub has 201'd: nothing below may throw or retry. The thread ids are best-effort.
    let ids = inline;
    if (comments.length > 0) {
      try {
        const { matchReviewComments } = await import('../review/post-review.js');
        const got = await deps.reviewComments(access.owner, access.name, access.prNumber, reviewId);
        const matched = new Map(
          matchReviewComments(
            comments.map((cm, i) => ({ ...cm, findingId: i })),
            got,
          ).map((m) => [m.findingId, m.commentId]),
        );
        ids = inline.map((p, i) => ({ ...p, commentId: matched.get(i) ?? null }));
      } catch {
        /* best-effort — the threads are on GitHub without a recorded id */
      }
    }
    final = { ...base, status: 'posted', at: new Date().toISOString(), githubReviewId: reviewId, inline: ids };
  } else {
    final = { ...base, status: 'failed', at: new Date().toISOString(), error };
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
