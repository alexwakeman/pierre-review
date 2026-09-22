import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type {
  AutomatedReviewerKind,
  CiFailingCard,
  ConflictsCard,
  DependencyBumpCard,
  InsightCard,
  InsightPrRef,
  InsightReviewer,
  InsightSeverity,
  MergeQueueEntryState,
  MergeReadyCard,
  MergeStateStatus,
  MyTurnCard,
  MyTurnCardReason,
  MyTurnOwnWork,
  MyTurnTrunkCard,
  PrAutomation,
  ReviewerRoutingCard,
  ReviewStanding,
  SecurityAlert,
  SecurityCard,
  StalledReviewCard,
  UntouchedThreadCard,
  UpdateBranchCard,
  User,
} from '@pierre-review/shared';
import type { MergeVerdictInfo, MyTurnDismissTarget } from '@pierre-review/shared';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import {
  mergePrMutationKey,
  updateBranchMutationKey,
  useRequestReviewers,
} from '../../hooks/usePrWrites.js';
import { usePrArmedIntent, usePrStoppedIntent } from '../../hooks/useAutoMerge.js';
import { useDismissMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import {
  advisoryUrl,
  automatedReviewerMeta,
  CI_META,
  dateTime,
  indexUsers,
  MERGE_TONE_CLASS,
  mergeVerdict,
  relativeTime,
  REVIEW_STATE_META,
  safeExternalUrl,
  userLabel,
  vendorInk,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import {
  BotIcon,
  CheckIcon,
  ChevronIcon,
  ExternalLinkIcon,
  MergeIcon,
  ShieldIcon,
  SparkleIcon,
  WarningIcon,
} from '../Icons.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { AiSummary } from '../AiSummary.js';
import { ThreadCard } from '../ThreadView/index.js';
import { armedPhaseHeadline, TERMINAL_LABEL } from '../AutoMergeBanner.js';
import { MergeControl } from '../MergeControl.js';
import { MergeWhenReadyControl } from '../MergeWhenReadyControl.js';
import {
  ResolveConflictsButton,
  useConflictResolverEntry,
} from '../conflicts/ResolveConflictsButton.js';
import { LargePrFlag } from './LargePrFlag.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import {
  AUTHOR_ROLE_CHIP,
  cardKindLabel,
  DEP_STATE_LABEL,
  depStateSentence,
  KIND_LABEL,
  myTurnReasonLabel,
  SECURITY_ALERT_SOURCE_LABEL,
} from './pendingLabels.js';
import { CardPlacementInfo, PendingBoardContext, type PendingBoardInfo } from './PendingInfo.js';

// The attention-card list — the stalled-review / untouched-thread / reviewer-load / needs-a-reviewer
// cards, with the full drill-down behaviour (click a card to open the PR / thread, inline thread
// reply+resolve, suggested-reviewer assign, lazy PR summary, and back-from-a-click flash). Extracted
// from InsightsView so it can be rendered in BOTH the (Pro) Insights pane and the CORE/free Feed
// **Pending** rail entry — the same JSX, just fed from a different data hook. It depends only on core
// stores/hooks (usePinnedTabs / useFilters / usePr / useThread / useRequestReviewers), so it's tier-
// agnostic. Callers pass already-filtered `cards` (bot cards excluded upstream).

// Left-accent + label per severity — the same visual grammar as the Feed's cards.
const SEV: Record<InsightSeverity, { border: string; dot: string }> = {
  high: { border: 'border-l-red-400 dark:border-l-red-500', dot: 'bg-red-500' },
  warn: { border: 'border-l-amber-400 dark:border-l-amber-500', dot: 'bg-amber-500' },
  info: { border: 'border-l-sky-400 dark:border-l-sky-500', dot: 'bg-sky-500' },
};

// The kind and card labels live in `pendingLabels.ts` (the Pending info popovers read them too, and
// importing them from here would be a cycle); re-exported so existing importers keep one path.
export { cardKindLabel, KIND_LABEL, myTurnReasonLabel };

/** GitHub's protection-aware merge state, as a short chip label. Transplanted from the deleted
 *  WorkPlanCard — `lib/ui.ts` carries `MERGE_STATE_STATUSES` and `mergeVerdict()` but no label
 *  map. Kept a total `Record<MergeStateStatus, …>` so a new GitHub state forces a decision here
 *  rather than rendering a raw enum. */
const MERGE_STATE_LABEL: Record<MergeStateStatus, string | null> = {
  clean: 'clean',
  dirty: 'conflicts',
  // ⚠ `unstable` IS mergeable — only non-required checks are red.
  unstable: 'unstable',
  blocked: 'blocked',
  behind: 'behind trunk',
  has_hooks: 'has hooks',
  unknown: null,
};

/**
 * THE SECOND FACT ON A CONFLICTS CARD, or nothing.
 *
 * The header already says "Merge conflicts", so repeating `MERGE_STATE_LABEL.dirty` under it is the
 * same sentence twice on the one board where every line has to earn its width. But the kind is
 * minted on TWO predicates — `mergeStateStatus === 'dirty'` OR `mergeable === 'conflicting'` — and
 * on the second arm GitHub's own state says something else ('blocked'), which the reader cannot get
 * from anywhere else on the row. So: suppress it on the `dirty` arm, print it on the other.
 *
 * ⚠ `null` IS "NOT OBSERVED" AND SAYS NOTHING, exactly like 'unknown'. The card can be minted off
 * `mergeable` alone, and a state GitHub has not computed is not a fact to print.
 *
 * ⚠ DO NOT ROUTE THIS THROUGH `mergeVerdict()` INSTEAD. Its queue branch runs first, so a
 * conflicting PR sitting in GitHub's merge queue would report 'queued' and LOSE the conflict
 * statement — and the queue is already stated by `pendingQueueBadge` in the header row.
 */
export function conflictsStateChip(card: Pick<ConflictsCard, 'mergeStateStatus'>): string | null {
  if (card.mergeStateStatus == null || card.mergeStateStatus === 'dirty') return null;
  return MERGE_STATE_LABEL[card.mergeStateStatus];
}

/** The header chip for GitHub's own merge queue. */
export interface PendingQueueBadge {
  label: string;
  title: string;
  /** 'ok' — the queue holds it and is working through it. 'bad' — GitHub is taking it back out. */
  tone: 'ok' | 'bad';
}

/** ONE label per entry state, so a new GitHub member forces a decision here rather than rendering
 *  a raw enum. Each says what the QUEUE is doing, because that is the part the reader cannot see
 *  from anything else on the card. */
const QUEUE_STATE_LABEL: Record<MergeQueueEntryState, string> = {
  queued: 'In the merge queue',
  awaiting_checks: 'Merge queue · running checks',
  mergeable: 'Merge queue · lands next',
  locked: 'Merge queue · held',
  // ⚠ THE ONE THAT EARNS THE FIELD. GitHub ejects an entry whose checks failed against the merged
  // result, and this chip is the only warning a reader gets before the PR silently reappears
  // un-queued. It is the whole payload of the reported bug — visible WITHOUT clicking Merge.
  unmergeable: 'Leaving the merge queue',
};

const QUEUE_STATE_TITLE: Record<MergeQueueEntryState, string> = {
  queued: 'This pull request is waiting its turn in GitHub’s merge queue.',
  awaiting_checks:
    'It is at the front of GitHub’s merge queue, running the queue’s checks against the merged result.',
  mergeable: 'The queue’s checks passed. GitHub lands this pull request next.',
  locked: 'GitHub is holding this entry while an earlier one in the same batch settles.',
  unmergeable:
    'GitHub is taking this pull request out of the merge queue — the queued merge failed its checks, or it no longer applies. Fix it and queue it again.',
};

/**
 * THE QUEUE CHIP, decided from the card's OWN synced fields — pure, and never a fetch.
 *
 * ⚠ `inMergeQueue: null` IS "NOT OBSERVED" AND RENDERS NOTHING. A card that said "not queued" on
 * no evidence would be a false claim, and `false` — a positive statement from GitHub — has nothing
 * to say either: "this PR is not in a queue" is true of nearly every PR in the world. So the chip
 * is POSITIVE-CLAIM-ONLY, exactly like `authorSourceLabel` above.
 *
 * ⚠ AND IT IS NOT PART OF THE MERGE-ACTIONS BLOCK. That block returns null for a reader without
 * push access, and "GitHub is already landing this" is arguably the MORE useful fact for someone
 * who has no button either way. It belongs to the card's identity, in the header row.
 *
 * The entry state is read only for the WORDING; membership is `inMergeQueue`, per the wire's own
 * rule that the state is never the thing to test for "is it queued?".
 */
export function pendingQueueBadge(
  pr: Partial<Pick<InsightPrRef, 'inMergeQueue' | 'mergeQueueEntryState'>>,
): PendingQueueBadge | null {
  if (pr.inMergeQueue !== true) return null;
  const state = pr.mergeQueueEntryState ?? null;
  if (state == null) {
    return {
      label: 'In the merge queue',
      title: 'This pull request is in GitHub’s merge queue.',
      tone: 'ok',
    };
  }
  return {
    label: QUEUE_STATE_LABEL[state],
    title: QUEUE_STATE_TITLE[state],
    tone: state === 'unmergeable' ? 'bad' : 'ok',
  };
}


/**
 * DOES THIS ROW OUTRANK THE NEUTRAL ONES? The visual half of the same claim `cardKindLabel` makes
 * in words — 'direct' ("Your turn") and 'maintained' ("In your repos") are drawn heavier and
 * darker, everything else keeps the quiet kind label.
 *
 * ⚠ BOTH TIERS, TOGETHER. `myTurnPersonal`, the Workspace badges, the "Elsewhere" rows and the
 * browser notification all count `relevance !== 'none'` — direct AND maintained as ONE population.
 * Emphasising only 'direct' would put a different population on screen from the one every badge
 * counts, which is the count-vs-list mismatch this whole feature family exists to prevent.
 *
 * ⚠ AN ABSENT `relevance` IS NEUTRAL, and so is an absent-but-`personal: true` card — the same
 * rule `cardKindLabel` follows one line up. A missing field may never invent an ownership claim on
 * screen, in words OR in weight.
 *
 * ⚠ A MUTED CARD IS NEUTRAL FOR FREE. The Pending mute forces `relevance: 'none'` server-side, at
 * the one fold where it is derived, so nothing here has to know the mute exists — and nothing here
 * may re-introduce emphasis for it.
 *
 * ⚠ `my_turn` ONLY, and that is not an oversight. The two FORWARD kinds carry `relevance` for the
 * RANKER's weight, not as an ownership claim (see MergeReadyCard.relevance), the board's relevance
 * lens deliberately does not filter on it, and — decisively — the mute does not reach them. A
 * muted repo's `merge` card still arrives 'direct', so emphasising it would light up exactly the
 * row the reader asked to stop being summoned by.
 */
export function pendingCardIsPersonal(card: InsightCard): boolean {
  if (card.kind !== 'my_turn') return false;
  return card.relevance === 'direct' || card.relevance === 'maintained';
}


function ageLabel(hours: number): string {
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * "opened 3d" — HOW OLD THE PULL REQUEST ITSELF IS, for the card kinds whose right-hand meta
 * answers a different question (when the thing that needs you happened, when the head commit
 * landed, "unassigned"). A reader triaging fifty rows asked for the one fact none of those carry:
 * has this been sitting here two hours or two weeks.
 *
 * ⚠ ONE FORMATTER, TWO CLOCKS, AND THEY MUST NOT BE COLLAPSED. `ageLabel` above is fed a
 * SERVER-computed `ageHours` on `stalled_review` and `untouched_thread`; those two keep saying
 * "waiting 4d" / "6h old" because that IS the question they ask. This one turns the wire's absolute
 * `openedAt` into hours here-side. The rounding matches the server's spelling
 * (`Math.round(ms / 3_600_000)`) so one PR can never read "waiting 47h" on one card and "opened 2d"
 * on another.
 *
 * ⚠ `ageLabel` DOES NOT ROUND ITS ARGUMENT — it interpolates it. A raw float lands on the card as
 * "opened 3.7166666666666663h", so the rounding has to happen HERE.
 *
 * Returns null for anything we cannot read (a response predating the field, a malformed date); the
 * card then renders no age at all, which is the honest answer for "we don't know" and is never
 * "0h".
 */
export function openedAgeLabel(openedAt: string | null | undefined): string | null {
  const l = ageLabelFrom(openedAt);
  return l == null ? null : `opened ${l}`;
}

/** The bare "3d" for an absolute instant, or null when we cannot read one. */
function ageLabelFrom(iso: string | null | undefined): string | null {
  const ms = msSince(iso);
  return ms == null ? null : ageLabel(Math.round(ms / 3_600_000));
}

/**
 * Does this card's OWN clock still say something the open date does not?
 *
 * ⚠ MEASURED, AND IT IS THE MAJORITY CASE: 779 of 1,411 open non-draft PRs (55%) have no commit
 * after the one they opened with — a dependency bump is the common shape — so a `merge` card's
 * `lastCommitAt` and its `openedAt` round to the SAME label. `my_turn` collapses the same way
 * whenever nobody has touched a PR since it appeared, because the ball arrived when it opened. On
 * the reporting account's own workspace that was TEN OF TEN cards reading "8 hours ago · opened
 * 8h": one figure, twice, under two names, with only one of the names saying what it measures.
 *
 * So when the two agree, the NAMED one wins and the bare relative time is dropped. The reader
 * loses nothing — it was the same number — and gains the word that says which clock it is. When
 * they disagree the card shows both, because then the second one is a fact: "2 hours ago · opened
 * 3d" is a PR that has been open three days and was pushed to two hours ago.
 *
 * ⚠ IT COMPARES WHAT THE ROW PRINTS, THROUGH TWO DIFFERENT FORMATTERS, AND THAT IS THE WHOLE
 * SUBTLETY. `right` is rendered by `relativeTime` (minutes, then hours to 24h, then days); the age
 * is rendered by `ageLabel` (hours to 48h, then days). They switch units at DIFFERENT thresholds,
 * so comparing either one's output against itself is wrong. The first cut compared two
 * `ageLabel` strings and left a live 12-hour window — head commit 36-47h old on a PR opened
 * 48-59h ago — where it reported "different" about a row printing "2 days ago · opened 2d", the
 * exact duplication it exists to remove. Compare the FIGURES each side actually shows: same unit
 * AND same number ⇒ the reader is looking at one fact twice.
 *
 * ⚠ THIS IS THE SAME RULE `stalled_review` AND `untouched_thread` ARE EXEMPT UNDER, applied at
 * render time instead of by kind. Those two never pass `openedAt` at all: their server-computed
 * `ageHours` IS the open age (stalled) or a different subject's age (the thread), so for them the
 * question never arises.
 */
export function clockSaysMore(
  clockAt: string | null | undefined,
  openedAt: string | null | undefined,
): boolean {
  const shown = shownByRelativeTime(clockAt);
  if (shown == null) return false;
  const age = shownByAgeLabel(openedAt);
  // An unreadable open date renders NO age, so the clock is the row's only time — keep it.
  if (age == null) return true;
  // ⚠ BOTH TESTS MUST SAY "DIFFERENT", AND THEY CATCH DIFFERENT THINGS. The FIGURES test kills
  // "2 days ago · opened 2d" (a 40h commit on a 50h-old PR — same printed figure, two formatters).
  // The LABEL test kills "1 day ago · opened 30h" (a 30.4h commit on a 30h-old PR — two different
  // printed figures that invite the reader to infer a six-hour gap that is not there). Either
  // alone leaves the other on screen.
  const figuresDiffer = !(shown.unit === age.unit && shown.value === age.value);
  const labelsDiffer = ageLabelFrom(clockAt) !== ageLabelFrom(openedAt);
  return figuresDiffer && labelsDiffer;
}

/** A figure a reader compares: the number and the unit it is printed in. */
interface ShownSpan {
  unit: 'min' | 'hour' | 'day';
  value: number;
}

/** What `lib/ui.ts`'s `relativeTime` PRINTS for an instant — the formatter `right` goes through on
 *  every kind that passes `clockAt`. `just now` and the absolute date past 30 days carry no
 *  comparable figure, so they return null and the clock always survives. */
function shownByRelativeTime(iso: string | null | undefined): ShownSpan | null {
  const ms = msSince(iso);
  if (ms == null) return null;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (ms < min) return null; // "just now"
  if (ms < hr) return { unit: 'min', value: Math.round(ms / min) };
  if (ms < day) return { unit: 'hour', value: Math.round(ms / hr) };
  if (ms < 30 * day) return { unit: 'day', value: Math.round(ms / day) };
  return null; // an absolute date — never a duplicate of a relative age
}

/** What `openedAgeLabel` PRINTS for an instant, in the same comparable shape. */
function shownByAgeLabel(iso: string | null | undefined): ShownSpan | null {
  const ms = msSince(iso);
  if (ms == null) return null;
  const hours = Math.round(ms / 3_600_000);
  return hours < 48
    ? { unit: 'hour', value: hours }
    : { unit: 'day', value: Math.round(hours / 24) };
}

/** Elapsed milliseconds, clamped at zero for clock skew; null when unreadable. */
function msSince(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

/**
 * The tab meta for a PR named by an Activity card. EXPORTED so a second card surface (the
 * Bottlenecks panel's evidence PRs) opens a PR the SAME way rather than hand-building a
 * `PinnedPr` beside it: the author chrome comes from the response's own `users` table when the
 * ref carries an `authorId`, and stays null when it does not — PrDetail backfills it on load via
 * `syncMeta`. A hand-built literal is how one surface ends up opening a tab with a different
 * title or a missing avatar from the identical click on another.
 */
export function metaFor(
  card: { prId: number; prNumber: number; prTitle: string; repoFullName: string; authorId?: number | null },
  usersById: Map<number, User>,
): PinnedPr {
  const author = card.authorId != null ? usersById.get(card.authorId) : undefined;
  return {
    id: card.prId,
    number: card.prNumber,
    title: card.prTitle,
    repoFullName: card.repoFullName,
    authorLogin: author?.githubLogin ?? null,
    authorDisplayName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
  };
}

function UserChip({
  id,
  usersById,
}: {
  id: number;
  usersById: Map<number, User>;
}): JSX.Element {
  const u = usersById.get(id);
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
      <Avatar user={u} size={13} />
      <UserName user={u} fallbackId={id} />
    </span>
  );
}

// A small vendor pill for an automated actor — the same chip grammar the bot-signal card +
// provenance badges use (colour from automatedReviewerMeta). Rendered on an untouched thread
// whose original commenter is a classified review bot, and on any card whose PR AUTHOR is
// automation.
//
// ⚠ `kind: null` IS A FIRST-CLASS CASE, not a "shouldn't happen": an unbranded CI service account
// is a bot we recognise (via `users.isBot` or a workspace judgement) whose VENDOR we do not, and
// it is common. It renders the generic pill — never nothing, which would read as "a person".
function BotVendorPill({
  kind,
  title,
}: {
  kind: AutomatedReviewerKind | null;
  title?: string;
}): JSX.Element {
  const meta = kind != null ? automatedReviewerMeta(kind) : null;
  // ⚠ The TEXT comes from `botKindLabel`, never from `meta?.label ?? 'Bot'` spelled again here —
  // `authorSourceLabel` (which decides whether this pill appears at all, and is what the test
  // asserts on) reads the same function, so the two can never disagree about what the chip says.
  // The unbranded pill borrows the neutral ink the rest of the meta row uses rather than
  // inventing a colour — a colour is a brand claim, and this is precisely the case where we
  // have no brand.
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium${
        meta == null ? ' bg-gray-500/10 text-gray-600 dark:text-gray-300' : ''
      }`}
      style={meta != null ? { ...vendorInk(meta.color), background: `${meta.color}1a` } : undefined}
      title={title ?? 'This thread was opened by an automated reviewer'}
    >
      <BotIcon size={12} />
      {botKindLabel(kind)}
    </span>
  );
}

/** The BRAND NAME for an automated actor, or the generic "Bot" when no vendor is recognised.
 *  ONE spelling, read by the pill that draws it AND by `authorSourceLabel` below. */
function botKindLabel(kind: AutomatedReviewerKind | null): string {
  return kind != null ? automatedReviewerMeta(kind).label : 'Bot';
}

/** The two PR-source facts a meta row renders its chip from — its OWN type rather than the whole
 *  `InsightPrRef`, so a surface with no workspace bot judgement (the search card, which adapts a
 *  loaded PR detail) can omit them instead of being forced to invent `authorIsBot: false`. */
export type PrSourceRef = Pick<InsightPrRef, 'authorIsBot' | 'authorBotKind'>;

/**
 * THE CHIP A CARD'S AUTHOR EARNS: a vendor name, the generic "Bot", or null for no chip at all.
 *
 * ⚠ THE CHIP ONLY EVER MAKES A POSITIVE CLAIM. On the Pending board "a person" is said by the
 * card's BYLINE — their avatar and name (`PrByline`) — and this chip does not render there at all
 * (the byline names automation too). It survives for a surface with no byline, the search card,
 * where nothing names a person, and a chip on every row would be noise and the claim we are least
 * entitled to make. So `authorIsBot !== true` returns null, which covers BOTH "the server said
 * person" and "this surface never said". Neither may paint a bot chip, and neither needs to paint
 * a "human" one.
 *
 * ⚠ AND A KIND WITHOUT THE FLAG IS STILL NULL. The server gates the kind on the flag already;
 * repeating the gate here means a wire regression costs a missing brand, never a vendor chip over
 * a colleague's name.
 */
export function authorSourceLabel(pr: Partial<PrSourceRef>): string | null {
  if (pr.authorIsBot !== true) return null;
  return botKindLabel(pr.authorBotKind ?? null);
}

/** The fields `PrMetaRow` reads. The source pair is OPTIONAL here and REQUIRED on the wire
 *  (`InsightPrRef`), so every board card is compiler-forced to carry it while a non-board caller
 *  can honestly say nothing. See `authorSourceLabel` for what absence renders. */
export type PrMetaFields = Pick<
  InsightPrRef,
  // ⚠ `codeLoc`/`codeLocIsLowerBound` are OPTIONAL on InsightPrRef, so Pick keeps them optional
  // here — a caller that has no measurement (or a payload cached before this feature existed)
  // simply renders no flag, which is the correct answer for "unknown". `blast` rides along on
  // exactly the same terms.
  | 'ciStatus'
  | 'changedFiles'
  | 'additions'
  | 'deletions'
  | 'codeLoc'
  | 'codeLocIsLowerBound'
  | 'blast'
> &
  Partial<PrSourceRef> &
  // The byline's two inputs — OPTIONAL here for the source pair's reason: the search card never had
  // them, and renders no byline.
  Partial<Pick<InsightPrRef, 'automation' | 'authorId'>>;

// ── WHO OPENED IT ─────────────────────────────────────────────────────────────────────────────
//
// On the Pending board a Dependabot bump and a colleague's refactor are the same shape of row and
// want completely different attention, so every PR card names its author: a person by picture and
// name, automation by a chip. The byline reads `automation` — the SAME resolution the People /
// Automation lens filters on (`pendingAuthorSideOf`) — so a card can never sit under "People"
// wearing a bot chip.

/** Vendor kinds that name no product: the chip says what the automation DOES instead. */
const UNBRANDED_KINDS: ReadonlySet<AutomatedReviewerKind> = new Set<AutomatedReviewerKind>([
  'in_house',
  'vendor',
  'pierre',
]);

/** The brand a vendor kind names, or null when it names none. */
function brandOf(kind: AutomatedReviewerKind | null): string | null {
  return kind != null && !UNBRANDED_KINDS.has(kind) ? automatedReviewerMeta(kind).label : null;
}

export interface AuthorByline {
  /** 'person' | 'automation' | 'via' (a tool using a person's account). */
  mode: 'person' | 'automation' | 'via';
  /** The chip text, automation modes only: the vendor's brand when branded, else AUTHOR_ROLE_CHIP. */
  chip: string | null;
  /** The chip's vendor kind (colour via vendorInk), null = neutral. */
  chipKind: AutomatedReviewerKind | null;
  /** The person's (or unbranded bot's) display text; null for a branded bot (the chip says it). */
  name: string | null;
  /** Avatar source user id, or null. */
  avatarUserId: number | null;
}

/**
 * WHAT A CARD'S BYLINE SAYS — pure, so the four cases are pinned by a test.
 *
 *   • a person                 → avatar + name ("Deleted account" when GitHub has no account left)
 *   • branded automation       → the vendor's chip ("Dependabot"), no name — the chip IS the name
 *   • unbranded automation     → what it does ("Coding agent") + its login
 *   • a tool on a person's account ('marker') → the tool, "via", then the person
 *
 * ⚠ `automation` ABSENT OR NULL IS A PERSON, and that is only safe because the wire field is
 * REQUIRED: the server resolves it for every PR card (`authorAutomationFor`), so null is a
 * statement, not a gap. `authorIsBot` is deliberately NOT consulted — it is a claim about the
 * ACCOUNT, and a marker makes a person's account carry automation's work.
 */
export function authorByline(
  pr: { authorId: number | null; automation?: PrAutomation | null },
  usersById: Map<number, User>,
): AuthorByline {
  const user = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  const personName = pr.authorId == null ? 'Deleted account' : userLabel(user, pr.authorId);
  const a = pr.automation ?? null;
  if (a == null) {
    return { mode: 'person', chip: null, chipKind: null, name: personName, avatarUserId: pr.authorId };
  }
  const brand = brandOf(a.kind);
  const chip = brand ?? AUTHOR_ROLE_CHIP[a.role];
  const chipKind = brand != null ? a.kind : null;
  if (a.source === 'marker') {
    return { mode: 'via', chip, chipKind, name: personName, avatarUserId: pr.authorId };
  }
  return {
    mode: 'automation',
    chip,
    chipKind,
    // A branded bot is named by its chip; an unbranded one by its LOGIN — "Coding agent" alone
    // would not say which of a workspace's agents opened this.
    name: brand != null ? null : (user?.githubLogin ?? userLabel(user, pr.authorId)),
    // ⚠ A PICTURE OR NOTHING. With no `avatarUrl` the shared Avatar draws two 10px initials, and
    // beside a chip that already spells the name ("DE" · "Dependabot") they say nothing, below the
    // 11px floor. Measured: every GitHub-typed Bot account in the real DB has a NULL avatar, so this
    // is the common case, not an edge. A person keeps the initials — they are that person's mark.
    avatarUserId: user?.avatarUrl ? pr.authorId : null,
  };
}

/** One drawn piece of a byline. */
export type BylinePart = 'avatar' | 'chip' | 'via' | 'name';

/**
 * THE ORDER A BYLINE DRAWS ITS PIECES — pure, and the ONLY thing `PrByline` draws from, so a field
 * `authorByline` returns can never be one the drawing skips (a branded bot's avatar once was).
 *
 *   person / automation → avatar, chip, name  (each only when present)
 *   via                 → chip, "via", avatar, name — the tool first, then whose account it used
 */
export function bylineParts(b: AuthorByline): BylinePart[] {
  const avatar: BylinePart[] = b.avatarUserId != null ? ['avatar'] : [];
  const chip: BylinePart[] = b.chip != null ? ['chip'] : [];
  const name: BylinePart[] = b.name != null ? ['name'] : [];
  return b.mode === 'via'
    ? [...chip, 'via', ...avatar, ...name]
    : [...avatar, ...chip, ...name];
}

/**
 * THE BYLINE, as drawn. 11px in the meta row's paired greys; a branded chip takes its ink through
 * `vendorInk` (a raw brand hex may not be text). The name is `UserName` wherever there is an
 * account, so the popover and profile link behave as everywhere else.
 */
export function PrByline({
  pr,
  usersById,
  repoId,
}: {
  pr: { authorId: number | null; automation?: PrAutomation | null };
  usersById: Map<number, User>;
  repoId?: number;
}): JSX.Element {
  const b = authorByline(pr, usersById);
  const user = b.avatarUserId != null ? usersById.get(b.avatarUserId) : undefined;
  const meta = b.chipKind != null ? automatedReviewerMeta(b.chipKind) : null;
  const draw = (part: BylinePart): JSX.Element => {
    switch (part) {
      case 'avatar':
        return <Avatar key={part} user={user} size={13} />;
      case 'chip':
        return (
          <span
            key={part}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium${
              meta == null ? ' bg-gray-500/10 text-gray-600 dark:text-gray-300' : ''
            }`}
            style={meta != null ? { ...vendorInk(meta.color), background: `${meta.color}1a` } : undefined}
          >
            <BotIcon size={12} />
            {b.chip}
          </span>
        );
      case 'via':
        return <span key={part}>via</span>;
      case 'name':
        return b.avatarUserId != null ? (
          <UserName key={part} user={user} fallbackId={b.avatarUserId} repoId={repoId} />
        ) : (
          <span key={part}>{b.name}</span>
        );
    }
  };
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
      {bylineParts(b).map(draw)}
    </span>
  );
}

// At-a-glance CI dot + files-changed count + a green/red LOC delta + WHO OPENED IT — mirrors the
// PR-detail size label (ChangesTab / PrDetail). One row, one place, so a new card kind that renders
// it gets the byline without remembering to.
//
// ⚠ THE BYLINE NEEDS BOTH HALVES: the board's `usersById` AND a card carrying `automation`. With
// both, it leads the row and the trailing source chip is NOT drawn — the byline already named the
// bot, and saying it twice on one row is noise. Without them (the search card, a response
// predating the field) the row keeps the positive-claim-only chip.
export function PrMetaRow({
  pr,
  usersById,
}: {
  pr: PrMetaFields;
  usersById?: Map<number, User>;
}): JSX.Element {
  const ci = pr.ciStatus ? CI_META[pr.ciStatus] : null;
  const byline = usersById != null && 'automation' in pr;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
      {byline && (
        <PrByline pr={{ authorId: pr.authorId ?? null, automation: pr.automation }} usersById={usersById} />
      )}
      <span className="inline-flex items-center gap-1" title={ci?.label ?? 'no checks'}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
          aria-hidden
        />
        {ci?.label ?? 'no checks'}
      </span>
      <span>
        {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
      </span>
      <span className="font-mono">
        <span className="text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
        <span className="text-red-500 dark:text-red-400">−{pr.deletions}</span>
      </span>
      {/* A Dependabot bump and a colleague's refactor are the same shape of row and want
          completely different attention, so the SOURCE has to be legible without opening the PR.
          ⚠ Gated on `authorSourceLabel`, the ONE decision — not a second `authorIsBot === true`
          spelled here, which is how a rule and its test drift apart. */}
      {/* The large-PR flag. It sits beside the +/− delta on purpose: those two numbers are the
          WHOLE diff, and this one is the same diff with the docs/config/lockfile/generated churn
          removed — the comparison is the information. Renders nothing at all when the PR is
          under the threshold OR was never measured (see lib/ui.ts's `largePrFlag`). */}
      <LargePrFlag pr={pr} />
      {/* BLAST RADIUS — how far the change can REACH, beside how big it is. The reason the board
          carries it at all: a maintainer must be able to see which cards are a quick eyeball
          WITHOUT opening them, and this row MAY NOT FETCH — the signals ride the card.
          ⚠ NOT `expandable` here: the card is a link to the pull request, and a second
          interactive target inside it competes with that. The reasons are in the title. */}
      <BlastRadiusChip pr={pr} />
      {!byline && authorSourceLabel(pr) != null && (
        <BotVendorPill
          kind={pr.authorBotKind ?? null}
          title={
            pr.authorBotKind != null
              ? 'This pull request was opened by an automated author'
              : 'This pull request was opened by automation whose vendor we don’t recognise'
          }
        />
      )}
    </div>
  );
}

// ── WHERE THE REVIEW STANDS ───────────────────────────────────────────────────────────────────
//
// Two lines under the meta row, and they answer two different questions: WHAT the review adds up
// to, and WHO looked. Both come off the card's own payload — nothing here fetches, ever.

/** The review half of `InsightPrRef`. Every field is OPTIONAL here and REQUIRED on the wire, so a
 *  surface that never had them (the search card, which adapts a loaded PR detail) renders nothing
 *  instead of being forced to invent a zero — `authorSourceLabel`'s rule, five fields on. */
export type PrReviewFields = Partial<
  Pick<
    InsightPrRef,
    'reviewDecision' | 'reviewApprovals' | 'reviewChangesRequested' | 'reviewers' | 'reviewerCount'
  >
>;

/** The standing line: OUR fold, and GitHub's verdict beside it when it says something ours does
 *  not. Two clauses, never one merged chip. */
export interface PendingReviewLead {
  /** Our fold, in as few words as it takes. */
  ours: string;
  /** The standing whose mark + ink draw `ours`, or null for a statement no standing backs. */
  standing: ReviewStanding | null;
  /** GitHub's own `reviewDecision`, NAMED as GitHub's — null when it would only repeat `ours`. */
  github: string | null;
}

/**
 * THE STANDING LINE.
 *
 * ⚠ TWO ANSWERS, CARRIED APART, BECAUSE THEY ARE TWO CLAIMS. `reviewApprovals` /
 * `reviewChangesRequested` are OUR fold over the review rows; `reviewDecision` is GITHUB's verdict
 * about whether review still blocks the merge. They disagree on real data (ours counts an approval
 * GitHub has since dismissed), so merging them into one sentence would pick a winner silently.
 * Ours leads; GitHub's is labelled with GitHub's name and rendered beside it.
 *
 * ⚠ `reviewDecision: null` MEANS "THIS REPO REQUIRES NO REVIEW" AND MAY NEVER READ AS "nobody
 * looked". Who looked is `reviewerCount`, which is where "No reviews yet" comes from — a different
 * field answering a different question, and the two never share a clause.
 *
 * ⚠ CHANGES-REQUESTED AND APPROVALS COEXIST. The block leads, and the approval count SURVIVES:
 * dropping it to make the block louder would be losing a fact to make a point.
 *
 * Returns null where there is genuinely nothing to report — no reviewer, no approval, no block and
 * no requirement. That is ~90% of open non-draft PRs, and a "No reviews · none required" line on
 * ninety percent of the board is precisely the unrequested caveat the product voice bans.
 */
export function pendingReviewLead(pr: PrReviewFields): PendingReviewLead | null {
  const blocked = pr.reviewChangesRequested === true;
  const approvals = pr.reviewApprovals ?? 0;
  const reviewers = pr.reviewerCount ?? 0;
  const decision = pr.reviewDecision ?? null;
  if (!blocked && approvals === 0 && reviewers === 0 && decision == null) return null;

  const approvalWord = `${approvals} approval${approvals === 1 ? '' : 's'}`;
  let ours: string;
  let standing: ReviewStanding | null;
  if (blocked) {
    standing = 'changes_requested';
    ours = approvals > 0 ? `Changes requested · ${approvalWord}` : 'Changes requested';
  } else if (approvals > 0) {
    standing = 'approved';
    ours = approvalWord;
  } else if (reviewers > 0) {
    // Somebody looked and nobody signed off. Off `reviewerCount`, never off `reviewDecision`.
    standing = 'commented';
    ours = 'No approval yet';
  } else {
    standing = null;
    ours = 'No reviews yet';
  }

  let github: string | null = null;
  if (decision === 'review_required') {
    // ALWAYS said. It is the only field that reports review still BLOCKING the merge, and it is
    // most material exactly where it contradicts a healthy-looking count — "2 approvals · GitHub:
    // review required" is a rule (CODEOWNERS, a required reviewer) nobody has satisfied yet.
    github = 'GitHub: review required';
  } else if (decision === 'approved' && approvals === 0) {
    github = 'GitHub: approved';
  } else if (decision === 'changes_requested' && !blocked) {
    github = 'GitHub: changes requested';
  } else if (decision == null && !blocked && approvals === 0) {
    // Said ONLY where our own clause could otherwise be read as a missing obligation. Never beside
    // an approval count, which implies no obligation on its own.
    github = 'GitHub: no review required';
  }
  return { ours, standing, github };
}

/** The bots on a PR, as ONE chip. */
export interface PendingBotReviewers {
  count: number;
  label: string;
  title: string;
  /** The STRONGEST standing among them, so a bot that blocked the PR is not drawn as a comment. */
  standing: ReviewStanding;
}

export interface PendingReviewerChips {
  /** Named individually, in the wire's ranked order. */
  humans: InsightReviewer[];
  /** All of the bots, collapsed. Null when none reviewed. */
  bots: PendingBotReviewers | null;
  /** EVERY reviewer with a standing — the number the server gave us, never one we derived. */
  total: number;
  /** Reviewers this list does not name: past the cap, or with no GitHub account left to name. */
  moreCount: number;
  /** Is every reviewer with a standing named above? The gate for any cap disclosure. */
  complete: boolean;
}

/** changes_requested → approved → commented → dismissed: the wire's own ranking, re-used to pick
 *  the collapsed bot chip's face. */
const STANDING_RANK: Record<ReviewStanding, number> = {
  changes_requested: 0,
  approved: 1,
  commented: 2,
  dismissed: 3,
};

/** What one reviewer DID, as a verb phrase. `dismissed` is re-shaped because the review was
 *  dismissed, not the reviewer. */
function standingPhrase(standing: ReviewStanding): string {
  if (standing === 'approved') return 'approved';
  if (standing === 'changes_requested') return 'requested changes';
  if (standing === 'commented') return 'commented';
  return 'review dismissed';
}

/**
 * THE REVIEWER CHIPS: humans named, bots collapsed into one.
 *
 * ⚠ THE COLLAPSE IS MEASURED, NOT AESTHETIC. 39% of reviewer standings on open PRs are
 * bot-authored and 477 of 478 of those are merely `commented`, so a flat list buries the one human
 * approval under four vendor rows. The bots keep their count and what they did; what they lose is
 * five separate seats on a fifty-row board.
 *
 * ⚠ "+N" IS `reviewerCount - reviewers.length`, AND THE DISCLOSURE GATES ON `complete`. Never
 * subtract your way to a total you were not given: a subtracted figure carries no denominator, so
 * it silently reads 0 the moment the list is filtered for any other reason — the same guard
 * `capFor`'s `shown === count` is.
 */
export function pendingReviewerChips(pr: PrReviewFields): PendingReviewerChips {
  const reviewers = pr.reviewers ?? [];
  const total = pr.reviewerCount ?? reviewers.length;
  const humans = reviewers.filter((r) => !r.isBot);
  const bots = reviewers.filter((r) => r.isBot);
  let chip: PendingBotReviewers | null = null;
  if (bots.length > 0) {
    const standing = bots.reduce<ReviewStanding>(
      (best, r) => (STANDING_RANK[r.standing] < STANDING_RANK[best] ? r.standing : best),
      bots[0]!.standing,
    );
    const uniform = bots.every((r) => r.standing === standing);
    const n = bots.length;
    const plural = n === 1 ? '' : 's';
    chip = {
      count: n,
      label: uniform
        ? standing === 'dismissed'
          ? `${n} bot review${plural} dismissed`
          : `${n} bot${plural} ${standingPhrase(standing)}`
        : // Mixed standings: say the true, shorter thing and put the breakdown in the tooltip.
          `${n} bots reviewed`,
      // ⚠ THE VENDOR NAMES LIVE HERE, not on the chip. `botKindLabel` is the ONE spelling, shared
      // with the author pill, so a bot cannot be called CodeRabbit in one place and Bot in another.
      title: bots.map((r) => `${botKindLabel(r.botKind)} ${standingPhrase(r.standing)}`).join(' · '),
      standing,
    };
  }
  return {
    humans,
    bots: chip,
    total,
    moreCount: Math.max(0, total - reviewers.length),
    complete: reviewers.length === total,
  };
}

/** One named reviewer, wearing their standing's mark and ink. `UserName` — never a second name
 *  renderer — so the popover, the profile link and the maintainer shield behave as everywhere. */
function ReviewerChip({
  reviewer,
  usersById,
}: {
  reviewer: InsightReviewer;
  usersById: Map<number, User>;
}): JSX.Element {
  const meta = REVIEW_STATE_META[reviewer.standing];
  const Mark = meta.icon;
  const u = usersById.get(reviewer.userId);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${meta.cls}`}
      // `standingAt` is the review that SET the standing, NOT the reviewer's latest activity —
      // dating an approval by a later drive-by comment is a false claim about a person.
      title={`${meta.title} · ${relativeTime(reviewer.standingAt)}`}
    >
      {Mark != null && <Mark size={11} />}
      <Avatar user={u} size={13} />
      <UserName user={u} fallbackId={reviewer.userId} />
    </span>
  );
}

/**
 * THE REVIEW ROW — the standing on one line, the reviewers on the next, and NOTHING when the PR
 * has no review situation to report. Mounted on every PR-bearing card so a reader never has to
 * wonder whether a card is silent because nobody reviewed or because this kind doesn't say.
 *
 * ⚠ A standing carries a MARK as well as ink. Colour is never the only channel: the red and the
 * green are the same shape to about one reader in twelve.
 */
function PrReviewRow({
  pr,
  usersById,
}: {
  pr: PrReviewFields;
  usersById: Map<number, User>;
}): JSX.Element | null {
  const lead = pendingReviewLead(pr);
  const chips = pendingReviewerChips(pr);
  const showMore = !chips.complete && chips.moreCount > 0;
  const hasChips = chips.humans.length > 0 || chips.bots != null || showMore;
  if (lead == null && !hasChips) return null;
  const leadMeta = lead?.standing != null ? REVIEW_STATE_META[lead.standing] : null;
  const LeadMark = leadMeta?.icon ?? null;
  return (
    <>
      {lead != null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span
            className={`inline-flex items-center gap-1 font-medium ${
              leadMeta?.ink ?? 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {LeadMark != null && <LeadMark size={11} />}
            {lead.ours}
          </span>
          {lead.github != null && (
            <span
              className="text-gray-500 dark:text-gray-400"
              title="GitHub’s own review decision — what this repository’s rules say about the merge, which is a different question from who has reviewed."
            >
              {lead.github}
            </span>
          )}
        </div>
      )}
      {hasChips && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          {chips.humans.map((r) => (
            <ReviewerChip key={r.userId} reviewer={r} usersById={usersById} />
          ))}
          {chips.bots != null && (
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${
                REVIEW_STATE_META[chips.bots.standing].cls
              }`}
              title={chips.bots.title}
            >
              <BotIcon size={11} />
              {chips.bots.label}
            </span>
          )}
          {showMore && (
            <span
              className="text-gray-500 dark:text-gray-400"
              title={`${chips.total} reviewers have a standing on this pull request. The other ${chips.moreCount} are past the cap, or have no GitHub account left to name.`}
            >
              {/* "+N more" only reads as an overflow when something precedes it. With every
                  reviewer unnameable (deleted accounts — counted, and rightly so) the same number
                  has to stand on its own feet. */}
              {chips.humans.length > 0 || chips.bots != null
                ? `+${chips.moreCount} more`
                : `${chips.moreCount} reviewer${chips.moreCount === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
      )}
    </>
  );
}

// Collapsible PR summary: the plain description (markdown) + the Pro AI summary with its own inline
// Generate/Regenerate action (AiSummary self-gates on the prSummary capability). Lazy: the PR detail
// is fetched only when expanded.
export function InsightPrSummary({ prId }: { prId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronIcon
          dir={open ? 'down' : 'right'}
          size={10}
          className="inline-block align-[-0.1em]"
        />{' '}
        PR summary
      </button>
      {open && <InsightPrSummaryBody prId={prId} />}
    </div>
  );
}

function InsightPrSummaryBody({ prId }: { prId: number }): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  if (isLoading) return <div className="mt-1 text-[11px] text-gray-400">Loading…</div>;
  if (!pr) return <div className="mt-1 text-[11px] text-gray-400">Couldn’t load this PR.</div>;
  const hasBody = pr.body != null && pr.body.trim() !== '';
  return (
    <div className="mt-1 space-y-2 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      {hasBody ? (
        <div className="max-h-64 overflow-auto text-sm">
          <Markdown>{pr.body as string}</Markdown>
        </div>
      ) : (
        <div className="text-[11px] italic text-gray-400">No PR description.</div>
      )}
      <AiSummary pr={pr} />
    </div>
  );
}

// The untouched review thread rendered in full, exactly as the Feed does it — code anchor, every
// reply, and the inline Reply + Resolve controls (ThreadCard). Fetched on demand by thread id.
function InsightThread({ card }: { card: UntouchedThreadCard }): JSX.Element {
  const { data: thread, isLoading } = useThread(card.threadId);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const prUrl = `https://github.com/${card.repoFullName}/pull/${card.prNumber}`;
  if (isLoading) return <div className="px-1 py-2 text-xs text-gray-400">Loading conversation…</div>;
  if (!thread)
    return <div className="px-1 py-2 text-xs text-gray-400">Couldn’t load this conversation.</div>;
  return <ThreadCard thread={thread} usersById={usersById} prUrl={prUrl} repoId={card.repoId} />;
}

// Suggested reviewers + rationale + a single "Assign" button that requests them on the PR
// (server-gated on write access; drops the author + bots). Once requested, ['workspace-insights'] +
// ['attention-cards'] are invalidated → the card leaves the board on the next refresh.
//
// ⚠ EVERY "team" BELOW IS GITHUB'S OWN, not a Limn Workspace: `ReviewerSuggestion.kind === 'team'`
// carries an `@org/team` slug that addresses GitHub's review-request API. The word must NOT be
// renamed here — it is the opposite category to a Workspace, which is our own grouping of repos.
function RoutingReviewers({
  card,
  usersById,
}: {
  card: ReviewerRoutingCard;
  usersById: Map<number, User>;
}): JSX.Element {
  const request = useRequestReviewers(card.prId);
  const suggestions = card.suggestedReviewers;
  const userIds = suggestions
    .filter((s) => s.kind === 'user' && s.userId != null)
    .map((s) => s.userId as number);
  const logins = suggestions
    .filter((s) => s.kind === 'user' && s.userId == null && s.login != null)
    .map((s) => s.login as string);
  const teamSlugs = suggestions
    .filter((s) => s.kind === 'team' && s.teamSlug != null)
    .map((s) => s.teamSlug as string);
  const done = request.isSuccess;
  const keyOf = (s: (typeof suggestions)[number]): string =>
    s.kind === 'team' ? `team:${s.teamSlug}` : `user:${s.login ?? s.userId}`;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="font-medium">Suggested reviewers</span>
        <button
          type="button"
          onClick={() => request.mutate({ userIds, logins, teamSlugs })}
          disabled={request.isPending || done || suggestions.length === 0}
          className="rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/20"
          title="Request these reviewers on GitHub"
        >
          {done ? (
            <>
              <CheckIcon size={11} className="inline-block align-[-0.1em]" /> Requested
            </>
          ) : request.isPending ? (
            'Assigning…'
          ) : (
            `Assign${suggestions.length > 1 ? ' all' : ''}`
          )}
        </button>
      </div>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={keyOf(s)} className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
            {s.kind === 'team' ? (
              <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium">
                @{s.teamName}
              </span>
            ) : s.userId != null ? (
              <UserChip id={s.userId} usersById={usersById} />
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
                @{s.login}
              </span>
            )}
            <span className="text-gray-400">{s.reason}</span>
          </li>
        ))}
      </ul>
      {request.isError && (
        <div className="text-[11px] text-red-500">
          {(request.error as Error)?.message ?? 'Couldn’t request reviewers.'}
        </div>
      )}
    </div>
  );
}

// The actions row of a my_turn card: the 'your_pr' hint (the one section whose clearing rule is not
// "act on the PR"), then Dismiss.
//
// ⚠ DISMISS IS NOT THE "Done" BUTTON THAT USED TO LIVE HERE. That one stored an acknowledgement
// that never expired, so it hid work that had come back. This one sets the entry down only until
// something newer happens on it, and the server drops the dismissal once the PR leaves your plate
// (db/my-turn-dismissals.ts). Acting on the PR is still what clears a card; Dismiss is for the one
// you cannot act on now — or ever. It is keyed on the SUBJECT (the PR, or a red branch's repo),
// never the card: the board lists one card per PR, and dismissing it must not surface the next.
//
// The 'your_pr' copy promises "as soon as you come back", not "on the next refresh", because
// `markViewed.onSuccess` invalidates ['attention-cards'] + ['daily-brief'] at the prefix — the
// board is already refetching while the user is still in the PR. If that invalidation is ever
// dropped, this sentence becomes a lie with a 60s staleTime behind it.
function MyTurnActions({ card }: { card: MyTurnCard | MyTurnTrunkCard }): JSX.Element {
  const target: MyTurnDismissTarget =
    card.reason === 'trunk_red' ? { kind: 'repo', id: card.repoId } : { kind: 'pr', id: card.prId };
  const label =
    card.reason === 'trunk_red' ? card.repoFullName : `${card.repoFullName} #${card.prNumber}`;
  const dismiss = useDismissMyTurn(target, label);
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-2">
      {card.reason === 'your_pr' && (
        <span className="text-[11px] italic text-gray-500 dark:text-gray-400">
          Opening the PR marks it seen — this card clears as soon as you come back.
        </span>
      )}
      <button
        type="button"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        title="Take this off My turn until something new happens on it"
        className="ml-auto rounded px-1.5 py-0.5 text-[12px] text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-60 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      >
        {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
      </button>
      {dismiss.isError && (
        <span className="text-[12px] text-red-600 dark:text-red-400">Couldn’t dismiss it.</span>
      )}
    </div>
  );
}

/** What the board's merge row offers for one FORWARD card, decided WITHOUT a network call. */
export interface PendingMergeGate {
  /** Does the row render at all? False HIDES it — never disables it (the ChecksTab rule: an
   *  affordance you may not use is noise, not information). */
  show: boolean;
  /** The primary control's verb, or null when the card's own fields say nothing can be offered
   *  (conflicts, or a state GitHub hasn't computed yet). Arming may still be worth a look. */
  action: 'merge' | 'update_branch' | null;
  /** The ONE verdict, run over the card's synced fields — the copy behind an absent button. */
  verdict: MergeVerdictInfo;
  /**
   * Does the row say the verdict when it offers no button? True on the two forward kinds, where
   * this row is the card's only statement of its merge state. FALSE on a Dependencies card: its
   * state row ("Blocked · Required checks or reviews aren’t satisfied") already says it, and the
   * verdict line under it printed the same state a second time — once the same sentence twice.
   */
  verdictLine: boolean;
  /**
   * GitHub'S MERGE QUEUE HOLDS THIS PR RIGHT NOW — a POSITIVE observation only (`inMergeQueue`
   * null is "not observed" and false is GitHub's "no"; neither claims the queue).
   *
   * While it is true, GitHub owns the landing: Merge and Merge-when-ready are HIDDEN (pressing
   * either is meaningless, and a direct merge on a queued branch is a 405), and the row keeps the
   * one thing still worth doing — taking it back out. The verdict line is suppressed too, because
   * the header's queue chip already says it, in better words.
   */
  queued: boolean;
}

/**
 * THE BOARD'S MERGE GATE — pure, and deliberately fed only the card's OWN synced fields.
 *
 * ⚠ IT MAY NEVER BECOME A FETCH. `MergeWhenReadyControl` asks GitHub for live merge-options
 * (~3 calls per PR) because PrDetail shows ONE pull request; this board shows up to fifty, and
 * fifty rows resolving their buttons on mount is ~150 GitHub calls to PAINT A SCREEN. So the
 * board decides what to OFFER from `mergeStateStatus` / `mergeable` / `viewerCanPush`, which
 * every card already carries, and only a CLICK buys the live answer.
 *
 * ⚠ AND IT GOES THROUGH `mergeVerdict`, not a second reading of the same enum. `unstable` IS
 * mergeable (only non-required checks are red) and `behind` is NOT (GitHub 405s the merge) —
 * two rules that are counter-intuitive in opposite directions, which is exactly why exactly one
 * resolver in this codebase is allowed to know them.
 *
 * `autoMergeArmed` is deliberately NOT passed, for MergeControl's reason: an 'armed' verdict
 * reports `canMerge: true`, which would enable a Merge button on a still-blocked PR. An armed
 * intent gets its own row instead. `behindBy` and `isDraft` are absent from the card by
 * construction (the server's fold is non-draft only), and `mergeVerdict` degrades honestly
 * without them — "update the branch first" simply loses its commit count.
 */
export function pendingMergeGate(
  card: MergeReadyCard | UpdateBranchCard | SecurityCard | DependencyBumpCard,
): PendingMergeGate {
  // ⚠ ONLY A POSITIVE OBSERVATION REACHES THE VERDICT. `inMergeQueue` is three-state and
  // `MergeVerdictInput.inMergeQueue` is two — `null` ("we never looked") and `false` ("GitHub says
  // no") both mean *do not claim the queue owns this*, which is exactly what `false` means there.
  const queued = card.inMergeQueue === true;
  const verdict = mergeVerdict({
    // ⚠ null is NOT OBSERVED, never "not conflicting" — the three-state rule. 'unknown' is what
    // `mergeVerdict` calls that, and it is the honest input.
    mergeable: card.mergeable ?? 'unknown',
    // The Dependencies cards carry the state NULLABLE (not observed); the forward kinds never
    // null it, because a state is what mints them. Same honest input as `mergeable` above.
    mergeStateStatus: card.mergeStateStatus ?? 'unknown',
    // ⚠ THE QUEUE IS WHY THIS FIELD RIDES THE CARD. GitHub's MergeStateStatus enum has no QUEUED
    // member, so a queued PR reports `blocked` — and a board reading the status alone would offer
    // a Merge button GitHub refuses. `mergeVerdict`'s queue branch runs FIRST, which is what makes
    // `canMerge` false and, through it, drops `action` to null on BOTH kinds below.
    inMergeQueue: queued,
  });
  // HIDDEN, not disabled. `viewerCanPush` is the synced `repos.viewerPermission` and a VISIBILITY
  // gate only; every route re-checks permission, the head oid and the live merge state before
  // anything irreversible happens.
  // A Dependencies card states its merge state in its own state row, so this row never repeats it.
  const dependencies = card.kind === 'security' || card.kind === 'dependency_bump';
  const verdictLine = !dependencies;
  if (!card.viewerCanPush) return { show: false, action: null, verdict, verdictLine, queued };
  // A person's PR a security tool flagged carries NO merge row: it keeps its own cards elsewhere on
  // the board, and those carry whatever landing it has. This card is about the advisory.
  if (card.kind === 'security' && !card.dependencyUpdate) {
    return { show: false, action: null, verdict, verdictLine, queued };
  }
  // A DEPENDENCIES card is minted by who opened the PR, not by its merge state, so the verb comes
  // from the verdict alone: behind → update the branch, mergeable → merge, anything else → nothing.
  if (dependencies) {
    const action =
      verdict.verdict === 'behind' ? 'update_branch' : verdict.canMerge ? 'merge' : null;
    return { show: true, action, verdict, verdictLine, queued };
  }
  const action =
    card.kind === 'update_branch'
      ? // The whole point of this card is that GitHub is REFUSING the merge until the branch is
        // updated, so the verb is "Update branch", never "Merge". A behind PR that ALSO conflicts
        // resolves to the 'conflicts' verdict and gets no button — updating it cannot help.
        verdict.verdict === 'behind'
        ? 'update_branch'
        : null
      : verdict.canMerge
        ? 'merge'
        : null;
  return { show: true, action, verdict, verdictLine, queued };
}

/**
 * MERGE ACTIONS ON A PENDING CARD — the two FORWARD kinds and a dependency update, because those
 * are exactly the rows where the thing to do is "land it" — and your own ready PR moved into My
 * turn (`own_ready`, through `asForwardCard`), which is the same row in another tab. A `my_turn`
 * "review this" card gets no Merge button; reviewing is not merging.
 *
 * ⚠ NOTHING HERE FETCHES ON MOUNT.
 *   • `usePrArmedIntent` is a SELECTOR over the account-wide armed list the app already polls —
 *     one query for the whole board, not one per card.
 *   • `MergeControl` is collapsed and its `useMergeOptions(prId, open)` is disabled until the
 *     reader opens it.
 *   • `MergeWhenReadyControl` is mounted with `eager={false}`, which is what that prop exists
 *     for: the armed chip + Cancel stay free, and the GitHub call waits for a click. (Its query
 *     key is shared with MergeControl's, so opening either warms the other for nothing.)
 *
 * Arming and cancelling stay in `MergeWhenReadyControl` — the ONE path that arms — rather than
 * being re-spelled compactly here.
 */
function PendingMergeActions({
  card,
}: {
  card: MergeReadyCard | UpdateBranchCard | SecurityCard | DependencyBumpCard;
}): JSX.Element | null {
  const gate = pendingMergeGate(card);
  const armed = usePrArmedIntent(card.prId);
  // …and the one the watcher gave up on. Both are selectors over the SAME account-wide poll the
  // banner already keeps warm, so this costs the board nothing — the fetch-on-mount rule holds.
  const stopped = usePrStoppedIntent(card.prId);
  // ── "MID-MERGE" — WHERE THIS PR STANDS RIGHT NOW, IN THREE LAYERS ────────────────────────────
  //
  // The board used to say nothing at all between "Merge" and the card disappearing, which is the
  // gap the request names ("if the PR is mid-merge, this should be indicated"). Three distinct
  // things can be true, and they are checked most-immediate first:
  //
  //  1. A MANUAL merge or branch update the reader started, still in flight. Read off the SHARED
  //     mutation key (`useIsMutating`) rather than a local `isPending`, because the mutation is
  //     owned by `MergeControl` inside this row and PrDetail can mount a second `useMergePr` for
  //     the same PR — a per-mount flag is invisible to the other mount, which is the
  //     CiAnalysisCard lesson. Zero requests: `useIsMutating` reads the client's own mutation
  //     cache.
  //  2. An ARMED auto-merge intent, whose live phase is `armedPhaseHeadline` — THE one spelling,
  //     shared with the global AutoMergeBanner so two surfaces cannot describe one intent two
  //     ways. It covers all thirteen `ArmedMergePhase` members: pending_first_check /
  //     waiting_conflicts / waiting_behind / updating_rebase / updating_merge / awaiting_checks /
  //     awaiting_review / blocked_protection / enqueuing / queued (GitHub's merge queue) /
  //     queued_local (⚠ Limn's OWN per-repo hold — a different queue, refined with "N of M on
  //     this repo") / merging / retrying, plus a truthful "Waiting…" for a phase the watcher
  //     could not characterise. Also zero requests: a selector over the armed list the app
  //     already polls.
  //  3. Neither — the synced merge verdict, as before.
  //
  // ⚠ STILL NOTHING FETCHES ON MOUNT. Both reads are cache reads. GitHub's native merge-queue
  // MEMBERSHIP and entry state now ride the card itself (`inMergeQueue` / `mergeQueueEntryState`,
  // drawn by `pendingQueueBadge` in the header and read by the gate below); its POSITION still
  // does not, because it is volatile and unsynced and the only route to it is the click-gated
  // merge-options call — fifty cards making that call is the ~200-upstream-calls-to-paint-a-board
  // failure this row is built to avoid.
  const merging = useIsMutating({ mutationKey: mergePrMutationKey(card.prId) }) > 0;
  const updating = useIsMutating({ mutationKey: updateBranchMutationKey(card.prId) }) > 0;
  const inFlight = merging ? 'Merging…' : updating ? 'Updating the branch…' : null;
  if (!gate.show) return null;
  return (
    // ⚠ `data-noactivate` ON THE WHOLE ROW. `CardShell.onActivate` opens the PR unless the click
    // landed inside a/button/textarea/input/[data-noactivate] — a `<select>` (the merge-method
    // picker) is in none of those, so without this, choosing "Squash and merge" would navigate
    // away mid-choice.
    <div className="mt-2 flex flex-wrap items-center gap-2" data-noactivate>
      {inFlight != null ? (
        // A write the reader started, still open. It OUTRANKS the armed headline: an armed intent
        // describes what will happen later, a live POST describes what is happening now, and the
        // card must not read "Waiting for the first check" while the merge call is in flight.
        // Not a spinner — the row already has no other motion and the sentence is the signal.
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{inFlight}</span>
      ) : armed != null ? (
        // ONE SPELLING of where a live intent stands, shared with the AutoMergeBanner stack. The
        // repo is not named because `PrLine` above already prints `owner/name #number`.
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {armedPhaseHeadline(armed)}
        </span>
      ) : stopped != null ? (
        // AN INTENT THE WATCHER GAVE UP ON. Ranked BELOW a live intent and a live write (both
        // describe now; this describes something that already finished) and ABOVE the merge
        // verdict, because "your auto-merge stopped" is the more specific answer to why this row
        // is still here. Before this the card just lost its armed line and said nothing at all —
        // the reported "disarmed for unknown reasons". It clears itself: the server drops the
        // row after 24h, and a re-arm replaces it with the live headline above.
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          <WarningIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
          {TERMINAL_LABEL[stopped.state] ?? 'Auto-merge stopped'}
          {stopped.lastReason != null && <span className="ml-1">— {stopped.lastReason}</span>}
        </span>
      ) : gate.queued ? (
        // NOTHING. The queue chip in the header row already said it — and said it better, with
        // the entry's own state. A second "in merge queue" on the row below is the same fact
        // twice, on the one board where every line has to earn its width.
        null
      ) : gate.action == null && gate.verdictLine ? (
        // No button, but never a silent row: the verdict IS the answer to "why can't I merge
        // this?", and it is the same sentence PrDetail leads its merge panel with. (A Dependencies
        // card's state row has already said it — `verdictLine` is false there.)
        <span className={`text-[11px] font-medium ${MERGE_TONE_CLASS[gate.verdict.tone]}`}>
          {gate.verdict.label}
          {gate.verdict.detail != null && (
            <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
              — {gate.verdict.detail}
            </span>
          )}
        </span>
      ) : null}
      {/* Collapsed = zero requests. Expanding buys the live merge state ONCE and unlocks the real
          method picker, so the board can never promise a merge method the repo forbids.

          ⚠ A QUEUED CARD STILL MOUNTS IT, UNDER A DIFFERENT VERB. `gate.action` is null while the
          queue holds the PR — Merge and Update branch are both meaningless there — but this panel
          is ALSO the only way to `Remove from queue`, and taking it away would leave a reader who
          queued a PR by mistake with nothing to press. The trigger says "Merge queue", not
          "Merge", so the verb never promises something GitHub would 405. */}
      {armed == null && (gate.action != null || gate.queued) && (
        <MergeControl
          prId={card.prId}
          githubUrl={card.githubUrl}
          label={
            gate.queued ? 'Merge queue' : gate.action === 'update_branch' ? 'Update branch' : 'Merge'
          }
        />
      )}
      {/* ⚠ HIDDEN WHILE QUEUED, AND ONLY THEN — except when something is already armed, because
          cancelling must always be possible. "Merge when ready" arms a watcher to land the PR
          once its blockers clear; while GitHub's queue owns the landing there is nothing for that
          watcher to wait out, so the button would arm a race. An ARMED intent renders its own
          chip and its Cancel (or Cancel & dequeue) from this same component. */}
      {(!gate.queued || armed != null) && <MergeWhenReadyControl prId={card.prId} eager={false} />}
    </div>
  );
}

/**
 * WHAT A CONFLICTS CARD MAY OFFER: resolving them, and cancelling an armed intent. Never a merge.
 *
 * ⚠ STILL NO MERGE AFFORDANCE, AND THAT IS STILL THE POINT. `mergeVerdict` returns
 * `canMerge: false` for both mint predicates, GitHub 405s a merge on a conflicting branch, and
 * "Update branch" cannot resolve a conflict — `pendingMergeGate` above already refuses to offer it
 * on an `update_branch` card whose `mergeable === 'conflicting'`.
 *
 * ⚠ WHAT CHANGED IS THAT RESOLVING IS NOW SOMETHING THIS APP DOES. The old sentence here —
 * "resolving conflicts is a git operation this app does not perform, and GitHub offers no button
 * for it either, so the card names the fact and stops" — was true until the in-app resolver landed.
 * `ResolveConflictsButton` is the one entry into it, and it is HIDDEN rather than disabled wherever
 * it cannot work (cloud, no write access, a PR that is no longer open).
 *
 * ⚠ NOTHING HERE FETCHES ON MOUNT, AND THE BUTTON DOES NOT CHANGE THAT. Its gate is four synced
 * facts plus the App-root `['me']` cache — see `conflictResolverEntryVisible`; the clone happens on
 * the CLICK. `usePrArmedIntent` is a SELECTOR over the account-wide armed list the app already
 * polls — one query for the whole board. `MergeWhenReadyControl` is mounted ONLY when an intent is
 * already armed AND with `eager={false}`, which leaves its
 * `useMergeOptions(prId, eager || draft !== 'idle')` disabled: zero requests, and the reader keeps
 * the Cancel for an intent parked at `waiting_conflicts` that will sit there until it expires. It is
 * NEVER mounted un-armed — that would offer to arm a watcher whose blocker only a human can clear.
 */
function PendingConflictActions({
  card,
}: {
  card: ConflictsCard | SecurityCard | DependencyBumpCard;
}): JSX.Element | null {
  const armed = usePrArmedIntent(card.prId);
  // ⚠ THE `armed == null` EARLY RETURN IS GONE. It used to be right — with nothing armed there was
  // nothing to press — and it is exactly the shape of defect that leaves a feature built, gated and
  // unreachable: the resolver button would have been mounted on a row that returns null for the
  // overwhelming majority of cards.
  //
  // HIDE, never disable. ⚠ A `conflicts` card has no `viewerCanPush` field: the kind is MINTED only
  // for repos the viewer can push to (`writableRepoIds`), so the flag would be a constant `true` on
  // the wire — see ConflictsCard's contract in packages/shared. That is why it is a literal for that
  // kind, and why it must NOT become a new field on the card. A Dependencies card in the
  // `conflicts` state is NOT write-gated (it is minted by who opened the PR), so it carries — and
  // this reads — its own.
  //
  // The row asks the SAME resolver the button asks, so it can drop out entirely rather than
  // render an empty strip of padding under every conflicts card in cloud (where the resolver's
  // routes do not exist) with nothing armed. One rule, one answer.
  const viewerCanPush = card.kind === 'conflicts' ? true : card.viewerCanPush;
  const canResolve = useConflictResolverEntry({
    state: 'open',
    verdict: 'conflicts',
    viewerCanPush,
  });
  if (!canResolve && armed == null) return null;
  return (
    // `data-noactivate` for the same reason PendingMergeActions carries it: CardShell.onActivate
    // opens the PR unless the click landed in a/button/textarea/input/[data-noactivate].
    <div className="mt-2 flex flex-wrap items-center gap-2" data-noactivate>
      <ResolveConflictsButton
        // A card only ever describes an OPEN pull request, and its kind is minted from the same
        // two columns `mergeVerdict` reads — so the verdict is a literal here rather than a second
        // reading of the enum. `pendingMergeGate` states the same rule for the forward kinds.
        state="open"
        verdict="conflicts"
        viewerCanPush={viewerCanPush}
        target={{
          prId: card.prId,
          repoId: card.repoId,
          repoFullName: card.repoFullName,
          prNumber: card.prNumber,
          prTitle: card.prTitle,
          githubUrl: card.githubUrl,
        }}
      />
      {armed != null && (
        <>
          {/* ONE SPELLING of where a live intent stands, shared with the AutoMergeBanner stack. */}
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {armedPhaseHeadline(armed)}
          </span>
          <MergeWhenReadyControl prId={card.prId} eager={false} />
        </>
      )}
    </div>
  );
}

/**
 * WHAT A DEPENDENCIES CARD MAY OFFER — the landing actions of the PR it names, and nothing for a
 * person's PR a security tool flagged (that PR keeps its own cards, which carry its landing).
 *
 * ⚠ ONE CARD PER PR IS WHY THIS EXISTS. A dependency-automation PR is listed ONLY in the
 * Dependencies tab, so its one card has to carry whatever the Ready to land / Needs fixing cards
 * would have: Merge, Update branch, Merge when ready, or the conflict resolver. It reuses those
 * rows rather than re-spelling them, so it inherits their rule: NOTHING FETCHES ON MOUNT.
 */
function DependencyActions({ card }: { card: SecurityCard | DependencyBumpCard }): JSX.Element | null {
  if (card.kind === 'security' && !card.dependencyUpdate) return null;
  if (card.depState === 'conflicts') return <PendingConflictActions card={card} />;
  return <PendingMergeActions card={card} />;
}

/** The three facts an advisory chip needs, decided off the card alone. */
export interface AdvisoryChip {
  id: string;
  /** The public page, already through `safeExternalUrl`; undefined for a scheme with none. */
  href: string | undefined;
}

/** A piece of a sentence: plain words, or an advisory id drawn as its chip. */
export type AdvisoryPart = { text: string } | AdvisoryChip;

/** A character an advisory id can continue with — so `CVE-2026-1` never matches inside
 *  `CVE-2026-12`. A '.' is not one: a sentence may end on an id. */
const ADVISORY_ID_CHAR = /[A-Za-z0-9_-]/;
const idBoundary = (ch: string | undefined): boolean => ch == null || !ADVISORY_ID_CHAR.test(ch);

/**
 * A SENTENCE WITH ITS ADVISORY IDS AS LINKS: "Fixes GHSA-…" becomes the word "Fixes" and the linked
 * id. Only the card's OWN ids are matched (`advisoryIds`, the full list), longest first, whole ids
 * only. This is how a card writes each id ONCE — in the sentence that says what it is, linked there —
 * instead of once in the sentence and again in a chip under it.
 */
export function advisoryParts(text: string, ids: readonly string[]): AdvisoryPart[] {
  const longestFirst = [...ids].sort((a, b) => b.length - a.length);
  const parts: AdvisoryPart[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const id = idBoundary(text[i - 1])
      ? longestFirst.find((x) => text.startsWith(x, i) && idBoundary(text[i + x.length]))
      : undefined;
    if (id == null) {
      plain += text[i];
      i += 1;
      continue;
    }
    if (plain !== '') parts.push({ text: plain });
    plain = '';
    parts.push({ id, href: safeExternalUrl(advisoryUrl(id)) });
    i += id.length;
  }
  if (plain !== '') parts.push({ text: plain });
  return parts;
}

/**
 * THE ADVISORY CHIPS on a security card: the ids no sentence on the card already names (`named`),
 * the first three of them, each linked where its scheme has a public page, and how many more there
 * are. "+N more" counts the rest of that list — `advisoryIds` is complete up to the server's 50-id
 * safety cap, so the count is a real denominator.
 */
export function advisoryChips(
  ids: readonly string[],
  named: ReadonlySet<string> = new Set(),
): { chips: AdvisoryChip[]; more: number } {
  const rest = ids.filter((id) => !named.has(id));
  const shown = rest.slice(0, 3);
  return {
    chips: shown.map((id) => ({ id, href: safeExternalUrl(advisoryUrl(id)) })),
    more: rest.length - shown.length,
  };
}

/**
 * ONE LIVE ALERT, as the card says it: `lead` "Socket flagged GHSA-… and 2 more", then `where`
 * ("in a review thread", or null). Two halves because a thread alert's `where` is the button that
 * opens the thread, while the ids in `lead` are links — a link may not sit inside a button. A
 * reviewer alert is named by its author's brand, else its login — "a reviewer flagged…" names nobody.
 */
export function securityAlertLine(
  alert: SecurityAlert,
  usersById: Map<number, User>,
): { lead: string; where: string | null } {
  const source =
    alert.source === 'reviewer'
      ? (brandOf(alert.vendorKind) ??
        usersById.get(alert.authorId)?.githubLogin ??
        userLabel(undefined, alert.authorId))
      : SECURITY_ALERT_SOURCE_LABEL[alert.source];
  const [first, ...rest] = alert.advisoryIds;
  const what =
    first == null ? 'a known advisory' : rest.length > 0 ? `${first} and ${rest.length} more` : first;
  return { lead: `${source} flagged ${what}`, where: alert.surface === 'thread' ? 'in a review thread' : null };
}

/** The security half of a `security` card: the fix sentence, the advisory chips, the live alerts. */
function SecurityDetail({
  card,
  usersById,
  onOpenThread,
}: {
  card: SecurityCard;
  usersById: Map<number, User>;
  onOpenThread: (threadId: number) => void;
}): JSX.Element {
  // Amber only for Dependabot's inferred fix with nothing else behind it — the card's own colour.
  const inferredOnly = card.fix === 'inferred' && card.alertCount === 0;
  const tint = inferredOnly
    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
    : 'bg-red-500/10 text-red-700 dark:text-red-300';
  const mark = inferredOnly ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const ids = card.advisoryIds;
  const fixParts = card.detail !== '' ? advisoryParts(card.detail, ids) : [];
  const alertLines = card.alerts.map((alert) => {
    const line = securityAlertLine(alert, usersById);
    return { alert, where: line.where, parts: advisoryParts(line.lead, ids) };
  });
  // ⚠ EACH ID ONCE. An id a sentence names is linked THERE; the chip row carries only the rest, so
  // "Fixes GHSA-…" is never followed by a "GHSA-…" chip saying it again.
  const named = new Set(
    [...fixParts, ...alertLines.flatMap((l) => l.parts)].flatMap((p) => ('id' in p ? [p.id] : [])),
  );
  const { chips, more } = advisoryChips(ids, named);
  const moreAlerts = card.alertCount - card.alerts.length;
  const chip = (c: AdvisoryChip, key: string): JSX.Element =>
    c.href != null ? (
      <a
        key={key}
        href={c.href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[11px] hover:underline ${tint}`}
        title="Open the advisory"
      >
        {c.id}
        <ExternalLinkIcon size={10} />
      </a>
    ) : (
      <span key={key} className={`rounded px-1.5 py-px font-mono text-[11px] ${tint}`}>
        {c.id}
      </span>
    );
  const words = (parts: AdvisoryPart[]): JSX.Element[] =>
    parts.map((p, i) => ('id' in p ? chip(p, `${i}`) : <span key={i}>{p.text}</span>));
  return (
    <div className="mt-1.5 space-y-1 text-[12px] text-gray-600 dark:text-gray-300">
      {fixParts.length > 0 && (
        <p className="flex items-start gap-1.5">
          <ShieldIcon size={12} className={`mt-0.5 shrink-0 ${mark}`} />
          <span className="min-w-0">{words(fixParts)}</span>
        </p>
      )}
      {alertLines.map(({ alert, where, parts }, i) => (
        <p key={`${alert.source}:${alert.at}:${i}`} className="flex items-start gap-1.5">
          <ShieldIcon size={12} className={`mt-0.5 shrink-0 ${mark}`} />
          <span className="min-w-0">
            {words(parts)}
            {where != null &&
              (alert.threadId != null ? (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => onOpenThread(alert.threadId as number)}
                    className="text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    title="Open this review thread"
                  >
                    {where}
                  </button>
                </>
              ) : (
                ` ${where}`
              ))}
          </span>
        </p>
      ))}
      {(chips.length > 0 || more > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[18px] text-[11px]">
          {chips.map((c) => chip(c, c.id))}
          {more > 0 && <span className="text-gray-500 dark:text-gray-400">+{more} more</span>}
        </div>
      )}
      {moreAlerts > 0 && (
        <p className="pl-[18px] text-gray-500 dark:text-gray-400">
          +{moreAlerts} more {moreAlerts === 1 ? 'alert' : 'alerts'}
        </p>
      )}
    </div>
  );
}

function CardShell({
  card,
  right,
  openedAt,
  clockAt,
  onActivate,
  children,
  innerRef,
  flash = false,
  why,
}: {
  card: InsightCard;
  right?: React.ReactNode;
  /**
   * THE PR'S OWN AGE, appended to `right` as "opened 3d". OPT-IN, one line per kind, and the two
   * omissions are decisions:
   *   • `stalled_review` already says "waiting 4d", and its server `ageHours` is computed from
   *     `pull_requests.opened_at` — the SAME number. Passing this would print one figure twice
   *     under two names.
   *   • `untouched_thread` says "6h old" about the THREAD, which is the subject of that card.
   * Derived, not passed pre-formatted, so the null degradation and the tooltip live in one place.
   */
  openedAt?: string | null;
  /**
   * THE INSTANT `right` MEASURES, when `right` is a clock — a my_turn card's `since`, a forward
   * card's `lastCommitAt`. Passed so this shell can drop `right` on the rows where it and the age
   * are THE SAME NUMBER; see `clockSaysMore` for the measurement and the argument.
   *
   * Omit it when `right` is not a clock (`reviewer_routing`'s "unassigned") — then `right` always
   * renders and the age is simply appended.
   */
  clockAt?: string | null;
  onActivate?: () => void;
  children: React.ReactNode;
  innerRef?: (el: HTMLLIElement | null) => void;
  flash?: boolean;
  /**
   * ONE SENTENCE OF MODEL PROSE about why this row is worth doing now (Pro `workPlan`), or
   * undefined on every free account and every un-narrated row.
   *
   * ⚠ THE LABELLED-APART RULE. A model-derived line and a code-derived figure may never share a
   * line. Everything in `children` — chips, counts, `detail` — is DATA in neutral ink and renders
   * whether or not anything was ever generated; this gets its own line, its own palette
   * (`--ai-*`), its own type style and a SparkleIcon. The board is fully usable with every one of
   * these absent, which is what makes the narration safe to sell separately.
   */
  why?: string;
}): JSX.Element {
  const sev = SEV[card.severity];
  const personal = pendingCardIsPersonal(card);
  // The Pro plan's line for this card, wherever the card sits — read from the board once rather
  // than threaded through every kind's case (which is how most kinds ended up never showing it).
  const board = useContext(PendingBoardContext);
  const whyLine = why ?? board?.whyById?.get(card.id);
  // ⚠ PURE, AND OFF THE CARD'S OWN FIELDS. A `ci_failing` card does not extend `InsightPrRef` at
  // all — its subject can be a repo's TRUNK, which is not a pull request and must never be
  // described as one — and neither does `reviewer_load`. The `in` test is what keeps this a
  // compiler-checked narrowing rather than a cast that would let one through.
  const queue = 'inMergeQueue' in card ? pendingQueueBadge(card) : null;
  // "opened 3d", or null when this kind has no single open PR to date (ci_failing's trunk arm,
  // reviewer_load) or the value is unreadable. See `openedAgeLabel`.
  const age = openedAgeLabel(openedAt);
  // ⚠ A CLOCK THAT AGREES WITH THE AGE IS THE AGE, SAID WORSE. When the caller named the instant
  // `right` measures and it rounds to the same label as `openedAt`, the bare relative time is
  // dropped and the NAMED age stands alone. `clockAt` absent ⇒ `right` is not a clock and always
  // renders. See `clockSaysMore`.
  const showRight = age == null || clockAt === undefined || clockSaysMore(clockAt, openedAt);
  const onClick = onActivate
    ? (e: React.MouseEvent): void => {
        if ((e.target as HTMLElement).closest('a,button,textarea,input,[data-noactivate]')) return;
        onActivate();
      }
    : undefined;
  return (
    <li
      ref={innerRef}
      onClick={onClick}
      className={`rounded-lg border border-l-4 border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40 ${sev.border}${
        flash ? ' ring-2 ring-sky-400/70' : ''
      }${onActivate ? ' cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-900/60' : ''}`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${sev.dot}`} aria-hidden />
        {/* ⚠ THE OWNERSHIP CLAIM, IN WORDS AND IN WEIGHT. `cardKindLabel` writes "Your turn" /
            "In your repos" / the neutral kind; `pendingCardIsPersonal` decides whether the row is
            drawn to outrank its neighbours. ONE resolver behind both, so a heavy label and a
            neutral word can never end up on the same card. */}
        <span
          className={`uppercase tracking-wide ${
            personal
              ? 'font-bold text-gray-700 dark:text-gray-200'
              : 'font-semibold text-gray-500 dark:text-gray-400'
          }`}
        >
          {cardKindLabel(card)}
        </span>
        {/* GitHub's merge queue — IDENTITY, not an action, which is why it sits here and not in
            the merge row: that row is hidden outright for a reader without push access, and "it is
            already landing" is if anything MORE useful to someone who has no button either way. */}
        {queue != null && (
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium normal-case tracking-normal ${
              queue.tone === 'bad'
                ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                : 'bg-gray-500/10 text-gray-600 dark:text-gray-300'
            }`}
            title={queue.title}
          >
            {queue.tone === 'bad' ? <WarningIcon size={11} /> : <MergeIcon size={11} />}
            {queue.label}
          </span>
        )}
        {/* ⚠ EXPLANATION, NOT ARITHMETIC. `muted` says WHY this card carries the neutral label
            instead of "Your turn" — the reader muted this repo (or its workspace) in Settings, and
            a card that silently demoted itself is a smaller version of the "where did my work go"
            failure the filtered empty state exists to prevent. Nothing counts it: every figure on
            this board is folded from `relevance`, which has already absorbed the mute. */}
        {card.kind === 'my_turn' && card.muted === true && (
          <span
            className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium normal-case tracking-normal text-gray-500 dark:text-gray-400"
            title="Pending items from this repository are muted — they still appear here, but they don’t claim your turn and don’t notify you. Change it in Settings → Workspace."
          >
            muted
          </span>
        )}
        {/* THE RIGHT-HAND META. `right` is the kind's OWN clock or status; the PR's age is
            APPENDED after it, never in place of it. The separator lives HERE, not at the call
            sites, so a kind that opts in cannot forget it and cannot double it. */}
        <span className="ml-auto flex items-baseline gap-1.5 text-gray-400">
          {showRight && right}
          {age != null && (
            <>
              {showRight && right != null && (
                <span aria-hidden className="decorative-mark text-gray-300 dark:text-gray-600">
                  ·
                </span>
              )}
              <span
                className="whitespace-nowrap"
                title={openedAt != null ? `Opened ${dateTime(openedAt)}` : undefined}
              >
                {age}
              </span>
            </>
          )}
        </span>
        {/* WHY IS THIS CARD HERE, AND WHY HERE — the Pending board's per-card explanation. It
            reads the board from context and renders nothing outside the Pending board. */}
        <CardPlacementInfo card={card} />
      </div>
      {children}
      {/* GENERATED. Its own line, never mixed with a chip — see the `why` prop's contract. */}
      {whyLine != null && whyLine.trim() !== '' && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] italic text-ai-ink">
          <SparkleIcon size={11} className="mt-0.5 shrink-0 not-italic text-ai-signal" />
          <span className="min-w-0">{whyLine}</span>
        </p>
      )}
    </li>
  );
}

function PrLine({
  card,
  onOpen,
}: {
  card:
    | MyTurnCard
    | StalledReviewCard
    | UntouchedThreadCard
    | ReviewerRoutingCard
    | MergeReadyCard
    | UpdateBranchCard
    | SecurityCard
    | DependencyBumpCard
    // ⚠ NARROW ON PURPOSE — do not "simplify" this to `InsightCard`. `ci_failing` and
    // `reviewer_load` do not carry the four fields this reads, and the narrow union is what keeps
    // that a compile error rather than a blank row.
    | ConflictsCard;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left font-medium text-gray-800 hover:underline dark:text-gray-100"
        title="Open this PR on its Overview tab"
      >
        <span className="text-gray-400">
          {card.repoFullName} #{card.prNumber}
        </span>{' '}
        {card.prTitle}
      </button>
      <a
        href={card.githubUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        title="Open on GitHub"
      >
        <ExternalLinkIcon />
      </a>
    </div>
  );
}

/**
 * THE LANDING PR'S BYLINE INPUT on a trunk card, or null when there is nothing to name: the
 * 'your_pr' arm (its "Your PR" chip already says whose it is) and a red head no PR resolved to (a
 * direct push — there is no PR, so there is no author to name, and "Deleted account" would be
 * false). Pure, so the card's one byline decision is pinned by a test.
 */
export function landingPrByline(
  card: CiFailingCard,
): { authorId: number | null; automation: PrAutomation | null } | null {
  if (card.arm !== 'trunk' || card.prId == null) return null;
  return { authorId: card.authorId, automation: card.automation };
}

// The body of a `ci_failing` card. The REPO is the subject on both arms (it is the one thing that
// is always there), the PR is an optional second line, and the external link goes wherever the
// server pointed it — the PR page on 'your_pr', the COMMIT page on 'trunk', where a trunk run's
// checks actually live.
function CiFailingBody({
  card,
  usersById,
  onOpenPr,
  chip,
}: {
  card: CiFailingCard;
  usersById: Map<number, User>;
  onOpenPr: (meta: PinnedPr, returnItemId?: string) => void;
  /** The chip before the detail. Defaults to whose it is ("Your PR" / "Your repo"); a red default
   *  branch promoted into My turn passes its type chip instead, because it may be a repo the reader
   *  does not maintain — "Your repo" there would be false. */
  chip?: string;
}): JSX.Element {
  const ci = CI_META[card.ciStatus] ?? null;
  const href = safeExternalUrl(card.githubUrl);
  const hasPr = card.prId != null && card.prNumber != null && card.prTitle != null;
  const byline = landingPrByline(card);
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
        <span className="min-w-0 truncate font-medium text-gray-800 dark:text-gray-100">
          <span className="text-gray-400">{card.repoFullName}</span>{' '}
          {card.arm === 'trunk' ? 'trunk is red' : 'your PR is red'}
        </span>
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={card.arm === 'trunk' ? 'Open the commit on GitHub' : 'Open the PR on GitHub'}
          >
            <ExternalLinkIcon />
          </a>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1" title={ci?.label ?? card.ciStatus}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
            aria-hidden
          />
          {ci?.label ?? card.ciStatus}
        </span>
        {card.headSha != null && <span className="font-mono">{card.headSha.slice(0, 7)}</span>}
      </div>
      {hasPr && (
        // ⚠ RENDERED ONLY WHEN THERE IS ONE. On the 'trunk' arm a missing PR is ORDINARY — ~11% of
        // red heads are direct pushes to the default branch — so the card says trunk is red and
        // simply names no PR, rather than showing an empty "landed by" row.
        // ⚠ ON 'trunk', WHO OPENED THE LANDING PR AND WHO LANDED IT ARE TWO PEOPLE, so the row
        // reads "#12 title · (opened by) Alice · landed by Bob" — the byline sits against the PR it
        // names, and "landed by" introduces only the merger. (A red head after a Dependabot bump
        // reads as exactly that.)
        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          {card.arm === 'your_pr' && <span>PR</span>}
          <button
            type="button"
            onClick={() =>
              onOpenPr(
                metaFor(
                  {
                    prId: card.prId as number,
                    prNumber: card.prNumber as number,
                    prTitle: card.prTitle as string,
                    repoFullName: card.repoFullName,
                  },
                  usersById,
                ),
                card.id,
              )
            }
            className="min-w-0 truncate text-left hover:underline"
            title="Open this PR on its Overview tab"
          >
            <span className="text-gray-400">#{card.prNumber}</span> {card.prTitle}
          </button>
          {byline != null && <PrByline pr={byline} usersById={usersById} repoId={card.repoId} />}
          {card.arm === 'trunk' && card.mergedById != null && (
            <>
              <span>landed by</span>
              <UserChip id={card.mergedById} usersById={usersById} />
            </>
          )}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
          {chip ?? (card.arm === 'your_pr' ? 'Your PR' : 'Your repo')}
        </span>
        <span className="min-w-0">{card.detail}</span>
      </div>
      {card.arm === 'trunk' && (
        // ⚠ THE HONEST CAVEAT, ON THE CARD ITSELF. `viewerMerged` says the viewer LANDED the commit
        // trunk is currently red at — it is NOT a claim that they broke the build. Trunk CI is
        // non-monotone and we store no per-commit transition history, so nothing here can name the
        // commit that turned it red; saying so on the card is cheaper than being asked.
        <div className="mt-1 text-[11px] italic text-gray-400">
          Trunk is red at this commit — not necessarily because of it.
        </div>
      )}
    </>
  );
}

// ── A PROMOTED CARD KEEPS ITS CONTROLS ────────────────────────────────────────────────────────
//
// Settings → My Turn can MOVE the reader's own work into My turn — a red build, a conflict, a PR
// ready to land, an unanswered thread, a red default branch. The card moves; its actions must not
// be lost on the way. So a promoted card carries its home kind's fields (`MyTurnCard.own`, or the
// trunk card's own), and these adapters rebuild the home card's shape so the SAME components render
// its controls: `PendingMergeActions`, `PendingConflictActions`, `CiFailingBody`. Nothing is
// re-spelled, and nothing fetches on mount — those components' own click-gated rule holds.
//
// Pure, so `test/pendingCardControls.test.ts` pins them.

type ReadyWork = Extract<MyTurnOwnWork, { kind: 'ready' }>;
type ConflictsWork = Extract<MyTurnOwnWork, { kind: 'conflicts' }>;

/** A promoted "ready to land" card, as the Ready to land tab's card — merge or update the branch. */
export function asForwardCard(c: MyTurnCard, own: ReadyWork): MergeReadyCard | UpdateBranchCard {
  const shared = {
    ...c,
    mergeable: own.mergeable,
    lastCommitAt: own.lastCommitAt,
    viewerCanPush: own.viewerCanPush,
    relevance: c.relevance ?? 'direct',
    detail: c.detail,
  };
  return own.forward === 'update_branch'
    ? { ...shared, kind: 'update_branch', mergeStateStatus: 'behind' }
    : { ...shared, kind: 'merge', mergeStateStatus: own.mergeStateStatus };
}

/** A promoted conflicts card, as the Needs fixing tab's card — the resolver entry. */
export function asConflictsCard(c: MyTurnCard, own: ConflictsWork): ConflictsCard {
  return {
    ...c,
    kind: 'conflicts',
    mergeStateStatus: own.mergeStateStatus,
    mergeable: own.mergeable,
    relevance: c.relevance ?? 'direct',
  };
}

/** A promoted red default branch, as the ci_failing trunk card it replaces — same body, same
 *  landing-PR byline (the four author fields are copied, never re-resolved). */
export function asCiFailingCard(t: MyTurnTrunkCard): CiFailingCard {
  return {
    id: t.id,
    kind: 'ci_failing',
    severity: t.severity,
    arm: 'trunk',
    repoId: t.repoId,
    repoFullName: t.repoFullName,
    ciStatus: t.ciStatus,
    prId: t.prId,
    prNumber: t.prNumber,
    prTitle: t.prTitle,
    headSha: t.headSha,
    mergedById: t.mergedById,
    viewerMerged: t.viewerMerged,
    detail: t.detail,
    observedAt: t.observedAt,
    githubUrl: t.githubUrl,
    authorId: t.authorId,
    authorIsBot: t.authorIsBot,
    authorBotKind: t.authorBotKind,
    automation: t.automation,
  };
}

/** Opens the PR a card names, when it names one — the ci_failing card's rule (a trunk with no
 *  landing PR has nothing to open, and a click that does nothing is an inert card). */
function landingPrMeta(
  c: Pick<CiFailingCard, 'prId' | 'prNumber' | 'prTitle' | 'repoFullName'>,
  usersById: Map<number, User>,
): PinnedPr | null {
  if (c.prId == null || c.prNumber == null || c.prTitle == null) return null;
  return metaFor(
    { prId: c.prId, prNumber: c.prNumber, prTitle: c.prTitle, repoFullName: c.repoFullName },
    usersById,
  );
}

/**
 * Does the "Everything else" divider render? Only when Do next holds some of the list but not all
 * of it — a tab whose every card is Do next has no "everything else" to introduce.
 *
 * Exported so this is pinned by a test rather than by reading the JSX.
 */
export function shouldShowDivider(doNextCount: number | undefined, total: number): boolean {
  return doNextCount != null && doNextCount > 0 && doNextCount < total;
}

export function AttentionCards({
  cards,
  users,
  doNextCount,
  people,
  explain,
}: {
  /** The list on screen, highest score first. Do next is its first `doNextCount` cards. */
  cards: InsightCard[];
  users: User[] | undefined;
  /** How many leading cards are Do next (0 = no split, e.g. a response predating scores). */
  doNextCount?: number;
  /** Review-load cards for the "who has reviews waiting" strip, rendered above the ranked list.
   *  ⚠ In THIS list, never a second `<AttentionCards>` mount — see the one-mount note below. */
  people?: InsightCard[];
  /**
   * The Pending board's placement data, which turns on every card's info button and carries the
   * Pro plan's per-card lines. Absent on any other mount (the Pro Insights pane).
   */
  explain?: Pick<
    PendingBoardInfo,
    'tab' | 'rules' | 'scores' | 'viewName' | 'total' | 'whyById' | 'onOpenGuide'
  >;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);
  const usersById = useMemo(() => indexUsers(users), [users]);

  // Back-from-a-click flash — EXACT parity with the Feed (FeedView): a real browser Back pops a
  // URL that lands on Activity, and `applyUrlTab({ fromPop: true })` promotes the pending return
  // target into the one-shot activityFlashItemId (the returnItemId we stamped when opening the
  // PR = the card's id); on return we scroll that card into view and flash it.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashTarget == null) return;
    const id = flashTarget;
    const raf = requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((c) => (c === id ? null : c)), 1800);
      }
      clearFlash();
    });
    return () => cancelAnimationFrame(raf);
  }, [flashTarget, clearFlash]);
  const setCardRef = (id: string, el: HTMLLIElement | null): void => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  // The PR title opens the PR detail on its Overview tab; the card body opens "the event in
  // question". For a thread that event is the thread itself — the PR detail opens on its Threads
  // tab, deep-linked to the thread.
  const open = (meta: PinnedPr, returnItemId?: string): void =>
    openPrDetailTab(meta, { fromActivity: true, returnItemId });
  // Thread-shaped navigation, shared by the untouched-thread card and the thread-grained my_turn
  // types — 'thread', 'thread_reply', 'own_thread' (the thread id is on a different field on each,
  // so it's a parameter).
  const openThreadOn = (card: InsightPrRef & { id: string }, threadId: number): void => {
    openPrDetailTab(metaFor(card, usersById), { fromActivity: true, returnItemId: card.id });
    selectThread(card.prId, threadId);
  };
  const openThread = (card: UntouchedThreadCard): void => openThreadOn(card, card.threadId);

  // The VIEWER'S OWN inbox as cards — the same population GET /api/my-turn serves, and the list the
  // daily brief's "N need your review or reply" line counts. Clicking opens the PR (or, for a
  // thread-grained type, the thread on the PR's Threads tab); ACTING on the PR is what clears it.
  // "Dismiss" (`MyTurnActions`) sets one down until something new happens on it — never a
  // "mark as seen". ONE card per PR: the server's `onePerPr` already chose it.
  //
  // ⚠ Deliberately LEANER than the untouched-thread card: no embedded ThreadCard and no
  // InsightPrSummary. This kind carries its own much larger cap (MY_TURN_CARD_CAP = 50 vs 15 for the
  // survey kinds), so a per-card thread fetch would be up to 50 requests to paint one board — the
  // `ThreadAssessment` failure mode. A thread card navigates to the thread instead.
  //
  // A PROMOTED card (`own`) adds its home kind's controls through the adapters above: the merge row
  // for a PR ready to land, the resolver entry for a conflict, the bot pill on an unanswered thread.
  const renderMyTurnPr = (card: MyTurnCard): JSX.Element => {
    const own = card.own;
    return (
      <CardShell
        key={card.id}
        card={card}
        innerRef={(el) => setCardRef(card.id, el)}
        flash={flashId === card.id}
        right={<span title={dateTime(card.since)}>{relativeTime(card.since)}</span>}
        openedAt={card.openedAt}
        // The ball's clock. It IS the open date on a PR nobody has touched since it appeared,
        // which is most new review requests — see `clockSaysMore`.
        clockAt={card.since}
        onActivate={() =>
          card.threadId != null &&
          (card.reason === 'thread' || card.reason === 'thread_reply' || card.reason === 'own_thread')
            ? openThreadOn(card, card.threadId)
            : open(metaFor(card, usersById), card.id)
        }
      >
        <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
        <PrMetaRow pr={card} usersById={usersById} />
        <PrReviewRow pr={card} usersById={usersById} />
        <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
            {myTurnReasonLabel(card)}
          </span>
          <span className="min-w-0">{card.detail}</span>
          {own?.kind === 'thread' && own.botKind != null && <BotVendorPill kind={own.botKind} />}
        </div>
        {own?.kind === 'ready' && <PendingMergeActions card={asForwardCard(card, own)} />}
        {own?.kind === 'conflicts' && <PendingConflictActions card={asConflictsCard(card, own)} />}
        <MyTurnActions card={card} />
      </CardShell>
    );
  };

  // A red default branch the reader added to My Turn. Its subject is a REPOSITORY, so it renders as
  // the ci_failing trunk card it moved out of — the same body, the same landing-PR line — with its
  // type chip where that card says whose it is.
  const renderMyTurnTrunk = (card: MyTurnTrunkCard): JSX.Element => {
    const landing = landingPrMeta(card, usersById);
    return (
      <CardShell
        key={card.id}
        card={card}
        innerRef={(el) => setCardRef(card.id, el)}
        flash={flashId === card.id}
        // No "opened Nd": the subject is a branch, and the PR it names is the MERGED landing PR.
        right={
          card.observedAt != null ? (
            <span title={dateTime(card.observedAt)}>{relativeTime(card.observedAt)}</span>
          ) : undefined
        }
        onActivate={landing != null ? (): void => open(landing, card.id) : undefined}
      >
        <CiFailingBody
          card={asCiFailingCard(card)}
          usersById={usersById}
          onOpenPr={open}
          chip={myTurnReasonLabel(card)}
        />
        <MyTurnActions card={card} />
      </CardShell>
    );
  };

  const renderCard = (card: InsightCard): JSX.Element | null => {
    switch (card.kind) {
      // The VIEWER'S OWN inbox as cards — the same population GET /api/my-turn serves, and the
      // list the daily brief's "N need your review or reply" line counts. Clicking opens the PR
      // (or, for a thread, the thread on the PR's Threads tab); ACTING on the PR is what clears
      // it, and "Dismiss" sets one down until something new happens on it.
      //
      // ⚠ Deliberately LEANER than the untouched-thread card: no embedded ThreadCard and no
      // InsightPrSummary. This kind carries its own much larger cap (MY_TURN_CARD_CAP = 50 vs 15
      // for the survey kinds), so a per-card thread fetch would be up to 50 requests to paint one
      // board — the `ThreadAssessment` failure mode. A thread-reason card navigates to the thread
      // instead.
      case 'my_turn':
        // ⚠ AN EXHAUSTIVE INNER SWITCH, ending in `never`. The outer `default: return null` below
        // swallows a missing case in silence — the card vanishes while the tab still counts it,
        // which is exactly how `my_turn` shipped invisible once. A new type fails to compile here.
        switch (card.reason) {
          case 'trunk_red':
            return renderMyTurnTrunk(card);
          case 'review_request':
          case 'mention':
          case 'thread':
          case 'thread_reply':
          case 'comment_reply':
          case 'pushed_since':
          case 'own_ci_red':
          case 'own_conflicts':
          case 'pr_approved':
          case 'own_ready':
          case 'your_pr':
          case 'own_thread':
          case 'claude_review':
          case 'watched_repo_pr':
            return renderMyTurnPr(card);
          default: {
            const _x: never = card;
            return null;
          }
        }
      // A red build the viewer is on the hook for. TWO ARMS on one kind, and every PR field is
      // NULLABLE because the 'trunk' arm often has no PR at all (a direct push to the default
      // branch, an association not observed yet) — so this renders the REPO as the subject and the
      // PR as an optional line under it, rather than reusing PrLine (which requires all four).
      case 'ci_failing': {
        const landing = landingPrMeta(card, usersById);
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            // ⚠ NO "opened Nd" HERE, AND IT IS NOT AN OVERSIGHT. `CiFailingCard` deliberately does
            // NOT extend `InsightPrRef` and carries no `openedAt`: on the 'trunk' arm the subject
            // is a REPOSITORY, and the PR it names is the MERGED landing PR of the red head — its
            // open date answers nothing anyone can act on. `observedAt` is the honest clock for
            // both arms and the type comment says so.
            right={
              card.observedAt != null ? (
                <span title={dateTime(card.observedAt)}>{relativeTime(card.observedAt)}</span>
              ) : undefined
            }
            // Only the 'your_pr' arm has a PR to open by construction; a 'trunk' card without a
            // landing PR has nothing to activate, and a whole-card click that did nothing would be
            // the inert card this board exists to remove.
            onActivate={landing != null ? (): void => open(landing, card.id) : undefined}
          >
            <CiFailingBody card={card} usersById={usersById} onOpenPr={open} />
          </CardShell>
        );
      }
      case 'stalled_review':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            // ⚠ THIS IS ALREADY THE PR'S AGE. The server computes `ageHours` as
            // `Math.round((now - pull_requests.opened_at) / 3_600_000)` (db/queries.ts, the
            // stalled-review fold), so "waiting 3d" and "opened 3d" are the SAME number under two
            // names. Adding the age here prints one figure twice.
            right={`waiting ${ageLabel(card.ageHours)}`}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} usersById={usersById} />
            <PrReviewRow pr={card} usersById={usersById} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span>waiting on</span>
              {card.requestedReviewerIds.length > 0 || card.requestedTeamNames.length > 0 ? (
                <>
                  {card.requestedReviewerIds.map((id) => (
                    <UserChip key={id} id={id} usersById={usersById} />
                  ))}
                  {/* GitHub's own teams (display names), same chip grammar as RoutingReviewers */}
                  {card.requestedTeamNames.map((name) => (
                    <span
                      key={`team:${name}`}
                      className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      @{name}
                    </span>
                  ))}
                </>
              ) : (
                <span className="italic">no reviewer requested</span>
              )}
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'untouched_thread':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            // ⚠ A DIFFERENT CLOCK, AND THE RIGHT ONE. This card's `ageHours` is the THREAD's
            // `created_at` age, not the PR's — the thread is the subject, and "6h old" is what the
            // reader is being asked about. No PR age here.
            right={`${ageLabel(card.ageHours)} old`}
          >
            {/* Only this header chrome navigates (→ the thread on the PR's Threads tab). The
                embedded conversation + PR summary below are for reading/replying in place. */}
            <div
              className="-m-1 cursor-pointer rounded p-1 hover:bg-gray-50/70 dark:hover:bg-gray-900/60"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a,button')) return;
                openThread(card);
              }}
            >
              <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
              <PrMetaRow pr={card} usersById={usersById} />
              <PrReviewRow pr={card} usersById={usersById} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono">{card.path}</span>
                <span>· no reply since</span>
                {card.originalCommenterId != null && (
                  <UserChip id={card.originalCommenterId} usersById={usersById} />
                )}
                {card.botKind != null && <BotVendorPill kind={card.botKind} />}
              </div>
            </div>
            <div className="mt-2">
              <InsightThread card={card} />
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'reviewer_routing':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right="unassigned"
            openedAt={card.openedAt}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} usersById={usersById} />
            <PrReviewRow pr={card} usersById={usersById} />
            {card.topPaths.length > 0 && (
              <div className="mt-1 truncate text-[11px] text-gray-400">
                touches <span className="font-mono">{card.topPaths.slice(0, 3).join(', ')}</span>
              </div>
            )}
            <RoutingReviewers card={card} usersById={usersById} />
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      // ── the two FORWARD kinds, sharing one case ─────────────────────────────────────────
      // ⚠ THIS CASE IS NOT OPTIONAL AND tsc DOES NOT DEMAND IT. The union widening forces
      // `KIND_LABEL` and the server's `kindRank`, but the `default: return null` below swallows a
      // missing case in silence — the card vanishes while the ranked head still names its id and
      // the board comes up a row short. That is exactly how `my_turn` shipped invisible.
      //
      // These two are SELF-CLEARING: the card is gone the moment the PR merges or falls behind.
      // No card kind on this board carries a "mark as seen" control any more — the dismissal
      // table is deleted — but these two never should have, for a second reason: hiding a fact
      // about GitHub's merge state would be hiding the world, not an item.
      case 'merge':
      case 'update_branch': {
        const state = MERGE_STATE_LABEL[card.mergeStateStatus];
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={
              card.lastCommitAt != null ? (
                <span title={dateTime(card.lastCommitAt)}>{relativeTime(card.lastCommitAt)}</span>
              ) : undefined
            }
            openedAt={card.openedAt}
            // The head commit's clock — the code that would land. 55% of open PRs have no commit
            // after the one they opened with, so on those it IS the open date: see `clockSaysMore`.
            clockAt={card.lastCommitAt}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} usersById={usersById} />
            <PrReviewRow pr={card} usersById={usersById} />
            <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {state != null && (
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
                  {state}
                </span>
              )}
              {/* CODE-WRITTEN, and the ONE spelling — `mergeCardDetail` on the server also writes
                  the ranked row's `reason`. */}
              <span className="min-w-0">{card.detail}</span>
            </div>
            {/* ⚠ ONLY THE TWO FORWARD KINDS GET THESE. They are the rows where the work IS the
                landing; a "review or reply" card is not one click from merged and must not
                pretend to be. Nothing here fetches on mount — see `PendingMergeActions`. */}
            <PendingMergeActions card={card} />
          </CardShell>
        );
      }
      // A branch GitHub says conflicts with its base. ⚠ NOT A FORWARD KIND: it is something that is
      // WRONG, it carries no merge affordance (see `PendingConflictActions`), and it must NOT be
      // added to `onlyForward` in AttentionView — a conflicting PR IS waiting on someone.
      //
      // ⚠ AND, LIKE THE CASE ABOVE, tsc DOES NOT DEMAND IT. `default: return null` swallows a
      // missing case: the card vanishes while the server still counts it.
      case 'conflicts': {
        const state = conflictsStateChip(card);
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            // ⚠ NO `right` OF ITS OWN, AND THE AGE IS THE WHOLE CLOCK. There is no stored
            // "conflicting since", and `lastCommitAt` — the forward cards' clock — is not on this
            // kind precisely because rendering it here would read as one. The shell's `right !=
            // null` guard drops the separator, so the row reads a bare "opened 3d".
            openedAt={card.openedAt}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} usersById={usersById} />
            <PrReviewRow pr={card} usersById={usersById} />
            <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {state != null && (
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
                  {state}
                </span>
              )}
              <span className="min-w-0">{card.detail}</span>
            </div>
            <PendingConflictActions card={card} />
          </CardShell>
        );
      }
      // ── the Dependencies tab: a dependency-automation PR (ONE card, its merge actions on it) and
      // a person's PR a security tool flagged for a known advisory ───────────────────────────
      // ⚠ LIKE EVERY CASE HERE, tsc DOES NOT DEMAND IT: `default: return null` would swallow the
      // kind, and the tab would count cards it never paints.
      case 'security':
      case 'dependency_bump': {
        const stateChip = card.depState != null ? DEP_STATE_LABEL[card.depState] : null;
        const stateSentence = depStateSentence(card);
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={
              card.lastCommitAt != null ? (
                <span title={dateTime(card.lastCommitAt)}>{relativeTime(card.lastCommitAt)}</span>
              ) : undefined
            }
            openedAt={card.openedAt}
            // The head commit's clock, as on the forward cards: most bumps have no commit after
            // the one they opened with, and then it IS the open date — see `clockSaysMore`.
            clockAt={card.lastCommitAt}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} usersById={usersById} />
            <PrReviewRow pr={card} usersById={usersById} />
            {(stateChip != null || stateSentence != null) && (
              <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[12px] text-gray-600 dark:text-gray-300">
                {stateChip != null && (
                  <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                    {stateChip}
                  </span>
                )}
                {/* CODE-WRITTEN, time-free — the server's one spelling of the state. */}
                {stateSentence != null && <span className="min-w-0">{stateSentence}</span>}
              </div>
            )}
            {card.kind === 'security' && (
              <SecurityDetail
                card={card}
                usersById={usersById}
                onOpenThread={(threadId) => openThreadOn(card, threadId)}
              />
            )}
            {/* Nothing here fetches on mount — see `DependencyActions`. */}
            <DependencyActions card={card} />
          </CardShell>
        );
      }
      case 'reviewer_load':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            // ⚠ NO "opened Nd". `ReviewerLoadCard` does not extend `InsightPrRef`: the subject is a
            // PERSON, and `pendingPrs[]` is a LIST. There is no single PR to date.
            right={`${card.reviewsThisSprint} review${card.reviewsThisSprint === 1 ? '' : 's'} this sprint`}
          >
            <div className="flex items-center gap-2 text-sm">
              <UserChip id={card.reviewerId} usersById={usersById} />
              <span className="font-semibold text-gray-800 dark:text-gray-100">
                {card.pendingCount} pending review{card.pendingCount === 1 ? '' : 's'}
              </span>
            </div>
            {card.pendingPrs.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {card.pendingPrs.map((p) => (
                  <li key={p.prId} className="truncate text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        open(
                          {
                            id: p.prId,
                            number: p.prNumber,
                            title: p.prTitle,
                            repoFullName: p.repoFullName,
                            authorLogin: null,
                            authorDisplayName: null,
                            authorAvatarUrl: null,
                          },
                          card.id,
                        )
                      }
                      className="text-left text-gray-500 hover:underline dark:text-gray-400"
                    >
                      <span className="text-gray-400">
                        {p.repoFullName} #{p.prNumber}
                      </span>{' '}
                      {p.prTitle}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardShell>
        );
      // ⚠ The two bot kinds are filtered out upstream (they live in the free Bots console), so
      // this arm is unreachable for them. It is ALSO where a NEW InsightKind lands, and it
      // renders NOTHING and throws NOTHING — a kind the server emits and this switch has no case
      // for simply vanishes, while the brief line that counts it keeps its number. That is
      // exactly how `my_turn` shipped invisible; add a case whenever the union grows.
      default:
        return null;
    }
  };

  const split = doNextCount ?? 0;
  const showDivider = shouldShowDivider(split, cards.length);
  // Everything a card needs to explain its own position — built once per render, from the SAME
  // ordered array the list paints, so "3rd of 12" is the row the reader is on.
  const board = useMemo<PendingBoardInfo | null>(() => {
    if (explain == null) return null;
    const indexById = new Map(cards.map((c, i) => [c.id, i]));
    for (const c of people ?? []) indexById.set(c.id, -1);
    return { ...explain, indexById, doNextCount: split };
  }, [explain, cards, people, split]);

  const heading = (key: string, label: string, extra?: string): JSX.Element => (
    <li key={key} className="flex items-baseline gap-2 pt-1 first:pt-0">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </span>
      {extra != null && <span className="text-[11px] text-gray-500 dark:text-gray-400">{extra}</span>}
      <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" aria-hidden />
    </li>
  );

  // ⚠ ONE `<ul>`, ONE `<AttentionCards>` MOUNT — never a separate list per section. Two mounts
  // would race on the single `usePinnedTabs.activityFlashItemId` token: each mount's rAF calls
  // `clearFlash()` unconditionally, so whichever ran second would clear a flash the first had
  // just claimed. So the people strip, Do next and Everything else are sections of ONE list.
  return (
    <PendingBoardContext.Provider value={board}>
      <ul className="space-y-2">
        {people != null && people.length > 0 && [
          heading('__people', 'Reviews waiting on people', 'not ranked'),
          ...people.map((c) => renderCard(c)),
        ]}
        {split > 0 && heading('__do-next', 'Do next')}
        {cards.flatMap((card, i) =>
          showDivider && i === split
            ? [heading('__everything-else', 'Everything else'), renderCard(card)]
            : [renderCard(card)],
        )}
      </ul>
    </PendingBoardContext.Provider>
  );
}
