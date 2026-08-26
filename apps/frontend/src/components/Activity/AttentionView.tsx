import type { DailyBriefCounts, InsightCard } from '@pierre-review/shared';
import { useAttentionCards } from '../../hooks/useAttentionCards.js';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { useFilters } from '../../store/filters.js';
import { AttentionCards, KIND_LABEL } from './AttentionCards.js';

// The "Needs attention" rail entry (CORE/free) — the attention cards (your turn / stalled reviews
// / untouched threads / reviewer load / needs-a-reviewer) that used to sit under the Pro Insights
// AI panels, now a first-class rail entry available on every tier. Scoped to the ACTIVE WORKSPACE
// (a plain id, the only scope this app has); the bot cards live in the free Bots console, so
// they're excluded here.
const BOT_CARD_KINDS = new Set<InsightCard['kind']>(['bot_signal', 'bot_only_review']);

/** What a surface renders when the `my_turn` cards are capped: the pair, plus the sentence that
 *  explains it. `shown` is always the figure to DISPLAY; `total` only ever qualifies it. */
export interface MyTurnCapDisclosure {
  shown: number;
  total: number;
  title: string;
}

/**
 * THE ONE `my_turn` CAP-DISCLOSURE RULE — shared by the board header, the isolation banner and
 * the daily brief's my-turn line, so the three cannot phrase the same cap three ways.
 *
 * `my_turn` cards are emitted capped at MY_TURN_CARD_CAP (50, server-side) while a real workspace
 * holds 148 things on the viewer's plate. Every surface keeps DISPLAYING the card count — that is
 * the list a click actually opens — and appends "of 148" so the figure stops reading as "that's
 * everything" (the no-silent-caps rule). Neither raising the cap nor announcing 148 over a board
 * of 50 is the fix; the first floods the board, the second is a number with no list behind it.
 * Every OTHER card kind is capped at 15 and stays silent on purpose — those are surveys of the
 * workspace, not a personal worklist the user works through.
 *
 * ⚠ THE PAIR MUST COME FROM ONE SNAPSHOT. `shown` is the board's live card count; `counts` is the
 * daily-brief fold, which is the only wire shape carrying `myTurnTotal` to this screen and sits
 * behind a ≤5-min server TTL. So this returns null unless the two AGREE on the card count — which
 * they do exactly when it matters, because both are the same capped fold: a capped board reads 50
 * and so does the brief. When they disagree the brief is mid-refresh and its total describes a
 * population the board no longer paints, which would render "48 of 148" — one row mixing two
 * populations, the defect the period-report work had to fix three times. One refresh of silence
 * beats a wrong denominator.
 */
export function myTurnCapDisclosure(
  shown: number,
  counts: DailyBriefCounts | null | undefined,
): MyTurnCapDisclosure | null {
  if (counts == null) return null;
  return capFor(
    shown,
    counts.myTurn,
    counts.myTurnTotal,
    (total, n) =>
      `${total} items are on your plate in this Workspace. The board shows the most urgent ${n} — highest severity first, newest first within it — and backfills as you clear them.`,
  );
}

/**
 * THE NARROW TWIN — the same rule against the PERSONAL pair, for every surface that displays
 * `myTurnPersonal`.
 *
 * ⚠ PAIR NARROW WITH NARROW. The rule above gates on `shown === counts.myTurn`, so handing it a
 * personal figure fails that equality on every workspace where the two differ — which is exactly
 * the workspaces this narrowing exists for — and the capped line silently loses its "of N". Worse,
 * had the guard passed it would have printed a narrow numerator over a broad denominator: one row,
 * two populations, the defect the period-report work had to fix three times.
 *
 * A response predating the narrowing carries no `myTurnPersonal`, and the surfaces then display
 * the BROAD figure (over-notifying is the safe direction) — so this degrades to the broad pair
 * too, keeping the displayed number and its denominator the same fold. But a `myTurnPersonal`
 * WITHOUT its own total discloses nothing rather than borrowing `myTurnTotal`.
 */
export function myTurnPersonalCapDisclosure(
  shown: number,
  counts: DailyBriefCounts | null | undefined,
): MyTurnCapDisclosure | null {
  if (counts == null) return null;
  if (counts.myTurnPersonal == null) return myTurnCapDisclosure(shown, counts);
  return capFor(
    shown,
    counts.myTurnPersonal,
    counts.myTurnPersonalTotal,
    (total, n) =>
      // Keeps the literal "in this Workspace" — `workspaceCapDisclosure` swaps that phrase for the
      // row's own workspace name, and a reword here would silently make that a no-op.
      `${total} items on your plate in this Workspace personally involve you. The board shows the most urgent ${n} — highest severity first, newest first within it — and backfills as you clear them.`,
  );
}

/** The shared body of both rules: the same-snapshot guard, the actually-capped test, the pair. */
function capFor(
  shown: number,
  count: number,
  total: number | undefined,
  title: (total: number, shown: number) => string,
): MyTurnCapDisclosure | null {
  if (total == null) return null;
  // Nothing shown ⇒ nothing to qualify (and "0 of 148" would be a lie in the other direction).
  if (shown <= 0) return null;
  // Same-snapshot guard, then the actually-capped test.
  if (shown !== count || total <= count) return null;
  return { shown, total, title: title(total, shown) };
}

/** The figure a NOTIFICATION surface displays for a workspace — the personal subset, falling back
 *  to the broad count on a response that predates the narrowing (notifying too much beats
 *  notifying about nothing). Paired ONLY with `myTurnPersonalCapDisclosure`. */
export function personalMyTurnCount(counts: DailyBriefCounts): number {
  return counts.myTurnPersonal ?? counts.myTurn;
}

/** Does this card survive the board's PERSONAL lens?
 *
 *  ⚠ Only an EXPLICIT `false` hides a card. `personal` is advisory and every other kind lacks it
 *  entirely, so an unclassifiable card stays on the board — the same "absent ⇒ personal" rule the
 *  wire type states, and the safe direction for a lens that hides work. */
export function passesPersonalLens(card: InsightCard): boolean {
  return !(card.kind === 'my_turn' && card.personal === false);
}

/**
 * WHERE the disclosure goes on the board, which depends on what the header count is counting.
 *
 *   'inline' — isolated to my_turn: the header count IS the my_turn count, so it reads
 *              "50 of 148 items".
 *   'aside'  — un-isolated: the header counts FIVE kinds, and "95 of 148" would pair a mixed-kind
 *              numerator with a my_turn-only denominator (one row, two populations). The
 *              disclosure gets its own clause instead.
 *   'none'   — isolated to any other kind: no my_turn card is on screen, so there is no number
 *              here to qualify and a clause about 148 would be noise about a hidden population.
 */
export function myTurnCapPlacement(
  cap: MyTurnCapDisclosure | null,
  attentionIsolation: InsightCard['kind'] | null,
): 'inline' | 'aside' | 'none' {
  if (cap == null) return 'none';
  if (attentionIsolation === 'my_turn') return 'inline';
  return attentionIsolation == null ? 'aside' : 'none';
}

export function AttentionView(): JSX.Element {
  // `workspaceId` is null until the workspaces query resolves the account's Default; the hook
  // holds itself idle (skipToken) until then rather than asking the server for an unscoped answer.
  const workspaceId = useFilters((s) => s.workspaceId);
  // The one-kind lens set by the daily brief's lines. Transient and URL-silent; cleared by any
  // rail switch or workspace change (see the store).
  const attentionIsolation = useFilters((s) => s.attentionIsolation);
  const setAttentionIsolation = useFilters((s) => s.setAttentionIsolation);
  // The PERSONAL lens, set by the notification surfaces (banner line, Workspace badge, the
  // brief's "Elsewhere" rows) so the count they showed and the list this board paints are one
  // population. Off by default — a stranger's PR in a repo you only read still needs a review,
  // and this board is where that work is meant to be found.
  const attentionPersonalOnly = useFilters((s) => s.attentionPersonalOnly);
  const setAttentionPersonalOnly = useFilters((s) => s.setAttentionPersonalOnly);
  const { data, isLoading, isError } = useAttentionCards(workspaceId);
  // The cap disclosure's only source on this screen: /api/attention carries the cards, the brief
  // carries the uncapped my_turn population. Same fold, same scope, same default window (the
  // brief IS getWorkspaceInsights), and a cheap counts-only route the Feed has usually already
  // warmed — so this is a cache read, not a second board request.
  const { data: brief } = useDailyBrief(workspaceId);
  const all = (data?.cards ?? []).filter((c) => !BOT_CARD_KINDS.has(c.kind));
  // The PERSONAL lens applies BEFORE the kind isolation and before every count below it: it is a
  // property of the population this board is showing, not of the kind filter on top of it.
  const visible = attentionPersonalOnly ? all.filter(passesPersonalLens) : all;
  // ⚠ Everything below reads `cards`, the ISOLATED subset — including the item count. A header
  // that kept counting the full list would name a number the list underneath it doesn't contain.
  const cards =
    attentionIsolation == null ? visible : visible.filter((c) => c.kind === attentionIsolation);
  // Counted off `visible`, never `cards`: the brief's myTurn counts every my_turn card the board
  // holds, so the same-snapshot guard has to compare like with like whatever the board is filtered to.
  // ⚠ And the RULE has to match the LENS — under the personal lens the numerator is the personal
  // subset, so its denominator must be `myTurnPersonalTotal`; pairing it with the broad total both
  // mixes populations and (because the guard is an equality) drops the disclosure entirely.
  const myTurnShown = visible.filter((c) => c.kind === 'my_turn').length;
  const cap = attentionPersonalOnly
    ? myTurnPersonalCapDisclosure(myTurnShown, brief?.counts)
    : myTurnCapDisclosure(myTurnShown, brief?.counts);
  const placement = myTurnCapPlacement(cap, attentionIsolation);
  // How many cards the lens is holding back — the number the empty state and the banner need to
  // say "they're filtered, not gone".
  const hiddenByLens = all.length - visible.length;

  return (
    <div className="space-y-3" data-testid="attention-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Needs attention</h2>
        {!isLoading && !isError && (
          <span
            className="text-[11px] text-gray-400"
            title={placement === 'inline' ? cap?.title : undefined}
          >
            {placement === 'inline' && cap != null
              ? `${cap.shown} of ${cap.total} items`
              : `${cards.length} item${cards.length === 1 ? '' : 's'}`}
          </span>
        )}
        {!isLoading && !isError && placement === 'aside' && cap != null && (
          <span className="text-[11px] text-gray-400" title={cap.title}>
            · your turn {cap.shown} of {cap.total}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load what needs attention.</div>
      ) : cards.length === 0 && (attentionIsolation != null || attentionPersonalOnly) ? (
        // A filter that matches nothing gets its OWN empty state, naming the filter(s) and
        // offering the way out of each. The generic "nothing needs attention 🎉" below would be a
        // lie here — the board is filtered, and there may be plenty of other cards behind it.
        // ⚠ BOTH lenses reach this branch. A personal lens that emptied the board while 50 cards
        // sit behind it is exactly the "where did my work go" moment, so it may never fall through
        // to the celebration.
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          {/* The explicit {' '} pair is load-bearing: JSX drops a trailing space before a
              newline, so "No " on its own line would render as "NoYour turn items". */}
          <div>
            No{' '}
            {attentionIsolation != null && (
              <>
                <span className="font-medium text-gray-500 dark:text-gray-300">
                  {KIND_LABEL[attentionIsolation]}
                </span>{' '}
              </>
            )}
            items {attentionPersonalOnly ? 'personally involve you ' : ''}right now.
          </div>
          <div className="mt-1 text-[11px]">
            {attentionIsolation != null &&
              (visible.length > 0
                ? `The board is filtered to that one kind — ${visible.length} other item${
                    visible.length === 1 ? ' is' : 's are'
                  } hidden. `
                : 'The board is filtered to that one kind. ')}
            {attentionPersonalOnly &&
              (hiddenByLens > 0
                ? `${hiddenByLens} item${
                    hiddenByLens === 1 ? '' : 's'
                  } in repos you don’t maintain ${hiddenByLens === 1 ? 'is' : 'are'} hidden — ${
                    hiddenByLens === 1 ? 'it does' : 'they do'
                  } still need a review.`
                : 'The board is filtered to what personally involves you.')}
          </div>
          <div className="mt-2 flex items-center justify-center gap-2">
            {attentionPersonalOnly && (
              <button
                type="button"
                onClick={() => setAttentionPersonalOnly(false)}
                className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900/60"
              >
                Show everyone’s
              </button>
            )}
            {attentionIsolation != null && (
              <button
                type="button"
                onClick={() => setAttentionIsolation(null)}
                className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900/60"
              >
                Clear filter
              </button>
            )}
          </div>
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing needs attention in this Workspace right now. 🎉
          <div className="mt-1 text-[11px]">
            Items on your plate, stalled reviews, untouched threads, reviewer load and un-assigned
            PRs will surface here.
          </div>
        </div>
      ) : (
        <AttentionCards cards={cards} users={data?.users} />
      )}
    </div>
  );
}
