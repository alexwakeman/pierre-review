// THE BUILD TAB'S PURE HALF ("Implement story", docs/STORY-BUILD.md; docs/FRONTEND.md § The build tab):
// the action, the story view's entry, the repository words, the push gating and the error words.
// React-free so test/storyBuild.test.ts pins it. A session's own pure half is lib/sandboxSession.ts.
import {
  criterionCounts,
  isStoryBuildOpen,
  isTrackerIdent,
  parseTicketIdent,
  ticketBrowseUrl,
  trackerTicketRow,
  type TrackerProvider,
  storyBuildMark,
  storyBuildOffered,
  type JiraStatusCategory,
  type SprintGraphNode,
  type SprintNodeBuild,
  type SprintStage,
  type SprintTicketCheck,
  type StoryBuildMark,
  type TicketReview,
  type TicketReviewState,
  type StoryBuild,
  type StoryBuildAction,
  type StoryBuildErrorCode,
  type StoryBuildRepo,
  type StoryBuildRepoStatus,
} from '@pierre-review/shared';

// ── the ticket's own tracker ──────────────────────────────────────────────────────────────────────

/**
 * The tracker link for a ticket, from its IDENT alone (no fetch, no sprint read in memory): Jira's
 * browse page, the GitHub issue, the Linear issue, the Notion page. Null for an ident that does not
 * parse. The caller still sends it through `safeExternalUrl` (TrackerLinkOut).
 */
export function trackerLinkOfIdent(ident: string): { url: string; provider: TrackerProvider } | null {
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return null;
  const row = trackerTicketRow(parsed);
  const url = ticketBrowseUrl({ provider: row.provider, root: row.apiRoot }, row.issueKey);
  return url == null ? null : { url, provider: row.provider };
}

// ── the action: "Implement" or "Fill gaps" ─────────────────────────────────────────────────────────

/** The card button's accessible name and tooltip (and ⌘K's verb) for an action. */
export function storyBuildActionLabel(action: StoryBuildAction, key: string): { label: string; title: string } {
  return action === 'fill_gaps'
    ? { label: `Fill gaps in ${key}`, title: 'Fill the gaps the story check found' }
    : { label: `Implement ${key}`, title: 'Implement this ticket' };
}

/** Which action the build tab is about (its header and start state). A session that has assessed says so
 *  itself: the ticket had pull requests ⇒ it fills gaps. Before that, the board's own gate (a closed session
 *  is no session), else a ticket with an open or merged pull request ⇒ Fill gaps (the backend fills only
 *  the gaps whenever the ticket has PRs). With no sprint node in memory, what the story view offered when
 *  it opened the tab (`offered`, the tab's `buildOffer`), else Implement. */
export function storyBuildActionOf(
  build: Pick<StoryBuild, 'coverage'> | null,
  node: Pick<SprintGraphNode, 'ghost' | 'stage' | 'prs' | 'check'> | null,
  offered: StoryBuildAction | null = null,
): StoryBuildAction {
  if (build?.coverage != null) return build.coverage.existingPrs.length > 0 ? 'fill_gaps' : 'implement';
  if (node == null) return offered ?? 'implement';
  return storyBuildOffered({ ...node, build: null }) ?? (node.prs.some((p) => p.state !== 'closed') ? 'fill_gaps' : 'implement');
}

// ── the story view's entry: "Implement" / "Fill gaps" / "Open build" ────────────────────────────

/** The stage a ticket's tracker status CATEGORY implies, where the sprint board's bucket is not known
 *  (a story outside the sprint, or the board not read yet): To Do ⇒ Not started, Done ⇒ Complete, anything
 *  in between ⇒ started. Unknown ⇒ null (Implement is then never offered). */
export function storyStageOfCategory(category: JiraStatusCategory | null | undefined): SprintStage | null {
  if (category === 'new') return 'not_started';
  if (category === 'done') return 'done';
  if (category === 'indeterminate') return 'in_progress';
  return null;
}

/** The sprint card's check, from the story view's own ticket-check state and the latest succeeded run (the
 *  same counts `db/sprint-ticket-checks.ts` folds). null until that run is read, or with none. Stale when
 *  the state says so for any reason (a member PR moved, or the ticket text changed). */
export function storyViewCheck(state: TicketReviewState | null | undefined, run: TicketReview | null | undefined): SprintTicketCheck | null {
  if (state == null || state.latestRunId == null || run == null || run.id !== state.latestRunId || run.assessment == null) return null;
  const a = run.assessment;
  const n = criterionCounts(a.criteria);
  return {
    met: n.met,
    metOutsideCode: n.metOutsideCode,
    partlyMet: n.partlyMet,
    notMet: n.notMet,
    unsettled: n.unsettled,
    total: n.total,
    missing: Array.isArray(a.missing) ? a.missing.length : 0,
    reviewId: run.id,
    checkedAt: state.checkedAt ?? run.completedAt ?? run.createdAt,
    stale: state.status === 'stale' || state.staleBecause.length > 0,
  };
}

/** A full session as the board's coarse build (`db/sprint-builds.ts foldSprintBuilds`): null unless OPEN;
 *  only included repositories count. */
export function sprintNodeBuildOf(b: Pick<StoryBuild, 'id' | 'status' | 'repos'> | null | undefined): SprintNodeBuild | null {
  if (b == null || !isStoryBuildOpen(b.status)) return null;
  const inc = b.repos.filter((r) => r.include);
  return {
    id: b.id,
    status: b.status,
    readyRepos: inc.filter((r) => r.status === 'ready').length,
    pushedRepos: inc.filter((r) => r.status === 'pushed').length,
  };
}

/** What the story view's action group offers for its ticket: open the session it has, start one
 *  (shared `storyBuildOffered`, the ONE gate), or nothing. */
export type StoryViewBuildEntry =
  | { kind: 'open'; mark: StoryBuildMark }
  | { kind: 'offer'; action: StoryBuildAction; reviewId: number | null }
  | null;

export function storyViewBuildEntry(n: {
  ghost: boolean;
  stage: SprintStage | null;
  prs: ReadonlyArray<unknown>;
  build: SprintNodeBuild | null;
  check: SprintTicketCheck | null;
}): StoryViewBuildEntry {
  const mark = storyBuildMark(n.build);
  if (mark != null) return { kind: 'open', mark };
  const action = storyBuildOffered(n);
  return action != null ? { kind: 'offer', action, reviewId: action === 'fill_gaps' ? (n.check?.reviewId ?? null) : null } : null;
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────

export const STORY_BUILD_REPO_STATUS_WORDS: Record<StoryBuildRepoStatus, string> = {
  planned: 'Planned',
  queued: 'Waiting its turn',
  preparing: 'Preparing',
  building: 'Building',
  checking: 'Running tests',
  ready: 'Ready to push',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Left out',
  pushed: 'Pushed',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The status sentence of a row of the REMOVED plan/build flow (no `session`; a session's own line is
 *  lib/sandboxSession.ts `sessionStatusLine`). */
export function storyBuildStatusLine(b: Pick<StoryBuild, 'status' | 'repos' | 'pushedAll' | 'error'>): string {
  const included = b.repos.filter((r) => r.include);
  switch (b.status) {
    case 'assessing':
      return 'Reading the story and the code.';
    case 'planning':
      return 'Making the plan.';
    case 'plan_ready':
      return 'Stopped at the plan.';
    case 'building': {
      const done = included.filter((r) => r.status === 'ready' || r.status === 'pushed' || r.status === 'failed').length;
      return `Building ${plural(included.length, 'repository', 'repositories')}: ${done} done.`;
    }
    case 'ready': {
      if (b.pushedAll) return 'Pushed.';
      const ready = included.filter((r) => r.status === 'ready').length;
      const failed = included.filter((r) => r.status === 'failed').length;
      return `${plural(ready, 'repository', 'repositories')} ready to push${failed > 0 ? `, ${failed} failed` : ''}. Nothing is pushed until you press Push.`;
    }
    case 'failed':
      return b.error ?? 'The build failed.';
    case 'cancelled':
      return 'Cancelled.';
    case 'discarded':
      return 'Discarded.';
  }
}

/** The anchor a change report's criterion tag scrolls to (the session's Ticket panel). */
export function storyBuildRefAnchor(ref: string): string {
  return `story-build-ref-${ref}`;
}

// ── push ───────────────────────────────────────────────────────────────────────────────────────

/** Built, not pushed, with a change to push. Tests may be failing: the reader decides. */
export function canPushRepo(r: Pick<StoryBuildRepo, 'include' | 'status' | 'hasPatch'>): boolean {
  return r.include && r.status === 'ready' && r.hasPatch;
}

export function pushableRepos(b: Pick<StoryBuild, 'repos'>): StoryBuildRepo[] {
  return b.repos.filter(canPushRepo).sort((x, y) => x.order - y.order);
}

/** "Push all" sits in the header once two or more repositories are ready to push. */
export function pushAllOffered(b: Pick<StoryBuild, 'repos'>): boolean {
  return pushableRepos(b).length >= 2;
}

// ── errors ─────────────────────────────────────────────────────────────────────────────────────

/** Our sentence per code. `BadRequest` has none: the server's own sentence says what to fix. */
export const STORY_BUILD_ERROR_WORDS: Record<Exclude<StoryBuildErrorCode, 'BadRequest'>, string> = {
  NoClaudeAuth: 'Sign in to the AI first.',
  ModelNotOnProvider: 'That model is not available on this provider.',
  NoStory: 'Could not read this ticket’s story.',
  NotReady: 'Wait for the current step to finish.',
  NotFound: 'This build no longer exists.',
};

/** An action's failure in words: the code's sentence when it is one we know, else the server's. */
export function storyBuildErrorText(err: { code?: string | null; message?: string } | null | undefined): string | null {
  if (err == null) return null;
  const code = err.code ?? null;
  if (code != null && code in STORY_BUILD_ERROR_WORDS) return STORY_BUILD_ERROR_WORDS[code as keyof typeof STORY_BUILD_ERROR_WORDS];
  return err.message != null && err.message !== '' ? err.message : 'Something went wrong.';
}
