// AUTO-POSTING ON SCREEN — the words the Claude Review tab and Story check use for what
// auto-posting did (docs/CLAUDE-REVIEW.md § Auto-posting). Pure, so the copy is pinned by
// test/autoPost.test.ts.
import type {
  AutoPostSkipReason,
  AutoPostStatus,
  ClaudeAutoLiftRecord,
  ClaudeAutoPostWire,
  ClaudeAutoVerdictRecord,
  ClaudeFinding,
  ClaudeNotApproved,
  FindingAutoResolveRecord,
} from '@pierre-review/shared';
import { relativeTime } from './ui.js';

/** A posted finding's / item's chip: "Posted · 2 hours ago", or "Posted automatically · 3 mins ago". */
export function postedChipLabel(p: { postedAt: string | null; postedAuto?: boolean; earlier?: boolean }): string {
  if (p.postedAuto === true && p.postedAt != null) return `Posted automatically · ${relativeTime(p.postedAt)}`;
  if (p.earlier === true) return 'Posted earlier';
  // When it went on GitHub — the reader's own post by hand and a teammate's alike.
  return p.postedAt != null ? `Posted · ${relativeTime(p.postedAt)}` : 'Posted';
}

/** A finding's latest REMINDER chip ("Reminder posted · 3 mins ago"), shown BESIDE the original's
 *  chip; null when none was posted. */
export function reminderChipLabel(r: { postedAt: string | null } | null | undefined): string | null {
  if (r == null) return null;
  return r.postedAt != null ? `Reminder posted · ${relativeTime(r.postedAt)}` : 'Reminder posted';
}

/** A finding already on GitHub offers ONE post action, "Post reminder" (never the normal Post), on the
 *  editable run only. The server refuses a plain Post of it (409 AlreadyPosted). */
export function canPostReminder(post: EffectivePost | null, editable: boolean): boolean {
  return editable && post != null;
}

/** Where a finding is on GitHub: its own post, else `earlierPost` (its chain, or a matching comment of
 *  Limn's). null = not on GitHub. ⚠ A finding with either is DONE: no Post, no Ignore. */
export interface EffectivePost {
  postedAt: string | null;
  postedAuto: boolean;
  githubCommentId: string | null;
  postedCommentKind: 'inline' | 'pr_comment' | null;
  earlier: boolean;
}
export function effectivePost(
  f: Pick<ClaudeFinding, 'postedAt' | 'postedAuto' | 'githubCommentId' | 'postedCommentKind' | 'earlierPost'>,
): EffectivePost | null {
  if (f.postedAt != null) {
    return { postedAt: f.postedAt, postedAuto: f.postedAuto === true, githubCommentId: f.githubCommentId, postedCommentKind: f.postedCommentKind, earlier: false };
  }
  const e = f.earlierPost;
  if (e == null) return null;
  return { postedAt: e.postedAt, postedAuto: e.postedAuto, githubCommentId: e.githubCommentId, postedCommentKind: e.postedCommentKind, earlier: true };
}

/**
 * The one line a FAILED or PARTIAL auto post earns (the Post button stays beside it), else null.
 * A skip says nothing: nothing was meant to be posted.
 */
export function autoPostFailureLine(
  a:
    | {
        status: AutoPostStatus;
        error: string | null;
        liftedBlock?: ClaudeAutoLiftRecord | null;
        withdrewApproval?: ClaudeAutoPostWire['withdrewApproval'];
      }
    | null
    | undefined,
): string | null {
  if (a == null) return null;
  // A run whose only write was lifting Claude's earlier block (or withdrawing Limn's approval):
  // `autoLiftLine` / `approvalWithdrawLines` says what failed.
  if (a.status === 'failed' && a.liftedBlock?.how === 'dismiss_failed') return null;
  if (a.status === 'failed' && a.withdrewApproval?.how === 'withdraw_failed') return null;
  const why = a.error != null && a.error.trim() !== '' ? a.error.trim() : 'GitHub did not accept it.';
  if (a.status === 'failed') return `Couldn’t post automatically: ${why}`;
  if (a.status === 'partial') return `Couldn’t post all of it automatically: ${why}`;
  return null;
}

/**
 * The one line a SKIP earns when it still tells the reader something: 'already_posted' (there was
 * something to post, and an earlier post already put all of it on GitHub). Every other skip says
 * nothing.
 */
export function autoPostSkipLine(
  a: { status: AutoPostStatus; reason: AutoPostSkipReason | null; alreadyPostedCount?: number } | null | undefined,
): string | null {
  if (a == null || a.status !== 'skipped' || a.reason !== 'already_posted') return null;
  const n = a.alreadyPostedCount ?? 0;
  if (n <= 0) return 'Not posted automatically: it is already on GitHub.';
  return n === 1
    ? 'Not posted automatically: its one comment is already on GitHub.'
    : `Not posted automatically: all ${n} comments are already on GitHub.`;
}

/** What the automatic verdict did, when it wanted more than a comment; else null. */
export function autoVerdictLine(
  a: { status: AutoPostStatus; verdict?: ClaudeAutoVerdictRecord | null } | null | undefined,
  /** The provider that ran the review ('Claude' | 'Codex'; default Claude). */
  by = 'Claude',
): string | null {
  const v = a?.verdict;
  if (a == null || v == null || v.wanted === 'COMMENT') return null;
  if (v.heldReason == null) {
    if (a.status !== 'posted' && a.status !== 'partial') return null;
    return v.submitted === 'APPROVE' ? 'Approved automatically.' : 'Requested changes automatically.';
  }
  // A held APPROVE's "Not approved: …" reason is shown under the review's verdict (`notApprovedLine`),
  // once. A held REQUEST_CHANGES keeps its own line: its reason is about the findings, not the hold.
  if (v.wanted === 'APPROVE' && v.reasonText != null && v.reasonText !== '') return null;
  const verb = v.wanted === 'APPROVE' ? 'Not approved' : 'Changes not requested';
  switch (v.heldReason) {
    case 'own_pr':
      return `${verb}: this is your own PR.`;
    case 'prior_review':
      // Only a PERSON's standing review holds it (Limn's own automatic one never does).
      return `${verb}: your own review on GitHub still stands.`;
    case 'already_requested':
      return `Changes already requested by ${by}’s earlier review.`;
    case 'reviews_unreadable':
      return `${verb}: couldn’t read your earlier reviews on GitHub.`;
    case 'impact':
      // Unknown is held as if High; the line says which it was, the ⓘ in Settings says why.
      return v.impact === 'high' || v.impact === 'medium' || v.impact === 'low'
        ? `${verb}: ${v.impact[0]!.toUpperCase()}${v.impact.slice(1)} impact.`
        : `${verb}: impact unknown.`;
    case 'refused':
      return a.status === 'posted' || a.status === 'partial'
        ? `${verb}: GitHub refused it, so the comments were posted on their own.`
        : `${verb}: GitHub refused it.`;
    default:
      return null;
  }
}

/**
 * WHY IT WAS NOT APPROVED, the one line under the review's verdict (docs/CLAUDE-REVIEW.md § AUTO
 * VERDICT → The reason): the server's `notApproved` (recorded by auto-posting, else computed on read),
 * else the auto-post record's own reason; null on an approval or when the auto verdict is off. With
 * "· Posted on GitHub." when the reason went out as a comment of its own.
 */
export function notApprovedLine(r: {
  notApproved?: ClaudeNotApproved | null;
  autoPost?: Pick<ClaudeAutoPostWire, 'status' | 'verdict' | 'reasonOnly'> | null;
}): string | null {
  const v = r.autoPost?.verdict;
  const approved = v?.submitted === 'APPROVE' && (r.autoPost?.status === 'posted' || r.autoPost?.status === 'partial');
  if (approved) return null;
  const text = r.notApproved?.text ?? (v?.reasonText != null && v.reasonText !== '' ? v.reasonText : null);
  if (text == null) return null;
  const postedAlone = r.autoPost?.reasonOnly === true && (r.autoPost.status === 'posted' || r.autoPost.status === 'partial');
  return postedAlone ? `${text} Posted on GitHub.` : text;
}

/** What happened to Claude's earlier automatic request for changes, when this run lifted it; else
 *  null. A superseding APPROVE says nothing more than "Approved automatically." */
export function autoLiftLine(
  a: { liftedBlock?: ClaudeAutoLiftRecord | null } | null | undefined,
  /** The provider that ran the review ('Claude' | 'Codex'; default Claude). */
  by = 'Claude',
): string | null {
  const l = a?.liftedBlock;
  if (l == null || l.how === 'superseded') return null;
  if (l.how === 'dismissed') return `Lifted ${by}’s earlier request for changes.`;
  const why = l.error != null && l.error.trim() !== '' ? l.error.trim() : 'GitHub did not accept it.';
  return `Couldn’t lift ${by}’s earlier request for changes: ${why}`;
}

/** What this run did to TEAMMATES' Limn blocks (docs/CLAUDE-REVIEW.md § Lifting a teammate's block):
 *  one line each — dismissed, or why GitHub refused. [] when it lifted none. */
export function teammateLiftLines(
  a: Pick<ClaudeAutoPostWire, 'liftedTeammateBlocks'> | null | undefined,
): Array<{ text: string; failed: boolean }> {
  return (a?.liftedTeammateBlocks ?? []).map((l) => {
    if (l.status === 'dismissed') return { text: `Dismissed ${l.login}’s request for changes: every point is addressed.`, failed: false };
    if (l.status === 'dismissing') return { text: `Dismissing ${l.login}’s request for changes.`, failed: false };
    const why = l.error != null && l.error.trim() !== '' ? l.error.trim() : 'GitHub did not accept it.';
    return { text: `Couldn’t dismiss ${l.login}’s request for changes: ${why}`, failed: true };
  });
}

/** Limn withdrawing its OWN automatic approval (docs/CLAUDE-REVIEW.md § Withdrawing Limn's approval):
 *  on the approving run, what became of it; on a later run, that it withdrew it first. [] otherwise. */
export function approvalWithdrawLines(
  a: Pick<ClaudeAutoPostWire, 'approvalWithdrawal' | 'withdrewApproval'> | null | undefined,
): Array<{ text: string; failed: boolean }> {
  const out: Array<{ text: string; failed: boolean }> = [];
  const why = (e: string | null | undefined) => (e != null && e.trim() !== '' ? e.trim() : 'GitHub did not accept it.');
  const w = a?.approvalWithdrawal;
  if (w != null) {
    if (w.status === 'withdrawn') out.push({ text: w.message, failed: false });
    else if (w.status === 'failed') out.push({ text: `Couldn’t withdraw this approval: ${why(w.error)}`, failed: true });
  }
  const d = a?.withdrewApproval;
  if (d != null) {
    out.push(
      d.how === 'withdrawn'
        ? { text: 'Withdrew Limn’s earlier approval.', failed: false }
        : { text: `Couldn’t withdraw Limn’s earlier approval: ${why(d.error)}`, failed: true },
    );
  }
  return out;
}

/** A finding's auto-resolve, in words: resolved, or why not. null when it was never tried. */
export function autoResolveLabel(r: FindingAutoResolveRecord | null | undefined): string | null {
  if (r == null) return null;
  // The person had resolved it already: Limn only said how it was fixed (no resolve).
  if (r.status === 'resolved' && r.alreadyResolved === true) return 'Said how it was fixed (the thread was already resolved)';
  if (r.status === 'resolved') {
    // Resolved on a teammate's Limn's word (gap 13): their review found it fixed at this commit.
    return r.why === 'teammate' && r.checkedBy ? `Resolved automatically (checked by ${r.checkedBy}’s Limn)` : 'Resolved automatically';
  }
  if (r.status === 'resolving') return 'Resolving automatically';
  const why = r.error != null && r.error.trim() !== '' ? r.error.trim() : 'GitHub did not accept it.';
  return `Couldn’t resolve automatically: ${why}`;
}
