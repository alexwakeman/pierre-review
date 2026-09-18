import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import {
  DO_NEXT_RULES,
  MY_TURN_SEVERITY,
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  PENDING_SEVERITY,
  PENDING_TABS,
  type InsightCard,
  type InsightSeverity,
} from '@pierre-review/shared';
import { CloseIcon, InfoIcon } from '../Icons.js';
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
import { KIND_LABEL, MY_TURN_REASON_LABEL } from './pendingLabels.js';
import { TAB_LABEL } from './pendingTabs.js';

// THE PENDING BOARD'S "WHY IS IT ORDERED LIKE THIS" LAYER — an info button in the board header, one
// on every card, and a "How Pending works" guide in larger type.
//
// ⚠ NOTHING HERE FETCHES. The per-card working rides `GET /api/attention` (`doNextRanking`) and
// every rule quoted comes from `@pierre-review/shared`'s pending-rules — the numbers the server
// folds with. The board forbids fetch-on-mount (fifty cards) and a popover that fetched on OPEN
// would still be a request per curious click for data the page already holds.
//
// ⚠ A CLICK, NEVER A HOVER. A `title=` tooltip cannot be reached by touch or keyboard, and this is
// the explanation of the whole screen. The button is a real <button>; the popover is dismissed by
// Escape (captured, so the global keyboard hook does not ALSO clear the selection), outside press,
// or the button again.
//
// ⚠ `data-noactivate` ON THE POPOVER. It renders through a portal, and React bubbles portal events
// through the COMPONENT tree — so a click on popover text reaches the card's own onClick, which
// would open the PR. CardShell already ignores targets inside `[data-noactivate]`.

const SEV_DOT: Record<InsightSeverity, string> = {
  high: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
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
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: `bottom-${align}`,
    middleware: [offset(6), flip({ fallbackPlacements: [`top-${align}`] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

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
        className={`inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-colors ${
          open
            ? 'text-gray-800 dark:text-gray-100'
            : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
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
            className={`z-[60] ${width} max-w-[92vw] cursor-default rounded-lg border border-gray-200 bg-white p-3 text-[12px] leading-relaxed text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200`}
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
      className="mt-2.5 text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-400"
    >
      How Pending works
    </button>
  );
}

// ── the header summary ─────────────────────────────────────────────────────────────────────

/** The short version, from the board header. Four facts and a way to the long version. */
export function PendingOrderInfo({ onOpenGuide }: { onOpenGuide: () => void }): JSX.Element {
  const w = DO_NEXT_RULES.weights;
  return (
    <InfoPopover label="How Pending is ordered" align="start">
      {(close) => (
        <>
          <p className="font-semibold text-gray-900 dark:text-gray-50">How Pending is ordered</p>
          <p className="mt-1">
            Everything waiting on you or your workspace, in five tabs. The number on a tab is
            everything in it.
          </p>
          <p className="mt-1.5">
            Each tab lists its cards by score, highest first: how close each is to merged (
            {Math.round(w.proximity * 100)}%), how long it has waited ({Math.round(w.stall * 100)}%)
            and how much it is yours ({Math.round(w.relevance * 100)}%). The top{' '}
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
 *  Pending board (the Pro Insights pane renders the same cards with no ranking behind them). */
export interface PendingBoardInfo extends PendingBoardState {
  onOpenGuide: () => void;
  /** The Pro plan's one-sentence line per card id, shown on the card wherever it sits. */
  whyById?: Map<string, string>;
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Where it sits
        </h3>
        <p className="mt-0.5 font-medium text-gray-900 dark:text-gray-50">{x.place}</p>
        <p className="mt-0.5">{x.order}</p>
      </section>
      {x.score != null && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Do next score: {x.score.total} of 100
          </h3>
          <table className="mt-1 w-full border-collapse text-[12px]">
            <tbody>
              {x.score.rows.map((r) => (
                <tr key={r.key} className="border-t border-gray-100 align-top first:border-t-0 dark:border-gray-800">
                  <td className="py-1 pr-2">
                    <div className="font-medium">{r.label}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{r.note}</div>
                  </td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums text-gray-600 dark:text-gray-300">
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
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">{title}</h3>
      {children}
    </section>
  );
}

const th = 'border-b border-gray-200 py-1.5 pr-3 text-left text-[13px] font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300';
const td = 'border-b border-gray-100 py-1.5 pr-3 align-top dark:border-gray-800';

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
  fixing: 'Failing builds you are on the hook for, and PRs with merge conflicts in repos you can push to.',
  review:
    'PRs whose requested review has not come, and PRs nobody has been asked to review. People with reviews waiting are listed above them.',
  threads: 'Review comments with no reply and no later commit to their file.',
  land: 'PRs GitHub will merge now, and PRs that need a branch update first.',
};

/**
 * "How Pending works" — the tabs, how a tab is ordered, the score, the colours and when something
 * is your turn, in larger type. Opened from either info popover.
 */
export function PendingGuideModal({ onClose }: { onClose: () => void }): JSX.Element {
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
        className="flex max-h-[85vh] w-[46rem] max-w-[94vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="How Pending works"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">How Pending works</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center self-stretch text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
            aria-label="Close (Esc)"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-4 text-[15px] leading-relaxed text-gray-700 dark:text-gray-200">
          <p>
            Pending is everything waiting on you or your workspace, in five tabs. It is worked out
            fresh every time it loads. Nothing is stored and nothing can be dismissed: a card leaves
            when the work it describes is done.
          </p>

          <GuideSection title="The tabs">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Tab</th>
                  <th className={th}>What is in it</th>
                </tr>
              </thead>
              <tbody>
                {PENDING_TABS.map((t) => (
                  <tr key={t.key}>
                    <td className={`${td} whitespace-nowrap font-medium`}>{TAB_LABEL[t.key]}</td>
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
          </GuideSection>

          <GuideSection title="Inside a tab">
            <p>
              Cards are listed by score, highest first. The top {PENDING_DO_NEXT_SIZE} are{' '}
              <strong>Do next</strong>; the rest are <strong>Everything else</strong>. Nothing else
              changes the order.
            </p>
            <p>
              A card is only compared with the cards in its own tab. So a PR with two jobs appears
              twice, once in each job’s tab — your approved PR is in My turn (“Approved”) and in
              Ready to land (“Ready to merge”).
            </p>
          </GuideSection>

          <GuideSection title="The score">
            <p>Each card gets a score out of 100, made of three parts.</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Part</th>
                  <th className={th}>Counts</th>
                  <th className={th}>How it is measured</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${td} font-medium`}>Close to merged</td>
                  <td className={td}>{pct(R.weights.proximity)}</td>
                  <td className={td}>
                    The next step: {bases.map((b) => `${BASE_LABEL[b]} ${outOf100(R.proximity[b])}`).join(' · ')}.
                    Then: {(['conflicts', 'many_untouched_threads', 'small_change'] as const).map(adjustmentLabel).join(', ')}.
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>Time waiting</td>
                  <td className={td}>{pct(R.weights.stall)}</td>
                  <td className={td}>
                    {stall.join(' · ')}. Measured from the moment that matters for the card: when you
                    were asked, the last commit, or when the thread started.
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>Yours</td>
                  <td className={td}>{pct(R.weights.relevance)}</td>
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
              The coloured edge on a card shows how urgent it is. It does not change the order.
            </p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Card</th>
                  <th className={th}>It appears when</th>
                  <th className={th}>Colour</th>
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
              </tbody>
            </table>
            <p>
              Most cards cover open, non-draft PRs with activity in the last {L.maxQuietDays} days.
            </p>
          </GuideSection>

          <GuideSection title="When it is your turn">
            <p>A My turn card means you owe an action. Six things put one on the board:</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Card</th>
                  <th className={th}>It appears when</th>
                  <th className={th}>It goes away when</th>
                  <th className={th}>Colour</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${td} font-medium`}>{MY_TURN_REASON_LABEL.review_request}</td>
                  <td className={td}>Someone asks you to review a PR.</td>
                  <td className={td}>You submit a review.</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.review_request} />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{MY_TURN_REASON_LABEL.thread}</td>
                  <td className={td}>
                    Someone replies in a review thread you started, or the code under it changes.
                  </td>
                  <td className={td}>You reply (usually), or resolve the thread (always).</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.thread} />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{MY_TURN_REASON_LABEL.pr_approved}</td>
                  <td className={td}>Your PR has an approval and no “changes requested”.</td>
                  <td className={td}>It is merged or closed.</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.pr_approved} />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{MY_TURN_REASON_LABEL.your_pr}</td>
                  <td className={td}>
                    Your PR has new commits, comments or reviews since you last opened it here.
                  </td>
                  <td className={td}>You open it.</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.your_pr} />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>{MY_TURN_REASON_LABEL.claude_review}</td>
                  <td className={td}>
                    A Claude review finished with findings you have not posted. Local installs only.
                  </td>
                  <td className={td}>You post them.</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.claude_review} />
                  </td>
                </tr>
                <tr>
                  <td className={`${td} font-medium`}>
                    {MY_TURN_REASON_LABEL.watched_repo_pr} / Pushed since
                  </td>
                  <td className={td}>
                    Someone else’s PR that you have not touched, or one a person pushed to after your
                    last review or comment. Only PRs opened since the repo was added.
                  </td>
                  <td className={td}>You review, comment or push.</td>
                  <td className={td}>
                    <Dot severity={MY_TURN_SEVERITY.watched_repo_pr} />
                  </td>
                </tr>
              </tbody>
            </table>
            <p>
              Only real actions count: a review, a comment or a commit. Viewing a PR does not, except
              for “{MY_TURN_REASON_LABEL.your_pr}”. Bot comments and bot pushes never make it your
              turn again.
            </p>
            <p>
              The label on a card says how it relates to you. <strong>Your turn</strong>: it names
              you — you were asked, it is your PR or thread, or someone @-mentioned you.{' '}
              <strong>In your repos</strong>: you can push to the repo or have merged a PR into it.{' '}
              <strong>Review or reply</strong>: neither. Muting a repo in Settings keeps its cards on
              the board but stops them claiming your turn.
            </p>
          </GuideSection>
        </div>
      </div>
    </div>
  );
}
