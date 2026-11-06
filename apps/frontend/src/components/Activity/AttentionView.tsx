import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AiReviewCard,
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
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useAiReviewsSeen } from '../../hooks/useAiReviewsSeen.js';
import { useFilters, type AttentionRelevanceLens } from '../../store/filters.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import {
  buildPendingView,
  effectivePendingTab,
  myTurnSections,
  offerAuthorLens,
  offerOnlyYours,
  relevancePillCount,
  tabBadgeCount,
  tabsOf,
  TAB_LABEL,
  waitingForReviewerCount,
} from './pendingTabs.js';
import { CheckCircleIcon, GearIcon } from '../Icons.js';
import { PendingKindIcon, PendingTabIcon } from './PendingKindIcon.js';
import { AttentionCards, type PendingFocusRequest } from './AttentionCards.js';
import { chipLabel } from './pendingLabels.js';
import { PendingAiReviews } from './PendingAiReviews.js';
import { pendingRowSummary } from './pendingRow.js';
import {
  Button,
  PageHeader,
  Tabs,
  useEdgeFade,
  panelId,
  tabId,
  useCommandProvider,
  useRegisterCommands,
  type Command,
  type TabItem,
} from '../ui/index.js';
import { DependencyMergeAll } from './DependencyMergeAll.js';
import { DependencyAutomationLog } from './DependencyAutomationLog.js';
import { MyTurnDismissedList } from './MyTurnDismissedList.js';
import { PendingGuideModal, PendingOrderInfo } from './PendingInfo.js';
import { capSentence } from './pendingExplain.js';
import { PendingEmptyBoard, PendingSummaryLine, ReviewSuggestionCard } from './PendingFirstLanding.js';
import { DocsOfferCard } from './DocsOfferCard.js';
import { goTo } from '../shell/nav.js';
import { pendingBoardEmpty } from '../../lib/pendingFirstLanding.js';

// The **Pending** rail entry — the attention cards (your turn / stalled reviews / untouched
// threads / reviewer load / needs-a-reviewer) that used to sit under the Insights AI panels, now a
// first-class rail entry. Scoped to the ACTIVE WORKSPACE
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
  my_turn: 'Nothing is waiting on you.',
  claude: 'No AI reviews yet.',
  fixing: 'No failing builds or merge conflicts are yours to fix.',
  review: 'No reviews are waiting.',
  threads: 'No review threads are waiting for an answer.',
  land: 'Nothing is ready to land.',
  deps: 'No dependency updates or security alerts are waiting.',
  waiting: 'None of your PRs is waiting on someone else.',
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
  const where = v.kind != null ? `under ${chipLabel(v.tab, v.kind)}` : `in ${TAB_LABEL[v.tab]}`;
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
  // "AI reviews" is offered only where AI review runs — or while it holds something or is the
  // tab on screen, so a card is never stranded behind a hidden tab.
  const aiEnabled = useAiCapabilities().enabled;
  // "Waiting on others" is information about the reader's own PRs: shown while it holds something
  // or is on screen, so a reader with no PR out for review never sees an always-empty tab.
  const shownTabs = tabs.filter(
    (t) =>
      (t.key !== 'claude' || aiEnabled || t.total > 0 || t.key === tabKey) &&
      (t.key !== 'waiting' || t.total > 0 || t.key === tabKey),
  );
  const view = useMemo(
    () => buildPendingView(data, tabKey, attentionIsolation, attentionRelevance, attentionAuthorLens),
    [data, tabKey, attentionIsolation, attentionRelevance, attentionAuthorLens],
  );
  const activeTab = tabs.find((t) => t.key === tabKey);
  const lensOn = tabKey === 'my_turn' ? attentionRelevance : null;

  // ── "AI REVIEWS": THE NEWEST AI REVIEW PER PR (hooks/useAiReviewsSeen.ts) ──────────────────────
  // A stable reference list, listed by its own block in the server's order — looking never removes a
  // row. Rows newer than the stamp the visit started with wear "New"; while the tab is on screen the
  // workspace's stamp moves to the newest row (never on another tab, never in a loop).
  // (`ai_review` cards are always the People side: the Automation lens shows none.)
  const aiShown = tabKey === 'claude' && attentionAuthorLens !== 'automation';
  const aiCards = useMemo(() => {
    const ids = tabs.find((t) => t.key === 'claude')?.cardIds ?? [];
    const byId = new Map((data?.cards ?? []).map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id)).filter((c): c is AiReviewCard => c?.kind === 'ai_review');
  }, [data?.cards, tabs]);
  const aiSeen = useAiReviewsSeen({
    workspaceId,
    active: aiShown && !isLoading && !isError,
    cards: aiCards,
    seenAt: data?.aiReviewsSeenAt,
  });
  const aiRows = aiShown ? aiCards : [];
  const aiUsersById = useMemo(() => new Map((data?.users ?? []).map((u) => [u.id, u])), [data?.users]);
  const listCards = useMemo(() => view.cards.filter((c) => c.kind !== 'ai_review'), [view.cards]);

  // ── LIVENESS: ONE GITHUB QUESTION FOR THE WHOLE BOARD ─────────────────────────────────────
  //
  // Everything here is a read of already-synced rows, which is what lets the board paint in one
  // request. The price is staleness against GITHUB: a PR merged, closed or unblocked by somebody
  // else keeps its row until the adaptive scheduler walks that repo (2-15 min). `useAttentionLiveness`
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
    // An AI review names a PR (often closed) but claims nothing about its state: never swept.
    const prIdOf = (c: InsightCard): number | null =>
      c.kind !== 'ai_review' &&
      'prId' in c &&
      typeof c.prId === 'number'
        ? c.prId
        : null;
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

  // ── "HOW IS THIS ORDERED" ─────────────────────────────────────────────────────────────────
  const [guideOpen, setGuideOpen] = useState(false);
  // The phone's one filter row scrolls sideways; its hidden edge fades so the rest reads as "more".
  const filterRowRef = useRef<HTMLDivElement>(null);
  const filterFade = useEdgeFade(filterRowRef, 'x');
  const openGuide = useCallback(() => setGuideOpen(true), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const viewName =
    (view.kind != null
      ? `${chipLabel(view.tab, view.kind)} (${TAB_LABEL[view.tab]})`
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
  // `rules` is what the server ranked THIS response with — the fixed weights and My Turn type
  // order — so every popover explains the list on screen.
  const explain = useMemo(
    () => ({
      tab: view.tab,
      rules: data?.rules,
      scores: data?.scores,
      viewName,
      total: view.total,
      onOpenGuide: openGuide,
    }),
    [view.tab, data?.rules, data?.scores, viewName, view.total, openGuide],
  );
  // Settings → Pending → My Turn, opened straight to its section — the "Customise" link on My turn.
  const openSettings = useSettingsModal((s) => s.openSettings);
  // Offer the People / Automation pills only where they would change the list (both sides
  // non-empty), or when the lens is already on — so it can always be turned off.
  const authorLensOffered = offerAuthorLens(view.authorSplit, attentionAuthorLens);
  const onlyYoursOffered = tabKey === 'my_turn' && offerOnlyYours(activeTab, attentionRelevance);
  // My turn always has one control — "Customise" — so its row renders even over an empty tab.
  const showControls =
    !isLoading &&
    !isError &&
    (view.chips != null || onlyYoursOffered || authorLensOffered || tabKey === 'my_turn');
  // What an empty list says and where — including above the review-load group, which no PR
  // narrowing hides (see `pendingEmptyNote`).
  const empty = pendingEmptyNote({
    tab: tabKey,
    kind: view.kind,
    relevance: lensOn,
    authorLens: attentionAuthorLens,
    allTotal: view.allTotal,
    cards: listCards.length + aiRows.length,
    people: view.people.length,
  });
  // THE FIRST LANDING (docs/FRONTEND.md § Pending on the first landing) — all from this response.
  // Every tab empty and the server sent the reader's own PRs: the board says so and lists them
  // instead of one tab's empty sentence.
  const boardEmpty = !isLoading && !isError && data?.ownOpenPrs != null && pendingBoardEmpty(tabs);
  const suggestion = !isLoading && !isError ? (data?.reviewSuggestion ?? null) : null;
  const docsOffers = !isLoading && !isError ? (data?.docsOffers ?? null) : null;
  // My turn's empty state points at Waiting on review when it holds something.
  const reviewWaiting = waitingForReviewerCount(tabs, attentionAuthorLens);
  // My turn's fixed groups as headings (Waiting on you, Re-review, Your PRs, New PRs, Older) — not
  // under a kind chip (My turn has none) and nowhere else.
  const sections = useMemo(
    () => (tabKey === 'my_turn' ? myTurnSections(listCards, Date.now()) : undefined),
    [tabKey, listCards],
  );
  const emptyNote = empty != null && (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-body text-ui-mute">
      <p className="flex items-center gap-2">
        <CheckCircleIcon size={14} className="decorative-mark shrink-0 text-ui-faint" />
        {empty.sentence}
      </p>
      {empty.emptiedBy != null && (
        <Button size="sm" onClick={() => setAttentionAuthorLens(null)}>
          Show all
        </Button>
      )}
      {empty.emptiedBy == null && lensOn != null && (
        <Button size="sm" onClick={() => setAttentionRelevance(null)}>
          Show everyone’s
        </Button>
      )}
      {/* An empty My turn points at the reviews nobody has picked up — the tab's own figure,
          from this response (nothing fetches). */}
      {tabKey === 'my_turn' && empty.emptiedBy == null && lensOn == null && reviewWaiting != null && (
        <Button size="sm" onClick={() => setAttentionTab('review')} data-testid="pending-my-turn-empty-review">
          {reviewWaiting} pull request{reviewWaiting === 1 ? '' : 's'} wait{reviewWaiting === 1 ? 's' : ''} for a reviewer
        </Button>
      )}
    </div>
  );

  // ── ⌘K: every Pending item (across every tab), and the page's own controls ──
  const [focusRequest, setFocusRequest] = useState<PendingFocusRequest | null>(null);
  const focusN = useRef(0);
  const live = useRef({ data, tabs });
  live.current = { data, tabs };
  const itemProvider = useCallback((query: string): Command[] => {
    if (query.trim() === '') return [];
    const d = live.current.data;
    if (d == null) return [];
    const usersById = new Map((d.users ?? []).map((u) => [u.id, u]));
    const nameOf = (id: number | null | undefined): string | null => {
      if (id == null) return null;
      const u = usersById.get(id);
      return u == null ? null : u.displayName || u.githubLogin;
    };
    const out: Command[] = [];
    for (const c of d.cards) {
      // AI reviews are a reference list, not Pending items (they are opened from their own rows).
      if (BOT_CARD_KINDS.has(c.kind) || c.kind === 'ai_review') continue;
      const tab = live.current.tabs.find((t) => t.cardIds?.includes(c.id))?.key ?? null;
      if (tab == null) continue;
      const s = pendingRowSummary(c, { nameOf, tab, sharedOwner: null });
      out.push({
        id: `item:${c.id}`,
        group: 'Pull requests',
        title: s.title,
        hint: `Pending · ${s.reason}${s.ref != null ? ` · ${s.ref}` : ''}`,
        keywords: [s.reason, ...(s.ref != null ? [s.ref] : []), TAB_LABEL[tab]],
        run: () => {
          setAttentionRelevance(null);
          setAttentionAuthorLens(null);
          setAttentionTab(tab);
          focusN.current += 1;
          setFocusRequest({ id: c.id, n: focusN.current });
        },
      });
    }
    return out;
  }, [setAttentionAuthorLens, setAttentionRelevance, setAttentionTab]);
  useCommandProvider('pending-items', itemProvider);

  const pageCommandsKey = `${tabKey}|${attentionRelevance ?? ''}|${attentionAuthorLens ?? ''}`;
  const pageCommands = useMemo<Command[]>(() => {
    const out: Command[] = [
      { id: 'pending:customise', group: 'Settings', title: 'Customise My turn', keywords: ['pending', 'settings', 'new prs'], run: () => openSettings('my-turn') },
      { id: 'pending:guide', group: 'Help', title: 'How Pending works', keywords: ['order', 'score', 'colours'], run: openGuide },
      {
        id: 'pending:only-yours',
        group: 'Actions',
        title: attentionRelevance === 'mine' ? 'Pending: show everyone’s' : 'Pending: only yours',
        keywords: ['my turn', 'mine', 'filter'],
        run: () => {
          if (tabKey !== 'my_turn') setAttentionTab('my_turn');
          setAttentionRelevance(attentionRelevance === 'mine' ? null : 'mine');
        },
      },
      ...(['people', 'automation', null] as const)
        .filter((l) => l !== attentionAuthorLens)
        .map((l) => ({
          id: `pending:by-${l ?? 'anyone'}`,
          group: 'Actions' as const,
          title: l == null ? 'Pending: opened by anyone' : l === 'people' ? 'Pending: opened by people' : 'Pending: opened by automation',
          keywords: ['who opened it', 'bots', 'filter'],
          run: () => setAttentionAuthorLens(l),
        })),
      {
        id: 'pending:deps-merge-all',
        group: 'Actions',
        title: 'Merge or arm all dependency updates…',
        keywords: ['dependabot', 'renovate', 'bumps'],
        run: () => setAttentionTab('deps'),
      },
    ];
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCommandsKey]);
  useRegisterCommands('pending-page', pageCommands);

  const pill = (on: boolean): string =>
    `inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-ui px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:px-3 motion-safe:transition-colors motion-safe:duration-ui-fast ${
      on ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink'
    }`;
  const count = (n: number | string | null | undefined): JSX.Element | null =>
    n == null || n === '' ? null : <span className="text-meta tabular-nums text-ui-faint">{n}</span>;

  const tabItems: TabItem<PendingTabKey>[] = shownTabs.map((t) => ({
    id: t.key,
    label: TAB_LABEL[t.key],
    // PR detail's tab icon size; the boxed strip tints it (accent when on, faint when off).
    icon: <PendingTabIcon tab={t.key} size={14} />,
    // Under the People / Automation lens a badge counts that side of its tab — the list a click on
    // it opens. The server's own figure, never `total − other`. "…" while loading, never "0".
    count: isLoading ? 'loading' : tabBadgeCount(t, attentionAuthorLens),
  }));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="attention-view">
      {/* THE PAGE HEADER (components/ui/PageHeader.tsx). LABEL-ONLY rename
          (the Insights→Reports precedent): the store/URL literal stays `'attention'`. How the board
          is gathered and ordered is the ⓘ — a short popover with a way into the guide. */}
      <PageHeader
        title="Pending"
        info={<PendingOrderInfo onOpenGuide={openGuide} rules={data?.rules} />}
        sub={
          <>
            {/* THE ONE-LINE SUMMARY, while the account is new (`summary`, server-decided). Each part
                is its tab's own badge figure and opens that tab. */}
            {!isLoading && !isError && data?.summary === true && (
              <PendingSummaryLine
                tabs={shownTabs}
                lens={attentionAuthorLens}
                onOpenTab={(k) => {
                  setAttentionRelevance(null);
                  setAttentionTab(k);
                }}
              />
            )}
          </>
        }
      >

        {/* ── THE TABS ─────────────────────────────────────────────────────────────────────
            Each count is the tab's WHOLE population (uncapped), the same figure `/api/daily-brief`
            returns for it — except "Waiting on others", which the brief never counts. A tab with
            nothing in it stays, dimmed, so the layout never shifts and "0" is a fact rather than an
            absence (AI reviews and Waiting on others hide instead, above). 1–8 pick them.
            ⚠ The SAME button tabs as PR detail (`variant="boxed"`, same strip classes and icon
            size) — one look for every tab strip a reader clicks. */}
        <Tabs
          className="-mx-[3px] mt-3 md:flex-wrap md:gap-y-1.5"
          label="Pending"
          idPrefix="pending"
          tabs={tabItems}
          value={tabKey}
          onChange={(k) => setAttentionTab(k)}
          numberKeys
          variant="boxed"
        />
        {/* My turn's one visible sentence; the rest of the explanation stays behind the ⓘ. */}
        {tabKey === 'my_turn' && (
          <p className="mt-1.5 text-meta text-ui-mute" data-testid="pending-my-turn-purpose">
            Pull requests where a person is waiting on you.
          </p>
        )}

        {/* The tab's narrowing controls: kind chips on a two-kind tab, "Only yours" on My turn,
            and — at the end — the People / Automation lens wherever it would change the list, then
            My turn's "Customise". One line; it scrolls sideways on a phone rather than wrapping. */}
        {showControls && (
          // One row on a phone that scrolls sideways (never three stacked rows above the list).
          <div ref={filterRowRef} style={filterFade} className="-mx-2 mt-1 flex items-center gap-1 max-md:overflow-x-auto max-md:[scrollbar-width:none] md:flex-wrap">
            {view.chips != null && (
              <>
                <button type="button" onClick={() => setAttentionTab(tabKey)} aria-pressed={view.kind == null} className={pill(view.kind == null)}>
                  All {count(activeTab != null ? tabBadgeCount(activeTab, attentionAuthorLens) : 0)}
                </button>
                {view.chips.map((c) => (
                  <button
                    key={c.kind}
                    type="button"
                    onClick={() => setAttentionTab(tabKey, c.kind)}
                    aria-pressed={view.kind === c.kind}
                    className={pill(view.kind === c.kind)}
                  >
                    <PendingKindIcon kind={c.kind} className="shrink-0 text-ui-faint" />
                    {chipLabel(tabKey, c.kind)} {count(c.total)}
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
                Only yours {count(relevancePillCount(activeTab, 'mine', attentionAuthorLens))}
              </button>
            )}
            {tabKey === 'my_turn' && attentionRelevance === 'others' && (
              <button type="button" onClick={() => setAttentionRelevance(null)} aria-pressed className={pill(true)}>
                Not tied to you {count(relevancePillCount(activeTab, 'others', attentionAuthorLens))}
              </button>
            )}
            {/* ⚠ ONE wrapper for everything at the row's end. Two `ml-auto` siblings split the free
                space between them, so the lens would float mid-row. */}
            {(authorLensOffered || tabKey === 'my_turn') && (
              <div className="flex shrink-0 items-center gap-1 md:ml-auto md:flex-wrap md:pl-3">
                {authorLensOffered && (
                  // ⚠ `setAttentionAuthorLens` ALONE — the lens is orthogonal to the tab, the kind
                  // chip and "Only yours", and each pill's figure is the server's own count of the
                  // view it opens (`authorSplit`, the view BEFORE this lens), never a subtraction.
                  <div role="group" aria-label="Who opened it" className="flex items-center gap-0.5 rounded-ui">
                    <button type="button" onClick={() => setAttentionAuthorLens(null)} aria-pressed={attentionAuthorLens == null} className={pill(attentionAuthorLens == null)}>
                      {/* "Anyone", never a second "All": the kind row's "All" beside it counts the
                          tab UNDER this lens, and two pills with one name and two figures say nothing. */}
                      Anyone {count(view.allTotal)}
                    </button>
                    <button type="button" onClick={() => setAttentionAuthorLens('people')} aria-pressed={attentionAuthorLens === 'people'} className={pill(attentionAuthorLens === 'people')}>
                      People {count(view.authorSplit?.people ?? '')}
                    </button>
                    <button type="button" onClick={() => setAttentionAuthorLens('automation')} aria-pressed={attentionAuthorLens === 'automation'} className={pill(attentionAuthorLens === 'automation')}>
                      Automation {count(view.authorSplit?.automation ?? '')}
                    </button>
                  </div>
                )}
                {tabKey === 'my_turn' && (
                  // Settings → Pending → My Turn (the one switch, and how My turn works); this opens
                  // the modal on that section.
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-ui px-2 text-body text-ui-ink hover:bg-ui-hover outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
                    onClick={() => openSettings('my-turn')}
                  >
                    <GearIcon size={12} />
                    Customise
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </PageHeader>

      <div
        id={panelId('pending', tabKey)}
        role="tabpanel"
        aria-labelledby={tabId('pending', tabKey)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {isLoading ? (
          <div className="space-y-px px-5 pt-3 max-md:px-2" aria-busy="true" aria-label="Loading what needs attention">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-row rounded-ui bg-ui-surface motion-safe:animate-pulse touch:h-row-touch" />
            ))}
          </div>
        ) : isError ? (
          <p className="px-7 py-6 text-body text-ui-danger max-md:px-4">Couldn’t load what needs attention.</p>
        ) : (
          <AttentionCards
            cards={empty?.placement === 'alone' ? [] : listCards}
            users={data?.users}
            doNextCount={data?.tabs != null ? view.doNextCount : 0}
            people={empty?.placement === 'alone' ? [] : view.people}
            explain={explain}
            focusRequest={focusRequest}
            sections={sections}
            before={
              <>
                {/* ⚠ A NARROWED view with no cards still lists the review-load group — it counts
                    REVIEWERS, so no PR narrowing applies to it — and the note says so, with its way back. */}
                {/* The one-time AI review suggestion — on every tab until run or dismissed. */}
                {suggestion != null && <ReviewSuggestionCard suggestion={suggestion} />}
                {/* Docs folders found in the workspace's repositories — until added or "Not now". */}
                {docsOffers != null && workspaceId != null && (
                  <DocsOfferCard
                    workspaceId={workspaceId}
                    offers={docsOffers}
                    className="mx-5 mt-3 max-md:mx-2"
                    onChoosePart={() => goTo('docs')}
                  />
                )}
                {/* On "Waiting on others" its own rows are the list — never the empty board over them. */}
                {boardEmpty && tabKey !== 'waiting' ? (
                  <PendingEmptyBoard prs={data?.ownOpenPrs ?? []} total={data?.ownOpenPrTotal ?? 0} />
                ) : (
                  empty != null && emptyNote
                )}
                {/* Dependencies: one press merges what can land and arms the rest (the server's dry
                    run is the confirm dialog). Renders nothing when no listed card is a dependency PR. */}
                {tabKey === 'deps' && empty?.placement !== 'alone' && (
                  <div className="flex justify-end px-2 pb-1 pt-2">
                    <DependencyMergeAll cards={view.cards} workspaceId={workspaceId} />
                  </div>
                )}
                {/* What Settings → Dependencies did (approvals, rebase requests, AI conflict runs) —
                    a disclosure that fetches only once opened. */}
                {tabKey === 'deps' && (
                  <div className="px-2 pb-1 pt-1">
                    <DependencyAutomationLog workspaceId={workspaceId} />
                  </div>
                )}
              </>
            }
            after={
              <>
                {/* AI reviews: the newest AI review per PR, newest first; "New" since the last look. */}
                {aiRows.length > 0 && (
                  <PendingAiReviews rows={aiRows} usersById={aiUsersById} baseline={aiSeen.baseline} />
                )}
                {empty?.placement !== 'alone' && view.shown < view.total && (
                  <p className="px-3 pt-3 text-meta text-ui-faint">
                    {capSentence(view.tab, view.kind, view.shown, view.total, data?.rules)}
                  </p>
                )}
                {/* Out of every count above — see MyTurnDismissedList. Rendered after the list
                    whatever it holds, so an empty My turn still shows what was set aside. */}
                {tabKey === 'my_turn' && (data?.myTurnDismissed?.length ?? 0) > 0 && (
                  <MyTurnDismissedList items={data!.myTurnDismissed!} />
                )}
              </>
            }
          />
        )}
      </div>

      {guideOpen && <PendingGuideModal onClose={closeGuide} rules={data?.rules} />}
    </div>
  );
}
