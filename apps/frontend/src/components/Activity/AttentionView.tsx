import { useCallback, useMemo, useState } from 'react';
import type {
  DailyBriefCounts,
  InsightCard,
  InsightKind,
  PendingAuthorLens,
  PendingTabKey,
} from '@pierre-review/shared';
import {
  ATTENTION_LIVENESS_MAX_IDS,
  useAttentionCards,
  useAttentionLiveness,
} from '../../hooks/useAttentionCards.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import {
  useGenerateWorkPlan,
  useWorkPlan,
  useWorkPlanGenerating,
} from '../../hooks/useWorkPlan.js';
import { useFilters, type AttentionRelevanceLens } from '../../store/filters.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import {
  buildPendingView,
  effectiveMyTurnView,
  effectivePendingTab,
  MY_TURN_VIEW_LABEL,
  MY_TURN_VIEWS,
  offerAuthorLens,
  offerOnlyYours,
  relevancePillCount,
  tabBadgeCount,
  tabsOf,
  TAB_LABEL,
} from './pendingTabs.js';
import { relativeTime } from '../../lib/ui.js';
import { CheckCircleIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
import { AttentionCards, KIND_LABEL } from './AttentionCards.js';
import { BranchesAndOpenPrsView } from './BranchesAndOpenPrsView.js';
import { MyTurnDismissedList } from './MyTurnDismissedList.js';
import { PendingGuideModal, PendingOrderInfo } from './PendingInfo.js';
import { capSentence } from './pendingExplain.js';

// The **Pending** rail entry (CORE/free) — the attention cards (your turn / stalled reviews
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
 * THE ONE `my_turn` CAP-DISCLOSURE RULE — the broad rule: `myTurnPersonalCapDisclosure` falls
 * back to it, and `useMyTurnByWorkspace` (banner + Workspace badges) reads that.
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
      `${total} items are on your plate in this Workspace. The My turn tab lists the ${n} with the highest scores.`,
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
      `${total} items on your plate in this Workspace personally involve you. The My turn tab lists the ${n} with the highest scores.`,
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

/**
 * HOW EACH LENS IS NAMED IN PROSE — one table, read by My turn's "Only yours" control and its
 * filtered empty state, so the two cannot phrase the same narrowing two ways.
 *
 * ⚠ 'others' IS NOT "not yours". It is "nobody has named you on it" — a PR in a repo you only
 * read, or one in a repo you maintain that you have already been counted for elsewhere. The copy
 * says "tied to you", the reporter's own words, because "not personal" reads as a judgement about
 * the work rather than about the relationship.
 */
export const LENS_COPY: Record<
  AttentionRelevanceLens,
  {
    /** Follows "Nothing on My turn …" in the filtered empty state. */
    empty: string;
    /** Names the OTHER half in "· N more <hidden>". */
    hidden: string;
    /** The banner's noun phrase when a KIND is named before it. */
    withKind: string;
    /** …and when it stands alone. */
    bare: string;
  }
> = {
  mine: {
    empty: 'personally involves you',
    hidden: 'in repos you don’t maintain',
    withKind: 'that personally involves you',
    bare: 'what personally involves you',
  },
  others: {
    empty: 'is waiting on someone other than you',
    hidden: 'tied to you directly',
    withKind: 'that isn’t tied to you',
    bare: 'what isn’t tied to you',
  },
};

const TAB_EMPTY: Record<PendingTabKey, string> = {
  my_turn: 'Nothing is your turn right now.',
  fixing: 'No failing builds or merge conflicts are yours to fix.',
  review: 'No reviews are waiting.',
  threads: 'No review threads are waiting for an answer.',
  land: 'Nothing is ready to land.',
  deps: 'No dependency updates or security alerts are waiting.',
};

/** What an empty (or emptied) list says, and where. */
export interface PendingEmptyNote {
  sentence: string;
  /** 'alone' — nothing at all to list. 'above' — above the review-load strip, which counts
   *  REVIEWERS, so no PR narrowing hides it: a narrowed view can be empty with the strip still up. */
  placement: 'alone' | 'above';
  /** The People / Automation lens when it is what emptied the view — the note offers "Show all". */
  emptiedBy: PendingAuthorLens | null;
}

/**
 * WHAT AN EMPTY LIST SAYS — the one narrowing that emptied it, in plain words. Pure, for the test.
 *
 *   the People / Automation lens → "Nothing from automation in Waiting on review right now."
 *   a kind chip                  → "Nothing under Bumps right now." (a chip name is not a noun, so
 *                                  "No Bumps cards" was not English)
 *   My turn's relevance lens     → "Nothing on My turn personally involves you right now."
 *   nothing                      → the tab's own sentence
 *
 * The author lens counts as what emptied the view only when the view holds cards without it; on a
 * tab that is empty anyway the tab's own sentence is the true one.
 *
 * ⚠ AN EMPTY LIST WITH THE REVIEW-LOAD STRIP STILL UP gets the note only when a narrowing emptied
 * it (the note then sits above the strip, with its way back). Un-narrowed, the strip IS the tab's
 * content, and "No reviews are waiting." over a strip of pending reviews would contradict it.
 */
export function pendingEmptyNote(v: {
  tab: PendingTabKey;
  kind: InsightKind | null;
  relevance: AttentionRelevanceLens | null;
  authorLens: PendingAuthorLens | null;
  /** The view's population before the author lens (`PendingView.allTotal`). */
  allTotal: number;
  /** How many cards the view lists, and how many review-load cards the strip shows. */
  cards: number;
  people: number;
}): PendingEmptyNote | null {
  if (v.cards > 0) return null;
  const emptiedBy = v.authorLens != null && v.allTotal > 0 ? v.authorLens : null;
  const narrowed = emptiedBy != null || v.kind != null || v.relevance != null;
  if (v.people > 0 && !narrowed) return null;
  const where = v.kind != null ? `under ${KIND_LABEL[v.kind]}` : `in ${TAB_LABEL[v.tab]}`;
  const sentence =
    emptiedBy != null
      ? `Nothing from ${emptiedBy} ${where} right now.`
      : v.kind != null
        ? `Nothing ${where} right now.`
        : v.relevance != null
          ? `Nothing on My turn ${LENS_COPY[v.relevance].empty} right now.`
          : TAB_EMPTY[v.tab];
  return { sentence, placement: v.people > 0 ? 'above' : 'alone', emptiedBy };
}

export function AttentionView(): JSX.Element {
  // `workspaceId` is null until the workspaces query resolves the account's Default; the hook
  // holds itself idle (skipToken) until then rather than asking the server for an unscoped answer.
  const workspaceId = useFilters((s) => s.workspaceId);
  // The kind filter a chip, link or the banner seats (inside its tab), the tab the reader picked,
  // and My turn's relevance lens. The TAB ON SCREEN is derived from the first two — see
  // `effectivePendingTab` — and never written back.
  const attentionIsolation = useFilters((s) => s.attentionIsolation);
  const attentionTab = useFilters((s) => s.attentionTab);
  const setAttentionTab = useFilters((s) => s.setAttentionTab);
  const attentionRelevance = useFilters((s) => s.attentionRelevance);
  const setAttentionRelevance = useFilters((s) => s.setAttentionRelevance);
  // The People / Automation lens — ONE store field for the whole board (it survives a tab switch),
  // filtered by the server's own `pendingAuthorSideOf`, every figure the server's own split.
  const attentionAuthorLens = useFilters((s) => s.attentionAuthorLens);
  const setAttentionAuthorLens = useFilters((s) => s.setAttentionAuthorLens);
  const { data, isLoading: fetching, isError } = useAttentionCards(workspaceId);
  // ⚠ AN UNRESOLVED WORKSPACE IS LOADING, NOT EMPTY. The hook idles on `skipToken` while
  // `workspaceId` is null, and an idle query is not `isLoading` — so without this the landing
  // screen painted "0" on every tab and "Nothing is your turn right now." for the moment before
  // `GET /api/workspaces` lands, on every cold open.
  const isLoading = fetching || workspaceId == null;

  const tabKey = effectivePendingTab(attentionIsolation, attentionTab);
  const tabs = useMemo(() => tabsOf(data), [data]);
  const view = useMemo(
    () => buildPendingView(data, tabKey, attentionIsolation, attentionRelevance, attentionAuthorLens),
    [data, tabKey, attentionIsolation, attentionRelevance, attentionAuthorLens],
  );
  const activeTab = tabs.find((t) => t.key === tabKey);
  const lensOn = tabKey === 'my_turn' ? attentionRelevance : null;
  const attentionMyTurnView = useFilters((s) => s.attentionMyTurnView);
  const setAttentionMyTurnView = useFilters((s) => s.setAttentionMyTurnView);
  // DERIVED, never written back (the sub-tab rule): any tab but My turn shows its cards.
  const myTurnView = effectiveMyTurnView(tabKey, attentionMyTurnView);
  const showingBranches = myTurnView === 'branches';

  // ── LIVENESS: ONE GITHUB QUESTION FOR THE WHOLE BOARD ─────────────────────────────────────
  //
  // Everything here is a read of already-synced rows, which is what lets the board paint in one
  // request. The price is staleness against GITHUB: a PR merged, closed or unblocked by somebody
  // else keeps its card until the adaptive scheduler walks that repo (2-15 min). `useAttentionLiveness`
  // hands the server these ids and gets them re-read in ONE batched `nodes(ids:)` call.
  //
  // ⚠ IT NEVER TOUCHES THIS LIST. On a change it invalidates `['attention-cards']` + `['daily-brief']`
  // and the server re-ranks.
  //
  // ⚠ RANKED, THEN SLICED. The server caps one sweep at 90 ids (400s an over-cap request rather
  // than truncating it). So the rows whose whole claim IS the merge state go first — ready to merge,
  // behind trunk (a stale one is a button that 405s), merge conflicts, every dependency update
  // (each carries its own merge row), and the same two facts about your own PR when you moved them
  // into My turn (they carry the same rows) — then the tab on screen, then everything else.
  //
  // ⚠ `prId` IS NULLABLE ON SOME KINDS. A `ci_failing` 'trunk' card names a PR only when the red
  // head's landing PR resolved, and review-load cards name none — nothing for a PR probe to ask.
  const livenessPrIds = useMemo(() => {
    const prIdOf = (c: InsightCard): number | null =>
      'prId' in c && typeof c.prId === 'number' ? c.prId : null;
    const onScreen = new Set(view.cards.map((c) => c.id));
    const rank = (c: InsightCard): number => {
      if (c.kind === 'merge' || c.kind === 'update_branch' || c.kind === 'conflicts') return 0;
      if (c.kind === 'dependency_bump' || (c.kind === 'security' && c.dependencyUpdate)) return 0;
      if (c.kind === 'my_turn' && (c.reason === 'own_ready' || c.reason === 'own_conflicts')) return 0;
      return onScreen.has(c.id) ? 1 : 2;
    };
    const seen = new Set<number>();
    const out: number[] = [];
    for (const c of [...(data?.cards ?? [])].sort((a, b) => rank(a) - rank(b))) {
      const id = prIdOf(c);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= ATTENTION_LIVENESS_MAX_IDS) break;
    }
    return out;
  }, [data?.cards, view.cards]);
  useAttentionLiveness(workspaceId, livenessPrIds, !isLoading && !isError);

  // ── THE PRO NARRATION (optional, additive) ────────────────────────────────────────────────
  //
  // ⚠ EVERYTHING ELSE ON THIS SCREEN IS THE FREE PRODUCT AND MUST STAY THAT WAY. The tabs, their
  // counts and their order all come from `/api/attention` alone. With the Pro submodule absent,
  // `useWorkPlan` self-gates on the capability and never fetches, every value below is undefined,
  // and the screen is complete.
  //
  // The plan still picks its items across kinds (its evidence is the Pro seam's, unchanged); its
  // headline sits above the tabs and each `why` line lands on its card in whichever tab the card
  // lives.
  const { workPlan: canNarrate } = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';
  const wp = useWorkPlan(workspaceId, canNarrate);
  const generate = useGenerateWorkPlan(workspaceId);
  // ⚠ THE SHARED MUTATION KEY, never a per-mount `isPending`: a per-mount flag resets the button
  // to "Plan my day" on a tab switch mid-run, which invites a second BILLED POST.
  const busy = useWorkPlanGenerating(workspaceId);
  const usage = useAiUsage(canNarrate);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;
  const plan = wp.data?.enabled ? (wp.data.plan ?? null) : null;

  // The join: a narration step names a WORK-PLAN row id; the board renders CARDS. `cardId` is the
  // translation table. ⚠ THE JOIN KEY STAYS `WorkPlanItem.id` — the plugin's id check, its payload
  // hash and every stored plan speak `wp:<kind>:<id>`; `cardId` is a lookup the SPA performs.
  const whyById = useMemo(() => {
    const out = new Map<string, string>();
    if (plan == null) return out;
    const wpToCard = new Map(
      (wp.data?.evidence?.items ?? []).flatMap((i) =>
        i.cardId != null ? ([[i.id, i.cardId]] as const) : [],
      ),
    );
    for (const step of plan.steps) {
      const cardId = wpToCard.get(step.id);
      if (cardId != null) out.set(cardId, step.why);
    }
    return out;
  }, [plan, wp.data?.evidence?.items]);

  const notice = generate.data?.throttled
    ? 'A plan is already being written — the latest shows here shortly.'
    : generate.data?.creditsExhausted
      ? 'Out of AI credits this month — the plan below is the last one written.'
      : generate.data?.empty
        ? 'Nothing needs doing in this workspace right now.'
        : null;

  // ── "HOW IS THIS ORDERED" ─────────────────────────────────────────────────────────────────
  const [guideOpen, setGuideOpen] = useState(false);
  const openGuide = useCallback(() => setGuideOpen(true), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const viewName =
    (view.kind != null
      ? `${KIND_LABEL[view.kind]} (${TAB_LABEL[view.tab]})`
      : lensOn === 'mine'
        ? 'My turn, only yours'
        : lensOn === 'others'
          ? 'My turn, not tied to you'
          : TAB_LABEL[view.tab]) +
    (attentionAuthorLens === 'people'
      ? ', people only'
      : attentionAuthorLens === 'automation'
        ? ', automation only'
        : '');
  // `rules` is what the server ranked THIS response with — the reader's weights and My Turn type
  // order — so every popover explains the list on screen, never the product constants.
  const explain = useMemo(
    () => ({
      tab: view.tab,
      rules: data?.rules,
      scores: data?.scores,
      viewName,
      total: view.total,
      whyById,
      onOpenGuide: openGuide,
    }),
    [view.tab, data?.rules, data?.scores, viewName, view.total, whyById, openGuide],
  );
  // Settings → My Turn, opened straight to its section — the "Customise" link on My turn.
  const openSettings = useSettingsModal((s) => s.openSettings);
  // Offer the People / Automation pills only where they would change the list (both sides
  // non-empty), or when the lens is already on — so it can always be turned off.
  const authorLensOffered = offerAuthorLens(view.authorSplit, attentionAuthorLens);
  const onlyYoursOffered = tabKey === 'my_turn' && offerOnlyYours(activeTab, attentionRelevance);
  // My turn's Cards view always has one control — "Customise" — so its row renders even over an
  // empty tab. The branches view has none of these controls: nothing in it is a card.
  const showControls =
    !showingBranches &&
    !isLoading &&
    !isError &&
    (view.chips != null || onlyYoursOffered || authorLensOffered || tabKey === 'my_turn');
  // What an empty list says and where — including above the review-load strip, which no PR
  // narrowing hides (see `pendingEmptyNote`).
  const empty = pendingEmptyNote({
    tab: tabKey,
    kind: view.kind,
    relevance: lensOn,
    authorLens: attentionAuthorLens,
    allTotal: view.allTotal,
    cards: view.cards.length,
    people: view.people.length,
  });
  const emptyNote = empty != null && (
    <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
      {empty.sentence}
      {empty.emptiedBy != null && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setAttentionAuthorLens(null)}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900/60"
          >
            Show all
          </button>
        </div>
      )}
      {empty.emptiedBy == null && lensOn != null && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setAttentionRelevance(null)}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900/60"
          >
            Show everyone’s
          </button>
        </div>
      )}
    </div>
  );

  const pill = (on: boolean): string =>
    `shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
      on
        ? 'border-gray-400 bg-gray-100 text-gray-800 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
        : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
    }`;

  return (
    <div className="space-y-3" data-testid="attention-view">
      <div className="flex items-center gap-2">
        {/* LABEL-ONLY rename (the Insights→Reports precedent): the store/URL literal stays
            `'attention'`. Pending is now the default, so that literal is what keeps
            `?activityRepo=` OMITTED rather than misparsed — an unknown value falls into the
            parseInt branch, yields NaN and lands the reader on Pending, the default — which would
            break Back on history entries minted earlier in the same session. */}
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Pending</h2>
        {/* How the board is gathered and ordered — a short popover with a way into the guide. */}
        <PendingOrderInfo onOpenGuide={openGuide} rules={data?.rules} />
        {/* ── the Pro narration's controls + honesty signals ──────────────────────────────
            ⚠ `stale` matters: the tabs re-order on the attention query's own clock while the
            prose does not, so without it the italic lines would silently describe a list that
            has moved. */}
        {canNarrate && !isLoading && !isError && (data?.cards.length ?? 0) > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            {plan != null && wp.data?.stale === true && (
              <span
                className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                title="The list has moved on since this plan was written — the rows are current, the italic lines describe the list as it stood."
              >
                stale
              </span>
            )}
            {plan != null && (
              <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400" title={plan.model}>
                written {relativeTime(plan.generatedAt)}
              </span>
            )}
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={busy || outOfCredits}
              className="rounded bg-ai-signal px-2.5 py-0.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
              title={
                outOfCredits
                  ? 'Out of AI credits — resets next month'
                  : 'Have the model say why some items are worth doing now. The tabs, figures and order are computed either way.'
              }
            >
              {busy ? (
                'Planning…'
              ) : plan != null ? (
                <span className="inline-flex items-center gap-1">
                  <RefreshIcon size={11} />
                  Re-plan my day
                </span>
              ) : (
                'Plan my day'
              )}
            </button>
          </div>
        )}
        {/* Capability off: cloud gets ONE line, OSS/local gets nothing at all (absence, never an
            advert). ⚠ IT MUST NOT IMPLY THE ORDER IS PRO — the order is free; only the sentences
            are not. */}
        {!canNarrate && isCloud && !isLoading && !isError && (data?.cards.length ?? 0) > 0 && (
          <span className="ml-auto text-[11px] text-gray-500 dark:text-gray-400">
            <span className="mr-1 rounded bg-ai-signal/15 px-1 text-[11px] font-semibold text-ai-signal">
              Pro
            </span>
            Have the model say why some of these come first.
          </span>
        )}
      </div>

      {canNarrate && generate.isError && (
        <div className="text-[12px] text-red-600 dark:text-red-400">
          {(generate.error as Error)?.message ?? 'Couldn’t write the plan.'}
        </div>
      )}
      {canNarrate && !generate.isError && notice != null && (
        <div className="text-[12px] text-gray-500 dark:text-gray-400">{notice}</div>
      )}

      {/* GENERATED — the plan's framing sentences, above the tabs they describe. */}
      {plan != null && plan.headline.trim() !== '' && (
        <p
          key={plan.generatedAt}
          className="digest-fade-in flex items-start gap-1.5 text-[12px] italic text-ai-ink"
        >
          <SparkleIcon size={12} className="mt-0.5 shrink-0 text-ai-signal" />
          <span>{plan.headline}</span>
        </p>
      )}
      {plan != null && plan.parked != null && plan.parked.trim() !== '' && (
        <p className="flex items-start gap-1.5 text-[12px] italic text-ai-ink">
          <SparkleIcon size={12} className="mt-0.5 shrink-0 text-ai-signal" />
          <span>{plan.parked}</span>
        </p>
      )}
      {plan != null && plan.droppedIds > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {plan.droppedIds} reference{plan.droppedIds === 1 ? '' : 's'} the model named{' '}
          {plan.droppedIds === 1 ? 'was' : 'were'} not on this board and{' '}
          {plan.droppedIds === 1 ? 'was' : 'were'} discarded.
        </p>
      )}

      {/* ── THE TABS ─────────────────────────────────────────────────────────────────────
          Each count is the tab's WHOLE population (uncapped), the same figure `/api/daily-brief`
          returns for it. A tab with nothing in it stays, dimmed, so the layout never shifts
          and "0" is a fact rather than an absence. */}
      <div role="tablist" aria-label="Pending" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {tabs.map((t) => {
          const on = t.key === tabKey;
          // Under the People / Automation lens a badge counts that side of its tab — the list a
          // click on it opens. The server's own figure, never `total − other`.
          const count = tabBadgeCount(t, attentionAuthorLens);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="pending-tabpanel"
              onClick={() => setAttentionTab(t.key)}
              className={`-mb-px flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100'
                  : 'border-transparent text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {TAB_LABEL[t.key]}
              <span
                className={`rounded-full px-1.5 text-[11px] tabular-nums ${
                  count === 0
                    ? 'text-gray-500 dark:text-gray-500'
                    : on
                      ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                      : 'bg-gray-500/15 text-gray-700 dark:text-gray-300'
                }`}
              >
                {isLoading ? '…' : count}
              </span>
            </button>
          );
        })}
      </div>

      <div id="pending-tabpanel" role="tabpanel" className="space-y-3">
        {tabKey === 'my_turn' && (
          // My turn's two VIEWS. ⚠ NO FIGURE ON EITHER LABEL — see MY_TURN_VIEWS.
          <div role="tablist" aria-label="My turn views" className="flex flex-wrap gap-1">
            {MY_TURN_VIEWS.map((v) => {
              const on = v === myTurnView;
              return (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls="my-turn-view"
                  onClick={() => setAttentionMyTurnView(v)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    on
                      ? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/60'
                  }`}
                >
                  {MY_TURN_VIEW_LABEL[v]}
                </button>
              );
            })}
          </div>
        )}
        <div
          id={tabKey === 'my_turn' ? 'my-turn-view' : undefined}
          role={tabKey === 'my_turn' ? 'tabpanel' : undefined}
          aria-label={tabKey === 'my_turn' ? MY_TURN_VIEW_LABEL[myTurnView] : undefined}
          className="space-y-3"
        >
          {showingBranches ? (
            // Mounted ONLY while this view is on screen, so the default view issues nothing for it.
            <BranchesAndOpenPrsView />
          ) : (
            <>
              {/* The tab's narrowing controls: kind chips on a two-kind tab, "Only yours" on My
                  turn, and — right-aligned — the People / Automation lens wherever it would change
                  the list, then My turn's "Customise". The row always renders on My turn's Cards
                  view, empty or not, so the way into Settings → My Turn is there when the tab
                  holds nothing. */}
              {showControls && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {view.chips != null && (
                    <>
                      <button type="button" onClick={() => setAttentionTab(tabKey)} aria-pressed={view.kind == null} className={pill(view.kind == null)}>
                        All{' '}
                        <span className="tabular-nums">
                          {activeTab != null ? tabBadgeCount(activeTab, attentionAuthorLens) : 0}
                        </span>
                      </button>
                      {view.chips.map((c) => (
                        <button
                          key={c.kind}
                          type="button"
                          onClick={() => setAttentionTab(tabKey, c.kind)}
                          aria-pressed={view.kind === c.kind}
                          className={pill(view.kind === c.kind)}
                        >
                          {KIND_LABEL[c.kind]} <span className="tabular-nums">{c.total}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {onlyYoursOffered && (
                    // ⚠ `setAttentionRelevance` ALONE, seated both ways (`null` included): the lens is
                    // orthogonal to the tab, and a notification that seated 'mine' must be undoable here.
                    <button
                      type="button"
                      onClick={() => setAttentionRelevance(attentionRelevance === 'mine' ? null : 'mine')}
                      aria-pressed={attentionRelevance === 'mine'}
                      className={pill(attentionRelevance === 'mine')}
                      title={`Show only ${LENS_COPY.mine.bare} — the items you’re named on, and the ones in repos you maintain.`}
                    >
                      Only yours{' '}
                      <span className="tabular-nums">
                        {relevancePillCount(activeTab, 'mine', attentionAuthorLens) ?? ''}
                      </span>
                    </button>
                  )}
                  {tabKey === 'my_turn' && attentionRelevance === 'others' && (
                    <button type="button" onClick={() => setAttentionRelevance(null)} aria-pressed className={pill(true)}>
                      Not tied to you{' '}
                      <span className="tabular-nums">
                        {relevancePillCount(activeTab, 'others', attentionAuthorLens) ?? ''}
                      </span>
                    </button>
                  )}
                  {/* ⚠ ONE right-aligned wrapper for everything at the row's end. Two `ml-auto` siblings
                      split the free space between them, so the lens would float mid-row. */}
                  {(authorLensOffered || tabKey === 'my_turn') && (
                    <div className="ml-auto flex flex-wrap items-center gap-3">
                      {authorLensOffered && (
                        // ⚠ `setAttentionAuthorLens` ALONE — the lens is orthogonal to the tab, the kind chip
                        // and "Only yours", and each pill's figure is the server's own count of the view it
                        // opens (`authorSplit`, the view BEFORE this lens), never a subtraction.
                        <div role="group" aria-label="Who opened it" className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAttentionAuthorLens(null)}
                            aria-pressed={attentionAuthorLens == null}
                            className={pill(attentionAuthorLens == null)}
                          >
                            {/* "Anyone", never a second "All": the kind row's "All" beside it counts the tab
                                UNDER this lens, and two pills with one name and two figures say nothing. */}
                            Anyone <span className="tabular-nums">{view.allTotal}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setAttentionAuthorLens('people')}
                            aria-pressed={attentionAuthorLens === 'people'}
                            className={pill(attentionAuthorLens === 'people')}
                          >
                            People <span className="tabular-nums">{view.authorSplit?.people ?? ''}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setAttentionAuthorLens('automation')}
                            aria-pressed={attentionAuthorLens === 'automation'}
                            className={pill(attentionAuthorLens === 'automation')}
                          >
                            Automation <span className="tabular-nums">{view.authorSplit?.automation ?? ''}</span>
                          </button>
                        </div>
                      )}
                      {tabKey === 'my_turn' && (
                        // What counts as your turn, the type order and the ranking weights all live in
                        // Settings → My Turn; this opens the modal on that section.
                        <button
                          type="button"
                          aria-haspopup="dialog"
                          className="text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-400"
                          onClick={() => openSettings('my-turn')}
                        >
                          Customise
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

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
                <div className="text-sm text-red-600 dark:text-red-400">Couldn’t load what needs attention.</div>
              ) : empty?.placement === 'alone' ? (
                emptyNote
              ) : (
                <>
                  {/* ⚠ A NARROWED view with no cards still paints the review-load strip — it counts
                      REVIEWERS, so no PR narrowing applies to it — and without this the reader got the
                      strip and no word that the lens or chip had hidden every card, nor a way back. */}
                  {empty?.placement === 'above' && emptyNote}
                  <AttentionCards
                    cards={view.cards}
                    users={data?.users}
                    doNextCount={data?.tabs != null ? view.doNextCount : 0}
                    people={view.people}
                    explain={explain}
                  />
                  {view.shown < view.total && (
                    <p className="text-[12px] text-gray-500 dark:text-gray-400">
                      {capSentence(view.tab, view.kind, view.shown, view.total, data?.rules)}
                    </p>
                  )}
                </>
              )}
              {/* Out of every count above — see MyTurnDismissedList. Rendered after the list whatever
                  it holds, so an empty My turn still shows what was set aside. */}
              {tabKey === 'my_turn' && !isLoading && !isError && (data?.myTurnDismissed?.length ?? 0) > 0 && (
                <MyTurnDismissedList items={data!.myTurnDismissed!} />
              )}
            </>
          )}
        </div>
      </div>
      {guideOpen && <PendingGuideModal onClose={closeGuide} rules={data?.rules} />}
    </div>
  );
}
