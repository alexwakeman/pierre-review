import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import { usePlacedFloating } from '../ui/floating.js';
import {
  DO_NEXT_RULES,
  MY_TURN_GROUP_LABEL,
  MY_TURN_GROUP_OF,
  MY_TURN_OLDER_DAYS,
  MY_TURN_ORDER,
  MY_TURN_SEVERITY,
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  PENDING_SEVERITY,
  PENDING_TABS,
  type InsightCard,
  type InsightSeverity,
  type MyTurnCardReason,
  type PendingRankRules,
} from '@pierre-review/shared';
import { CloseIcon, InfoIcon } from '../Icons.js';
import { claimActivePopover, closeActivePopover } from '../../lib/activePopover.js';
import {
  BASE_LABEL,
  explainCard,
  hoursPhrase,
  outOf100,
  RELEVANCE_PHRASE,
  SEVERITY_WORD,
  adjustmentLabel,
  type CardExplanation,
  type PendingBoardState,
} from './pendingExplain.js';
import { AUTHOR_ROLE_CHIP, KIND_LABEL, MY_TURN_REASON_LABEL } from './pendingLabels.js';
import { PendingReasonIcon, PendingTabIcon } from './PendingKindIcon.js';
import { TAB_LABEL } from './pendingTabs.js';
import { WEIGHT_LABEL, weightPhrase } from '../settings/myTurnSettingsForm.js';

// THE PENDING BOARD'S "WHY IS IT ORDERED LIKE THIS" LAYER — an info button in the board header, one
// on every card, and a "How Pending works" guide in larger type.
//
// ⚠ NOTHING HERE FETCHES. The per-card working rides `GET /api/attention` (`doNextRanking`) and
// every rule quoted comes from `@pierre-review/shared`'s pending-rules — the numbers the server
// folds with. The board forbids fetch-on-mount (fifty cards) and a popover that fetched on OPEN
// would still be a request per curious click for data the page already holds.
//
// The weights are fixed; they are read from the response's `rules` (the constant is the fallback
// for a response that predates it), so the guide prints what the server scored with.
//
// ⚠ A CLICK, NEVER A HOVER. A `title=` tooltip cannot be reached by touch or keyboard, and this is
// the explanation of the whole screen. The button is a real <button>; the popover is dismissed by
// Escape (captured, so the global keyboard hook does not ALSO clear the selection), outside press,
// or the button again.
//
// ⚠ `data-noactivate` ON THE POPOVER. It renders through a portal, and React bubbles portal events
// through the COMPONENT tree — so a click on popover text reaches the card's own onClick, which
// would open the PR. CardShell already ignores targets inside `[data-noactivate]`.

// The urgency mark (non-text): only 'high' carries a colour, the amber a row's mark takes when
// nothing that blocks or lands applies (pendingRow.ts).
const SEV_DOT: Record<InsightSeverity, string> = {
  high: 'bg-ui-warn',
  warn: 'bg-ui-mute',
  info: 'bg-ui-faint',
};

// ── the button + popover shell ─────────────────────────────────────────────────────────────

function InfoPopover({
  label,
  children,
  width = 'w-[24rem]',
  align = 'end',
}: {
  /** The button's accessible name and the popover's. */
  label: string;
  /** Rendered only while open, and handed a `close` so a link inside can shut it. */
  children: (close: () => void) => ReactNode;
  width?: string;
  /** Which edge of the button the popover lines up with — 'start' for a button at the left of
   *  its row (the board header), 'end' for one at the right (a card). */
  align?: 'start' | 'end';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = usePlacedFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: `bottom-${align}`,
    middleware: [offset(6), flip({ fallbackPlacements: [`top-${align}`] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  // One board popover at a time (a chart's included), and a modal opening over the board closes it
  // — Settings opened with Enter on "Customise" makes no outside press (lib/activePopover.ts).
  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => setOpen(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={label}
        className={`hit inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-colors ${
          open
            ? 'text-ui-ink'
            : 'text-ui-mute hover:text-ui-ink'
        }`}
      >
        <InfoIcon size={13} />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            role="dialog"
            aria-label={label}
            data-noactivate
            className={`z-[60] ${width} max-w-[92vw] cursor-default rounded-ui bg-ui-surface p-3 text-meta leading-relaxed text-ui-ink shadow-lg`}
          >
            {children(() => setOpen(false))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

function GuideLink({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hit mt-2.5 text-meta font-medium text-ui-ink hover:underline"
    >
      How Pending works
    </button>
  );
}

// ── the header summary ─────────────────────────────────────────────────────────────────────

/** The short version, from the board header. Four facts and a way to the long version. */
export function PendingOrderInfo({
  onOpenGuide,
  rules,
}: {
  onOpenGuide: () => void;
  /** What the server ranked this board with; absent on a response that predates it. */
  rules?: PendingRankRules;
}): JSX.Element {
  const w = rules?.weights ?? DO_NEXT_RULES.weights;
  return (
    <InfoPopover label="How Pending is ordered" align="start">
      {(close) => (
        <>
          <p className="font-semibold text-ui-ink">How Pending is ordered</p>
          <p className="mt-1">
            Everything waiting on you or your workspace, in {PENDING_TABS.length} tabs. The number on
            a tab is everything in it. Dependency updates and security alerts have their own tab,
            security first.
          </p>
          <p className="mt-1.5">
            My turn lists what a person is waiting on you for: Waiting on you, then Re-review, then
            Your PRs, longest waiting first. Anything older than {MY_TURN_OLDER_DAYS} days is under
            Older.
          </p>
          <p className="mt-1.5">
            Every other tab lists its cards by score, highest first. The score weighs{' '}
            {weightPhrase('proximity')} ({Math.round(w.proximity * 100)}%), {weightPhrase('stall')} (
            {Math.round(w.stall * 100)}%) and {weightPhrase('relevance')} (
            {Math.round(w.relevance * 100)}%). The top{' '}
            {PENDING_DO_NEXT_SIZE} are <span className="font-semibold">Do next</span>.
          </p>
          <p className="mt-1.5">
            The{' '}
            <InfoIcon size={12} title="info" className="inline-block align-[-0.15em]" /> button on a
            card says why it sits where it does.
          </p>
          <GuideLink
            onClick={() => {
              close();
              onOpenGuide();
            }}
          />
        </>
      )}
    </InfoPopover>
  );
}

// ── the per-card explanation ───────────────────────────────────────────────────────────────

/** What the card list hands every card so it can explain its own position. Null outside the
 *  Pending board (the Insights pane renders the same cards with no ranking behind them). */
export interface PendingBoardInfo extends PendingBoardState {
  onOpenGuide: () => void;
}

export const PendingBoardContext = createContext<PendingBoardInfo | null>(null);

/** The card's own info button. Renders nothing outside the Pending board. */
export function CardPlacementInfo({ card }: { card: InsightCard }): JSX.Element | null {
  const board = useContext(PendingBoardContext);
  if (board == null) return null;
  return (
    <InfoPopover label="Why this card is here">
      {(close) => (
        <CardPlacementBody
          card={card}
          board={board}
          onOpenGuide={() => {
            close();
            board.onOpenGuide();
          }}
        />
      )}
    </InfoPopover>
  );
}

function CardPlacementBody({
  card,
  board,
  onOpenGuide,
}: {
  card: InsightCard;
  board: PendingBoardState;
  onOpenGuide: () => void;
}): JSX.Element {
  // Computed on OPEN only — the popover body mounts when it opens, so fifty closed cards cost
  // nothing.
  const x: CardExplanation = useMemo(() => explainCard(card, board), [card, board]);
  return (
    <div className="space-y-2">
      <section>
        <h3 className="text-meta font-semibold  text-ui-mute">
          Why it is here
        </h3>
        <p className="mt-0.5">{x.why}</p>
        {x.whose != null && <p className="mt-1">{x.whose}</p>}
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className={`inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-full ${SEV_DOT[x.colour.severity]}`} aria-hidden />
          <span>
            <span className="font-medium">{x.colour.word}</span>
            {x.colour.reason !== '' ? `: ${x.colour.reason}.` : '.'}
          </span>
        </p>
      </section>
      <section>
        <h3 className="text-meta font-semibold  text-ui-mute">
          Where it sits
        </h3>
        <p className="mt-0.5 font-medium text-ui-ink">{x.place}</p>
        <p className="mt-0.5">{x.order}</p>
      </section>
      {x.score != null && (
        <section>
          <h3 className="text-meta font-semibold  text-ui-mute">
            Do next score: {x.score.total} of 100
          </h3>
          <table className="mt-1 w-full border-collapse text-meta">
            <tbody>
              {x.score.rows.map((r) => (
                <tr key={r.key} className="border-t border-ui-line align-top first:border-t-0">
                  <td className="py-1 pr-2">
                    <div className="font-medium">{r.label}</div>
                    <div className="text-meta text-ui-mute">{r.note}</div>
                  </td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums text-ui-mute">
                    {r.value} × {r.weight}%
                  </td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right font-medium tabular-nums">
                    {r.points}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <GuideLink onClick={onOpenGuide} />
    </div>
  );
}

// ── the long version ───────────────────────────────────────────────────────────────────────

function GuideSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="text-title font-semibold text-ui-ink">{title}</h3>
      {children}
    </section>
  );
}

const th = 'border-b border-ui-line py-1.5 pr-3 text-left text-body font-semibold text-ui-mute';
const td = 'border-b border-ui-line py-1.5 pr-3 align-top';

function Dot({ severity }: { severity: InsightSeverity }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`inline-block h-2 w-2 rounded-full ${SEV_DOT[severity]}`} aria-hidden />
      {SEVERITY_WORD[severity]}
    </span>
  );
}

/** One line per tab for the guide — what the reader will find in it. */
const TAB_BLURB: Record<(typeof PENDING_TABS)[number]['key'], string> = {
  my_turn: 'Things you owe an action on — see “When it is your turn” below.',
  claude:
    'The newest AI review on each pull request, yours and your teammates’, newest first. Up to 100, not scored. Reviews since you last opened the tab are marked New.',
  fixing: 'Failing builds you are on the hook for, and PRs with merge conflicts in repos you can push to.',
  review:
    'PRs whose requested review has not come, and PRs nobody has been asked to review. People with reviews waiting are listed above them.',
  threads: 'Review comments with no reply and no later commit to their file.',
  land: 'PRs GitHub will merge now, and PRs that need a branch update first.',
  deps: 'PRs opened by dependency bots, security fixes first, and PRs a security tool flagged for a known advisory.',
  waiting:
    'Your own PRs where it is someone else’s turn: a person or team you asked has not reviewed yet. Longest wait first, not scored, and not counted anywhere else.',
};

/** One row per My Turn type for the guide — when a card appears and what clears it. A `Record`,
 *  so a new type cannot ship without its row. */
const MY_TURN_GUIDE: Record<MyTurnCardReason, { appears: string; goes: string }> = {
  review_request: { appears: 'Someone asks you to review a PR.', goes: 'You submit a review.' },
  mention: {
    appears: 'Someone @-mentions you on an open PR.',
    goes: 'You review, comment or push on it.',
  },
  thread: {
    appears: 'Someone replies in a review thread you started, or the code under it changes.',
    goes: 'You reply (usually), or resolve the thread (always).',
  },
  thread_reply: {
    appears: 'Someone replies after your comment in a thread someone else started.',
    goes: 'You reply, or the thread is resolved.',
  },
  comment_reply: {
    appears: 'Someone comments on a PR after your last comment or review there.',
    goes: 'You review, comment or push on it.',
  },
  pushed_since: {
    appears: 'Someone pushes to a PR after your last review or comment.',
    goes: 'You review, comment or push.',
  },
  own_ci_red: {
    appears: 'The latest build on your open PR failed.',
    goes: 'The build passes.',
  },
  own_conflicts: {
    appears: 'Your PR conflicts with its base.',
    goes: 'The conflict is resolved.',
  },
  pr_approved: {
    appears: 'Your PR has an approval and no “changes requested”.',
    goes: 'It is merged or closed.',
  },
  own_ready: {
    appears: 'GitHub will merge your PR, or wants the branch updated.',
    goes: 'It merges, or stops being ready.',
  },
  own_thread: {
    appears: `A review comment on your PR has had no reply for ${hoursPhrase(PENDING_LIMITS.untouchedThreadMinHours)}.`,
    goes: 'Someone replies or pushes to its file.',
  },
  watched_repo_pr: {
    appears:
      'Someone else’s PR you have not touched, opened since the repo was added. Only with “Also show new PRs nobody asked you about” on.',
    goes: 'You review, comment or push.',
  },
};

/**
 * "How Pending works" — the tabs, how a tab is ordered, the score, the colours and when something
 * is your turn, in larger type. Opened from either info popover.
 */
export function PendingGuideModal({
  onClose,
  rules,
}: {
  onClose: () => void;
  /** What the server ranked this board with; absent on a response that predates it. */
  rules?: PendingRankRules;
}): JSX.Element {
  useEffect(() => {
    closeActivePopover();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const R = DO_NEXT_RULES;
  // The weights the server scored this board with (fixed; the constant for an older response).
  const weights = rules?.weights ?? R.weights;
  const switchedOff = new Set(rules?.myTurnOff ?? ['watched_repo_pr']);
  const myTurnOrder = MY_TURN_ORDER.filter((r) => !switchedOff.has(r));
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const bases = (Object.keys(R.proximity) as (keyof typeof R.proximity)[])
    .slice()
    .sort((a, b) => R.proximity[b] - R.proximity[a]);
  const stall = [
    ...R.stallBuckets.map((b) => `${hoursPhrase(b.minHours)} or more: ${outOf100(b.risk)}`),
    `less: ${outOf100(R.stallBase)}`,
  ];
  const rel = (['direct', 'maintained', 'none'] as const).map(
    (k) => `${RELEVANCE_PHRASE[k]}: ${outOf100(R.relevanceWeight[k])}`,
  );
  const sr = PENDING_SEVERITY.stalledReviewHours;
  const ut = PENDING_SEVERITY.untouchedThreadHours;
  const rl = PENDING_SEVERITY.reviewerLoadPending;
  const L = PENDING_LIMITS;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-[46rem] max-w-[94vw] flex-col rounded-ui bg-ui-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="How Pending works"
      >
        <div className="flex items-center justify-between border-b border-ui-line px-5 py-3">
          <h2 className="text-title font-semibold text-ui-ink">How Pending works</h2>
          <button
            type="button"
            onClick={onClose}
            className="hit flex items-center self-stretch text-ui-mute hover:text-ui-ink"
            aria-label="Close (Esc)"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-4 text-title leading-relaxed text-ui-ink">
          <p>
            Pending is everything waiting on you or your workspace, in {PENDING_TABS.length} tabs.
            It is worked out fresh every time it loads. Nothing is stored and nothing can be
            dismissed: a card leaves when the work it describes is done.
          </p>

          <GuideSection title="The tabs">
            <table className="w-full border-collapse text-body">
              <thead>
                <tr>
                  <th className={th}>Tab</th>
                  <th className={th}>What is in it</th>
                </tr>
              </thead>
              <tbody>
                {PENDING_TABS.map((t) => (
                  <tr key={t.key}>
                    <td className={`${td} whitespace-nowrap font-medium`}>
                      <span className="inline-flex items-center gap-1.5">
                        <PendingTabIcon tab={t.key} className="shrink-0 text-ui-mute" />
                        {TAB_LABEL[t.key]}
                      </span>
                    </td>
                    <td className={td}>{TAB_BLURB[t.key]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              The number on a tab is everything in it. A tab lists up to {L.boardListCap} of each
              kind of card and says when it holds more. Where a tab holds two kinds, the chips above
              the list narrow it to one.
            </p>
            <p>
              Every default branch and every open PR in the workspace are listed under{' '}
              <strong>Open pull requests</strong> in the sidebar. Neither is scored or counted in a
              tab.
            </p>
          </GuideSection>

          <GuideSection title="Inside a tab">
            <p>
              Cards are listed by score, highest first, except in {TAB_LABEL.my_turn} and{' '}
              {TAB_LABEL.deps}. The top {PENDING_DO_NEXT_SIZE} are <strong>Do next</strong>; the rest
              are <strong>Everything else</strong>.
            </p>
            <p>
              {TAB_LABEL.my_turn} is not scored. It has fixed groups — {MY_TURN_GROUP_LABEL.waiting},{' '}
              {MY_TURN_GROUP_LABEL.rereview}, {MY_TURN_GROUP_LABEL.yours} — with the longest waiting
              first in each. A card older than {MY_TURN_OLDER_DAYS} days moves to a closed{' '}
              {MY_TURN_GROUP_LABEL.older} group at the end, and still counts. {TAB_LABEL.deps} puts
              every security item before every bump, by score inside each. A PR a dependency bot
              opened is listed only in {TAB_LABEL.deps}, unless it is also your turn on it in{' '}
              {TAB_LABEL.my_turn}.
            </p>
            <p>
              A card is only compared with the cards in its own tab. So a PR with two jobs appears
              twice, once in each job’s tab — a PR you were asked to review is in {TAB_LABEL.my_turn}{' '}
              (“{MY_TURN_REASON_LABEL.review_request}”) and, if a thread on it is unanswered, in{' '}
              {TAB_LABEL.threads}. Your own PR’s failing build, conflict, readiness to land and
              unanswered threads are listed in {TAB_LABEL.my_turn} instead of their own tab, so
              each is listed once.
            </p>
          </GuideSection>

          <GuideSection title="The score">
            <p>Each card gets a score out of 100, made of three parts.</p>
            <table className="w-full border-collapse text-body">
              <thead>
                <tr>
                  <th className={th}>Part</th>
                  <th className={th}>Counts</th>
                  <th className={th}>How it is measured</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${td} font-medium`}>{WEIGHT_LABEL.proximity}</td>
                  <td className={td}>{pct(weights.proximity)}</td>
                  <td className={td}>
                    The next step: {bases.map((b) => `${BASE_LABEL[b]} ${outOf100(R.proximity[b])}`).join(' · ')}.
                    Then: {(['conflicts', 'many_untouched_threads', 'small_change'] as const).map(adjustmentLabel).join(', ')}.
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{WEIGHT_LABEL.stall}</td>
                  <td className={td}>{pct(weights.stall)}</td>
                  <td className={td}>
                    {stall.join(' · ')}. Measured from the moment that matters for the card: when you
                    were asked, the last commit, or when the thread started.
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{WEIGHT_LABEL.relevance}</td>
                  <td className={td}>{pct(weights.relevance)}</td>
                  <td className={td}>{rel.join(' · ')}.</td>
                </tr>
              </tbody>
            </table>
            <p>
              Cards in one tab usually share their next step, so the order mostly comes down to how
              long each has waited and how small the change is.
            </p>
          </GuideSection>

          <GuideSection title="Colours">
            <p>
              The mark at the start of each row is <span className="font-medium text-ui-danger">red</span> when
              the item blocks a merge or a build (a failing build, a merge conflict, a security alert),{' '}
              <span className="font-medium text-ui-success">green</span> when it can land now,{' '}
              <span className="font-medium text-ui-warn">amber</span> when it is urgent and neither of those
              applies, and grey otherwise. Neither colour nor urgency changes the order. How urgent each card is:
            </p>
            <table className="w-full border-collapse text-body">
              <thead>
                <tr>
                  <th className={th}>Card</th>
                  <th className={th}>It appears when</th>
                  <th className={th}>Urgency</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${td} font-medium`}>My turn</td>
                  <td className={td}>You owe an action on a PR (next section).</td>
                  <td className={td}>By type</td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.ci_failing}</td>
                  <td className={td}>
                    The latest build on your open PR failed, or the default branch is failing in a
                    repo you maintain.
                  </td>
                  <td className={td}>
                    <Dot severity="high" /> for your PR. For the branch, <Dot severity="warn" />, or{' '}
                    <Dot severity="high" /> if you merged the PR that landed the failing commit.
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.conflicts}</td>
                  <td className={td}>A PR conflicts with its base, in a repo you can push to.</td>
                  <td className={td}>
                    <Dot severity="high" /> if yours, otherwise <Dot severity="warn" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.stalled_review}</td>
                  <td className={td}>
                    A requested review has not arrived and the PR has been open more than{' '}
                    {hoursPhrase(L.stalledReviewMinHours)}.
                  </td>
                  <td className={td}>
                    <Dot severity="high" /> from {hoursPhrase(sr.high)}, <Dot severity="warn" /> from{' '}
                    {hoursPhrase(sr.warn)}, otherwise <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.reviewer_routing}</td>
                  <td className={td}>
                    Nobody has been asked and nobody has reviewed, and the PR is older than{' '}
                    {hoursPhrase(L.routingMinAgeHours)}. Reviewers are suggested for the top{' '}
                    {L.routingSuggestCap}.
                  </td>
                  <td className={td}>
                    <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.reviewer_load}</td>
                  <td className={td}>
                    Someone has requested reviews they have not done (the top {L.reviewerLoadCap}{' '}
                    people). Shown above the list in Waiting on review, and not scored.
                  </td>
                  <td className={td}>
                    <Dot severity="high" /> from {rl.high}, <Dot severity="warn" /> from {rl.warn},
                    otherwise <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.untouched_thread}</td>
                  <td className={td}>
                    A review comment has no reply and no later commit to its file, and is older than{' '}
                    {hoursPhrase(L.untouchedThreadMinHours)}.
                  </td>
                  <td className={td}>
                    <Dot severity="high" /> from {hoursPhrase(ut.high)}, <Dot severity="warn" /> from{' '}
                    {hoursPhrase(ut.warn)}, otherwise <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.merge}</td>
                  <td className={td}>GitHub will merge it now.</td>
                  <td className={td}>
                    <Dot severity="warn" /> if yours, otherwise <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.update_branch}</td>
                  <td className={td}>GitHub will not merge it until the branch is updated.</td>
                  <td className={td}>
                    <Dot severity="warn" /> if yours, otherwise <Dot severity="info" />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.security}</td>
                  <td className={td}>
                    A dependency bot’s PR fixes a known advisory, or a security tool flagged one on a
                    PR.
                  </td>
                  <td className={td}>
                    <Dot severity="high" /> (<Dot severity="warn" /> when we could only infer it)
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{KIND_LABEL.dependency_bump}</td>
                  <td className={td}>Any other PR a dependency bot opened.</td>
                  <td className={td}>
                    <Dot severity="info" />
                  </td>
                </tr>
              </tbody>
            </table>
            <p>
              Most cards cover open, non-draft PRs with activity in the last {L.maxQuietDays} days.
            </p>
          </GuideSection>

          <GuideSection title="Who opened it">
            <p>
              Every card names who opened the PR. A person shows with their picture and name.
              Automation shows as a chip: the tool’s name when we know it, otherwise what it does,
              such as {AUTHOR_ROLE_CHIP.dependency} or {AUTHOR_ROLE_CHIP.code_agent}. Some tools
              open PRs with a person’s account; those show the tool, then “via” the person. People
              and Automation above a tab narrow it to one or the other. Coding agents count as
              automation.
            </p>
          </GuideSection>

          <GuideSection title="When it is your turn">
            <p>
              A My turn card means a person is waiting on you. These put one on the board, in the
              order My turn lists them. Draft PRs never do. Every card has Dismiss: it sets the
              card down until something new happens on its PR.
            </p>
            <table className="w-full border-collapse text-body">
              <thead>
                <tr>
                  <th className={th}>Card</th>
                  <th className={th}>It appears when</th>
                  <th className={th}>It goes away when</th>
                  <th className={th}>Urgency</th>
                </tr>
              </thead>
              <tbody>
                {myTurnOrder.map((reason) => (
                  <tr key={reason}>
                    <td className={`${td} font-medium`}>
                      <span className="inline-flex items-center gap-1.5">
                        <PendingReasonIcon reason={reason} className="shrink-0 text-ui-mute" />
                        {MY_TURN_REASON_LABEL[reason]}
                      </span>
                      <span className="block text-meta font-normal text-ui-mute">
                        {MY_TURN_GROUP_LABEL[MY_TURN_GROUP_OF[reason]]}
                      </span>
                    </td>
                    <td className={td}>{MY_TURN_GUIDE[reason].appears}</td>
                    <td className={td}>{MY_TURN_GUIDE[reason].goes}</td>
                    <td className={td}>
                      <Dot severity={MY_TURN_SEVERITY[reason]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {switchedOff.has('watched_repo_pr') && (
              <p>
                “{MY_TURN_REASON_LABEL.watched_repo_pr}” shows only with “Also show new PRs nobody
                asked you about” on, in Settings → Pending.
              </p>
            )}
            <p>
              Only real actions count: a review, a comment or a commit. Viewing a PR does not. Bot
              comments and bot pushes never make it your turn again.
            </p>
            <p>
              The label on a card says how it relates to you. <strong>Your turn</strong>: it names
              you — you were asked, mentioned or answered, or it is your PR or thread.{' '}
              <strong>In your repos</strong>: a new PR in a repo you can push to or have merged a PR
              into. <strong>Review or reply</strong>: neither. A muted repository’s cards never
              appear in {TAB_LABEL.my_turn} and never notify you.
            </p>
          </GuideSection>
        </div>
      </div>
    </div>
  );
}
