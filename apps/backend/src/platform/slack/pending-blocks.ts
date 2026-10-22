import {
  PENDING_DO_NEXT_SIZE,
  PENDING_TABS,
  type InsightCard,
  type MyTurnCardReason,
  type PendingBoardSnapshot,
  type PendingTabKey,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { fitSections } from './format.js';
import { escapeSlack, pendingLink, prLink, repoLink, slackLink } from './links.js';

// ── THE PENDING BOARD, AS SLACK SECTIONS ─────────────────────────────────────────────────────
//
// The digest opens on the workspace's TEAM Pending tabs — the SAME fold `/api/attention`
// serves (core `buildPendingBoard`, via the optional `ctx.queries.getPendingBoard` seam), so the
// channel and the board cannot list different cards. Deterministic: no model, no GitHub call.
//
//   • Sections follow `PENDING_TABS`, TEAM TABS ONLY: Needs fixing, Waiting on review, Unanswered
//     threads, Ready to land, Dependencies. Empty ones are skipped; the review-load people strip
//     is not a PR and is left out.
//   • ⚠ THE AUDIENCE IS THE TEAM, NOT WHOEVER SET IT UP. My turn and the Claude reviews tab read
//     ONE person's board (the configuring account's), so they are never sent
//     (`PERSONAL_PENDING_TABS`), and nothing says "your" or names the configuring account.
//   • ⚠ A FACT ABOUT THE CONFIGURING ACCOUNT IS NOT A TEAM FACT. The board is still that one
//     account's fold, so a card that is ABOUT the viewer is dropped (`isViewerScopedCard`): the
//     `ci_failing` card's `your_pr` arm ("a red build on YOUR PR") lists that person's PRs only,
//     never the team's. It is neither listed nor counted. What stays is a fact about a PR or a
//     branch that the viewer's access merely COVERS — a red default branch (`trunk` arm) and a
//     conflicting PR (minted in repos the viewer can push to): true for whoever reads them.
//   • ⚠ A PR IS MENTIONED ONCE — in the first tab (board order) that lists it. Later tabs drop it
//     and do not count it, so "and N more" is what that tab holds that this message did not name.
//   • Top `PENDING_DO_NEXT_SIZE` per section in the board's own order (`tab.cardIds` — score
//     order, grouped where the board groups).
//
// ⚠ THE WORDING IS A SECOND COPY. The SPA's chips live in apps/frontend/.../pendingLabels.ts, which
// the plugin cannot import. Keep this map small and plain; test/slack-pending-blocks.test.ts pins
// every kind and reason so a new one fails there first.
//
// ⚠ LIVE STATE. Nothing here may reach a payload hash (the sprint report's included).

export const PENDING_SLACK_PER_TAB = PENDING_DO_NEXT_SIZE;
const SECTION_MAX = 2900;
/** Sections one tab may use. Five lines fit one section; the second is headroom for long titles. */
const TAB_MAX_SECTIONS = 2;

/** Tabs that read ONE person's board — never sent to a team channel. */
export const PERSONAL_PENDING_TABS = new Set<PendingTabKey>(['my_turn', 'claude']);
type TeamPendingTabKey = Exclude<PendingTabKey, 'my_turn' | 'claude'>;

// ⚠ A NEW TAB KEY FAILS TO COMPILE HERE until someone decides: a team label, or personal.
export const PENDING_TAB_LABEL: Record<TeamPendingTabKey, string> = {
  fixing: 'Needs fixing',
  review: 'Waiting on review',
  threads: 'Unanswered threads',
  land: 'Ready to land',
  deps: 'Dependencies',
};

export const MY_TURN_REASON_TEXT: Record<MyTurnCardReason, string> = {
  review_request: 'Review requested',
  mention: 'Mentioned',
  thread: 'Reply needed',
  thread_reply: 'Reply to you',
  comment_reply: 'Comment after yours',
  pushed_since: 'Pushed since you looked',
  own_ci_red: 'Build failed',
  own_conflicts: 'Merge conflicts',
  trunk_red: 'Default branch is red',
  pr_approved: 'Approved',
  own_ready: 'Ready to land',
  your_pr: 'Your PR',
  own_thread: 'Unanswered thread',
  claude_review: 'Claude review',
  watched_repo_pr: 'New PR',
};

const age = (hours: number | null | undefined): string => {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return '';
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
};

const checks = (names: string[] | null | undefined, total: number | null | undefined): string => {
  if (names == null || names.length === 0) return '';
  const more = (total ?? names.length) - names.length;
  return `: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/** WHAT the card asks for, in plain words. Raw text — escaped by the caller. Reads only fields the
 *  card already carries; nothing is fetched. */
export function pendingCardText(card: InsightCard): string {
  const withDetail = (label: string, detail: string | null | undefined): string =>
    detail != null && detail.trim() !== '' ? `${label}: ${detail.trim()}` : label;
  switch (card.kind) {
    case 'my_turn':
      if (card.reason === 'trunk_red') {
        return `${MY_TURN_REASON_TEXT.trunk_red}${checks(card.failingChecks, card.failingCheckTotal)}`;
      }
      // An auto-started Claude review says so, in the SPA chip's words.
      if (card.reason === 'claude_review' && card.trigger === 'auto') {
        return withDetail('Auto review', card.detail);
      }
      return withDetail(MY_TURN_REASON_TEXT[card.reason], card.detail);
    case 'ci_failing':
      return `${card.arm === 'trunk' ? 'Default branch is red' : 'CI failing'}${checks(card.failingChecks, card.failingCheckTotal)}`;
    case 'conflicts':
      return 'Merge conflicts';
    case 'stalled_review': {
      const a = age(card.ageHours);
      return a === '' ? 'Waiting on review' : `Waiting on review for ${a}`;
    }
    case 'reviewer_routing':
      return 'Nobody asked to review';
    case 'untouched_thread': {
      const a = age(card.ageHours);
      return `Unanswered comment on ${card.path}${a === '' ? '' : `, ${a}`}`;
    }
    case 'merge':
      return 'Ready to merge';
    case 'update_branch':
      return 'Behind its base branch';
    case 'security':
      return card.dependencyUpdate ? withDetail('Security fix', card.detail) : 'Security alert';
    case 'dependency_bump':
      return withDetail('Dependency bump', card.detail);
    case 'reviewer_load':
    case 'bot_signal':
    case 'bot_only_review':
      return '';
  }
}

/** A card that is ABOUT the configuring account (its own PR's red build), not about the team's
 *  work. Never sent, never counted. */
export function isViewerScopedCard(card: InsightCard): boolean {
  return card.kind === 'ci_failing' && card.arm === 'your_pr';
}

/** The subject a card is about — one PR, or one repository's default branch. A PR is mentioned
 *  once per message; a red default branch too. */
function subjectKey(card: InsightCard): string | null {
  if (card.kind === 'my_turn' && card.reason === 'trunk_red') return `trunk:${card.repoId}`;
  if (card.kind === 'ci_failing' && card.arm === 'trunk') return `trunk:${card.repoId}`;
  if ('prId' in card && card.prId != null) return `pr:${card.prId}`;
  return null;
}

/** One card as one mrkdwn line: `• <link|acme/api#12 Title> by @login — what it needs`. */
function cardLine(
  ctx: ProContext,
  workspaceId: number,
  card: InsightCard,
  logins: ReadonlyMap<number, string>,
): string | null {
  const what = pendingCardText(card);
  if (what === '') return null;
  const isTrunk =
    (card.kind === 'my_turn' && card.reason === 'trunk_red') ||
    (card.kind === 'ci_failing' && card.arm === 'trunk');
  if (isTrunk && 'repoFullName' in card) {
    const branch = 'branchName' in card && card.branchName ? ` ${card.branchName}` : '';
    return `• ${slackLink(repoLink(ctx, workspaceId, card.repoId), `${card.repoFullName}${branch}`)} — ${escapeSlack(what)}`;
  }
  if (!('prId' in card) || card.prId == null || !('prNumber' in card) || card.prNumber == null) {
    return null;
  }
  const title = 'prTitle' in card && card.prTitle ? ` ${card.prTitle}` : '';
  const repo = 'repoFullName' in card ? card.repoFullName : '';
  const link = slackLink(prLink(ctx, workspaceId, card.prId), `${repo}#${card.prNumber}${title}`);
  const authorId = 'authorId' in card ? card.authorId : null;
  const login = authorId == null ? undefined : logins.get(authorId);
  const by = login ? ` by @${escapeSlack(login)}` : '';
  return `• ${link}${by} — ${escapeSlack(what)}`;
}

/** The Pending sections, as Slack `section` blocks (`mk` builds one — the caller's verbatim
 *  helper). Empty when the board has nothing to list. */
export function buildPendingBlocks(
  ctx: ProContext,
  board: PendingBoardSnapshot,
  mk: (text: string) => unknown,
): unknown[] {
  const workspaceId = board.workspaceId;
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const logins = new Map(board.users.map((u) => [u.id, u.githubLogin]));
  const tabs = new Map((board.tabs ?? []).map((t) => [t.key, t]));
  const seen = new Set<string>();
  const blocks: unknown[] = [];

  for (const def of PENDING_TABS) {
    if (PERSONAL_PENDING_TABS.has(def.key)) continue;
    const tab = tabs.get(def.key);
    if (tab == null) continue;
    const lines: string[] = [];
    let alreadyNamed = 0;
    let viewerScoped = 0;
    for (const id of tab.cardIds) {
      const card = byId.get(id);
      if (card == null) continue;
      if (isViewerScopedCard(card)) {
        viewerScoped += 1;
        continue;
      }
      const key = subjectKey(card) ?? `card:${card.id}`;
      if (seen.has(key)) {
        alreadyNamed += 1;
        continue;
      }
      if (lines.length >= PENDING_SLACK_PER_TAB) continue;
      const line = cardLine(ctx, workspaceId, card, logins);
      if (line == null) continue;
      seen.add(key);
      lines.push(line);
    }
    // What the tab holds that this message did not name: its whole count, less what is listed
    // here, what an earlier section already named, and the viewer's own cards (never sent).
    const more = Math.max(0, tab.total - lines.length - alreadyNamed - viewerScoped);
    if (lines.length === 0 && more === 0) continue;

    const label = PENDING_TAB_LABEL[def.key as TeamPendingTabKey];
    const body = [`*${escapeSlack(label)}* · ${lines.length + more}`, ...lines];
    if (more > 0) {
      body.push(slackLink(pendingLink(ctx, workspaceId, def.key), `and ${more} more`));
    }
    for (const chunk of fitSections(body.join('\n'), SECTION_MAX, TAB_MAX_SECTIONS)) {
      blocks.push(mk(chunk));
    }
  }
  return blocks;
}
