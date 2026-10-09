import type { InsightCard, InsightKind, MyTurnCardReason, PendingTabKey } from '@pierre-review/shared';
import {
  BotIcon,
  PendingActivityIcon,
  PendingApprovedIcon,
  PendingBallIcon,
  PendingBehindIcon,
  PendingBuildFailedIcon,
  PendingClaudeReviewIcon,
  PendingCommentAfterIcon,
  PendingConflictsIcon,
  PendingDependencyIcon,
  PendingLandIcon,
  PendingMentionIcon,
  PendingNeedsReviewerIcon,
  PendingNewPrIcon,
  PendingPushedIcon,
  PendingReplyOwedIcon,
  PendingReviewLoadIcon,
  PendingReviewRequestIcon,
  PendingSecurityAlertIcon,
  PendingSecurityFixIcon,
  PendingStalledIcon,
  PendingThreadReplyIcon,
  PendingTrunkRedIcon,
  PendingUnansweredIcon,
} from '../Icons.js';

// THE PENDING BOARD'S MARKS — one icon per card type, leading each card's heading, and one per
// tab and kind chip. Decorative (`aria-hidden` via the icon shell): the words beside each mark
// say the same thing. The two `Record`s are over the full unions, so a new kind or My Turn type
// fails to compile here until it has a mark.

type IconComponent = (props: { size?: number; className?: string }) => JSX.Element;

const KIND_ICON: Record<InsightKind, IconComponent> = {
  my_turn: PendingBallIcon,
  ci_failing: PendingBuildFailedIcon,
  conflicts: PendingConflictsIcon,
  stalled_review: PendingStalledIcon,
  untouched_thread: PendingUnansweredIcon,
  reviewer_load: PendingReviewLoadIcon,
  reviewer_routing: PendingNeedsReviewerIcon,
  merge: PendingLandIcon,
  update_branch: PendingBehindIcon,
  security: PendingSecurityAlertIcon,
  dependency_bump: PendingDependencyIcon,
  // Never on the board (the route filters them out); a mark so the Record is total.
  bot_signal: BotIcon,
  bot_only_review: BotIcon,
};

const REASON_ICON: Record<MyTurnCardReason, IconComponent> = {
  review_request: PendingReviewRequestIcon,
  mention: PendingMentionIcon,
  thread: PendingReplyOwedIcon,
  thread_reply: PendingThreadReplyIcon,
  comment_reply: PendingCommentAfterIcon,
  pushed_since: PendingPushedIcon,
  own_ci_red: PendingBuildFailedIcon,
  own_conflicts: PendingConflictsIcon,
  trunk_red: PendingTrunkRedIcon,
  pr_approved: PendingApprovedIcon,
  own_ready: PendingLandIcon,
  your_pr: PendingActivityIcon,
  own_thread: PendingUnansweredIcon,
  claude_review: PendingClaudeReviewIcon,
  watched_repo_pr: PendingNewPrIcon,
};

const TAB_ICON: Record<PendingTabKey, IconComponent> = {
  my_turn: PendingBallIcon,
  claude: PendingClaudeReviewIcon,
  fixing: PendingBuildFailedIcon,
  review: PendingStalledIcon,
  threads: PendingUnansweredIcon,
  land: PendingLandIcon,
  deps: PendingDependencyIcon,
};

/** The mark for one card: its My Turn type, or its kind — with the few kinds whose card says
 *  something narrower (a red default branch, a ready-but-behind own PR, a security fix). */
export function pendingCardIconOf(card: InsightCard): IconComponent {
  switch (card.kind) {
    case 'my_turn':
      if (card.reason === 'own_ready' && card.own?.kind === 'ready') return KIND_ICON[card.own.forward];
      return REASON_ICON[card.reason];
    case 'ci_failing':
      return card.arm === 'trunk' ? PendingTrunkRedIcon : PendingBuildFailedIcon;
    case 'security':
      return card.fix != null ? PendingSecurityFixIcon : PendingSecurityAlertIcon;
    default:
      return KIND_ICON[card.kind];
  }
}

export function PendingCardIcon({
  card,
  size = 13,
  className,
}: {
  card: InsightCard;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = pendingCardIconOf(card);
  return <Icon size={size} className={className} />;
}

export function PendingKindIcon({
  kind,
  size = 12,
  className,
}: {
  kind: InsightKind;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} className={className} />;
}

export function PendingTabIcon({
  tab,
  size = 12,
  className,
}: {
  tab: PendingTabKey;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = TAB_ICON[tab];
  return <Icon size={size} className={className} />;
}

export function PendingReasonIcon({
  reason,
  size = 12,
  className,
}: {
  reason: MyTurnCardReason;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = REASON_ICON[reason];
  return <Icon size={size} className={className} />;
}
