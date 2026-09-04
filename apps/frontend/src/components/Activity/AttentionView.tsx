import { useMemo } from 'react';
import type { DailyBriefCounts, InsightCard } from '@pierre-review/shared';
import {
  ATTENTION_LIVENESS_MAX_IDS,
  useAttentionCards,
  useAttentionLiveness,
} from '../../hooks/useAttentionCards.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import {
  useGenerateWorkPlan,
  useWorkPlan,
  useWorkPlanGenerating,
} from '../../hooks/useWorkPlan.js';
import { useFilters, type AttentionRelevanceLens } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { CheckCircleIcon, RefreshIcon, SparkleIcon } from '../Icons.js';
import { AttentionCards, KIND_LABEL } from './AttentionCards.js';

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
      `${total} items are on your plate in this Workspace. The board keeps the most urgent ${n} — chosen by severity, newest first within it — and backfills as you clear them.`,
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
      `${total} items on your plate in this Workspace personally involve you. The board keeps the most urgent ${n} — chosen by severity, newest first within it — and backfills as you clear them.`,
  );
}

/**
 * THE OTHER NARROW TWIN — the "review or reply" half of the same split, for the brief's second
 * my-turn line and the board under the `'others'` lens.
 *
 * ⚠ IT MUST NEVER BE SPELLED `myTurn - myTurnPersonal`. The arithmetic agrees; the DISCLOSURE does
 * not. `capFor` gates the "of N" on `shown === count && total > count`, so a subtracted figure has
 * no denominator of its own to compare against — the line would print a bare number and silently
 * drop its cap, which is the whole defect this family of rules exists to prevent. The server folds
 * `myTurnOther` / `myTurnOtherTotal` as their own populations for exactly this reason.
 *
 * ⚠ AND IT DOES NOT FALL BACK TO THE BROAD PAIR, unlike its personal twin. That fallback exists
 * because a response predating the narrowing made the notification surfaces DISPLAY the broad
 * figure, so the broad denominator was the honest one. Nothing displays an "other" figure on such
 * a response — the brief renders its single broad line instead — so there is nothing to qualify.
 */
export function myTurnOtherCapDisclosure(
  shown: number,
  counts: DailyBriefCounts | null | undefined,
): MyTurnCapDisclosure | null {
  if (counts == null || counts.myTurnOther == null) return null;
  return capFor(
    shown,
    counts.myTurnOther,
    counts.myTurnOtherTotal,
    (total, n) =>
      // Keeps the literal "in this Workspace" for the same reason the personal twin does — see
      // `workspaceCapDisclosure`'s place-name substitution.
      `${total} items in this Workspace need a review or reply from someone, but nobody has named you on them. The board keeps the most urgent ${n} — chosen by severity, newest first within it — and backfills as you clear them.`,
  );
}

/**
 * THE `ci_failing` TWIN — the same rule for the other kind that is a personal worklist rather than
 * a survey of the workspace.
 *
 * ⚠ `ci_failing` shares INSIGHT_CARD_CAP (15) with the survey kinds, which stay silent about their
 * cap on purpose. This one may not: "3 red builds are yours" is a list the viewer works through, so
 * a silent cap is the same lie my_turn's was — just at a much smaller number, which is exactly why
 * nobody would notice it. Pair narrow with narrow, like every other rule here.
 */
export function ciFailingCapDisclosure(
  shown: number,
  counts: DailyBriefCounts | null | undefined,
): MyTurnCapDisclosure | null {
  if (counts == null || counts.ciFailing == null) return null;
  return capFor(
    shown,
    counts.ciFailing,
    counts.ciFailingTotal,
    (total, n) =>
      `${total} red builds in this Workspace are yours — your own open PRs, and trunk in repos you maintain. The board shows the most urgent ${n}.`,
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

/** Does this card survive the board's PERSONAL ('mine') lens?
 *
 *  ⚠ Only an EXPLICIT `false` hides a card. `personal` is advisory and every other kind lacks it
 *  entirely, so an unclassifiable card stays on the board — the same "absent ⇒ personal" rule the
 *  wire type states, and the safe direction for a lens that hides work.
 *
 *  ⚠ It reads `personal`, not `relevance`, on purpose: `personal` IS `relevance !== 'none'`, the
 *  server writes it on every row, and it survives a response that predates the three-way split.
 *  Deriving it from `relevance` here would hide every card on such a response. */
export function passesPersonalLens(card: InsightCard): boolean {
  return !(card.kind === 'my_turn' && card.personal === false);
}

/** The 'others' half: the review-or-reply backlog nobody named the viewer on.
 *
 *  ⚠ `relevance === 'none'`, NOT `personal === false`. A card that carries neither field is NOT
 *  in this half — the two lenses are deliberately not exact complements over unclassifiable rows,
 *  because the safe direction differs: 'mine' keeps an unknown card (over-showing beats hiding
 *  work), and so does 'others' by simply never claiming it. An old response therefore paints an
 *  empty 'others' board rather than a mislabelled full one — and the brief does not offer the
 *  line at all on such a response, so nothing routes a reader there. */
export function passesOtherLens(card: InsightCard): boolean {
  return !(card.kind === 'my_turn' && card.relevance !== 'none');
}

/**
 * THE ONE LENS PREDICATE the board, the banner and their counts all go through.
 *
 * ⚠ IT NARROWS `my_turn` AND NOTHING ELSE, in BOTH directions. Relevance is a property of the
 * my-turn fold — no other kind carries the field, and a stalled review or a red build is a survey
 * of the workspace rather than a claim about who it belongs to. Filtering those by a field they do
 * not have would empty the board the moment a lens was seated (`ci_failing` in particular is
 * personal BY CONSTRUCTION — the server only emits your own red PRs and trunk in repos you
 * maintain — so hiding it under 'others' would hide work that IS yours from a reader who only
 * asked to see the backlog).
 *
 * ⚠ `merge` AND `update_branch` ARE EXEMPT TOO, even though they DO carry `relevance`. They carry
 * it for the RANKER's weight, not as an ownership claim: a PR being ready to land says nothing
 * about whose turn it is. Filtering them here would also stop the brief's two my-turn lines
 * partitioning the lensed board, which is the one job this predicate has.
 */
export function passesRelevanceLens(card: InsightCard, lens: 'mine' | 'others' | null): boolean {
  if (lens == null) return true;
  return lens === 'mine' ? passesPersonalLens(card) : passesOtherLens(card);
}

/**
 * HOW EACH LENS IS NAMED IN PROSE — one table, read by the board's filtered empty state AND by
 * `AttentionIsolationBanner`, so the two surfaces that describe the same narrowing cannot phrase
 * it two ways (the rule `myTurnCapDisclosure` enforces for the cap, applied to the lens).
 *
 * ⚠ 'others' IS NOT "not yours". It is "nobody has named you on it" — a PR in a repo you only
 * read, or one in a repo you maintain that you have already been counted for elsewhere. The copy
 * says "tied to you", the reporter's own words, because "not personal" reads as a judgement about
 * the work rather than about the relationship.
 */
export const LENS_COPY: Record<
  AttentionRelevanceLens,
  {
    /** Follows "No <kind> items …" in the filtered empty state. */
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
    empty: 'personally involve you',
    hidden: 'in repos you don’t maintain',
    withKind: 'that personally involves you',
    bare: 'what personally involves you',
  },
  others: {
    empty: 'are waiting on someone other than you',
    hidden: 'tied to you directly',
    withKind: 'that isn’t tied to you',
    bare: 'what isn’t tied to you',
  },
};

/**
 * WHERE the disclosure goes on the board, which depends on what the header count is counting.
 *
 *   'inline' — isolated to my_turn: the header count IS the my_turn count, so it reads
 *              "50 of 148 items".
 *   'aside'  — un-isolated: the header counts SEVEN kinds, and "95 of 148" would pair a mixed-kind
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
  // The RELEVANCE lens — 'mine' (direct + maintained), 'others' (the review-or-reply backlog) or
  // null. Seated by whichever count the reader clicked (the notification surfaces seat 'mine'; the
  // brief's two my-turn lines seat one each) so the number they saw and the list this board paints
  // are one population. Null by default — a stranger's PR in a repo you only read still needs a
  // review, and this board is where that work is meant to be found.
  const attentionRelevance = useFilters((s) => s.attentionRelevance);
  const setAttentionRelevance = useFilters((s) => s.setAttentionRelevance);
  const { data, isLoading, isError } = useAttentionCards(workspaceId);
  // The cap disclosure's only source on this screen: /api/attention carries the cards, the brief
  // carries the uncapped my_turn population. Same fold, same scope, same default window (the
  // brief IS getWorkspaceInsights), and a cheap counts-only route the Feed has usually already
  // warmed — so this is a cache read, not a second board request.
  const { data: brief } = useDailyBrief(workspaceId);
  const all = (data?.cards ?? []).filter((c) => !BOT_CARD_KINDS.has(c.kind));
  // The RELEVANCE lens applies BEFORE the kind isolation and before every count below it: it is a
  // property of the population this board is showing, not of the kind filter on top of it.
  const visible =
    attentionRelevance == null
      ? all
      : all.filter((c) => passesRelevanceLens(c, attentionRelevance));
  // ⚠ Everything below reads `cards`, the ISOLATED subset — including the item count. A header
  // that kept counting the full list would name a number the list underneath it doesn't contain.
  const cards =
    attentionIsolation == null ? visible : visible.filter((c) => c.kind === attentionIsolation);
  // Counted off `visible`, never `cards`: the brief's myTurn counts every my_turn card the board
  // holds, so the same-snapshot guard has to compare like with like whatever the board is filtered to.
  // ⚠ And the RULE has to match the LENS — under 'mine' the numerator is the personal subset, so
  // its denominator must be `myTurnPersonalTotal`, and under 'others' it must be
  // `myTurnOtherTotal`. Pairing either with the broad total both mixes populations and (because
  // the guard is an equality) drops the disclosure entirely. Pair narrow with narrow, three ways.
  const myTurnShown = visible.filter((c) => c.kind === 'my_turn').length;
  const cap =
    attentionRelevance === 'mine'
      ? myTurnPersonalCapDisclosure(myTurnShown, brief?.counts)
      : attentionRelevance === 'others'
        ? myTurnOtherCapDisclosure(myTurnShown, brief?.counts)
        : myTurnCapDisclosure(myTurnShown, brief?.counts);
  const placement = myTurnCapPlacement(cap, attentionIsolation);
  // The ci_failing cap, disclosed ONLY while the board is isolated to that kind — anywhere else the
  // header count mixes kinds, and a ci-only denominator beside it would be one row, two populations
  // (the same reason `myTurnCapPlacement` returns 'none' off-kind). Counted off `visible`, like the
  // my_turn figure above, so the same-snapshot guard compares like with like.
  const ciCap =
    attentionIsolation === 'ci_failing'
      ? ciFailingCapDisclosure(visible.filter((c) => c.kind === 'ci_failing').length, brief?.counts)
      : null;
  // How many cards the lens is holding back — the number the empty state and the banner need to
  // say "they're filtered, not gone".
  const hiddenByLens = all.length - visible.length;

  // ── THE "DO NEXT" PARTITION ───────────────────────────────────────────────────────────────
  //
  // ⚠ HEAD ∪ TAIL === CARDS, DISJOINT, BY CONSTRUCTION. The head is a RE-ORDERING of the board,
  // never a filter over it. Everything above this line — `visible`, `myTurnShown`, `cap`,
  // `placement`, `ciCap`, both empty states — is computed off `all`/`visible`/`cards` and is
  // untouched by it, which is exactly what keeps every cap disclosure arithmetically true.
  //
  // ⚠ AND THAT COUPLING IS INVISIBLE, SO READ IT HERE RATHER THAN IN A DOC: `capFor` gates on
  // `shown === count`. A future "improvement" that FILTERED `cards` down to the head — or that
  // dropped a tail row because its PR already appears in the head — would push `myTurnShown`
  // below `brief.counts.myTurn`, and "50 of 148" would vanish with no error, on precisely the
  // workspaces where the cap matters.
  //
  // Building `byId` off the FINAL `cards` means the relevance lens narrows the head for free,
  // with no second predicate to keep in step.
  const headSuppressed = attentionIsolation != null;
  const head = useMemo(() => {
    if (headSuppressed) return [];
    const byId = new Map(cards.map((c) => [c.id, c]));
    return (data?.doNextIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is InsightCard => c != null);
  }, [headSuppressed, cards, data?.doNextIds]);
  const ordered = useMemo(() => {
    if (head.length === 0) return cards;
    const inHead = new Set(head.map((c) => c.id));
    return [...head, ...cards.filter((c) => !inHead.has(c.id))];
  }, [head, cards]);

  // ⚠ THE RANKER'S ONE-PR-IS-ONE-JOB DEDUP APPLIES TO HEAD SEATING ONLY. If a PR carries both a
  // `merge` card and a `my_turn` card, only the ranked winner is seated in the head; the sibling
  // stays in the tail, marked (below) rather than dropped. Dropping it would break the partition
  // above and take the cap disclosures with it. The dedup exists because one instruction must not
  // burn two of twelve SCARCE head slots — not because the board may show a PR once.
  const promotedPrIds = useMemo(
    () => new Set(head.map((c) => ('prId' in c ? c.prId : null)).filter((p): p is number => p != null)),
    [head],
  );

  // ── LIVENESS: ONE GITHUB QUESTION FOR THE WHOLE BOARD ─────────────────────────────────────
  //
  // Everything above is a read of already-synced rows, which is what lets fifty cards paint in one
  // request. The price is staleness against GITHUB: a PR merged, closed or unblocked by somebody
  // else keeps its card until the adaptive scheduler walks that repo (2-15 min). `useAttentionLiveness`
  // hands the server these ids and gets them re-read in ONE batched `nodes(ids:)` call.
  //
  // ⚠ IT NEVER TOUCHES THIS LIST. On a change it invalidates `['attention-cards']` + `['daily-brief']`
  // and the server re-ranks — see the partition warning above for what a local splice would cost.
  //
  // ⚠ RANKED, THEN SLICED — and the ranking is the honest half. The server caps one sweep at 90
  // ids (400s an over-cap request rather than truncating it, so a silently-half-freshened board is
  // unrepresentable), and a big board can carry more distinct PRs than that. So the FORWARD kinds
  // go first: those are the rows offering a Merge / Update-branch button, where a stale merge state
  // is a button that 405s, and where "it already merged" is the complaint this whole path exists to
  // answer. The head follows, then everything else. Built off `all`, not `cards`: a card the reader
  // has lensed away is still a card the next unfiltered render will show, and freshening it costs
  // nothing extra inside a batch that is going out anyway.
  const livenessPrIds = useMemo(() => {
    // ⚠ `prId` IS NULLABLE ON SOME KINDS. A `ci_failing` 'trunk' card is about a repository's
    // default branch and names a PR only when the red head's landing PR resolved; the aggregate
    // bot cards carry none at all. Those rows have nothing for a PR probe to ask about, and a
    // `-1` placeholder would be an id the server has to reject rather than one we never sent.
    const prIdOf = (c: InsightCard): number | null =>
      'prId' in c && typeof c.prId === 'number' ? c.prId : null;
    const rank = (c: InsightCard): number => {
      if (c.kind === 'merge' || c.kind === 'update_branch') return 0;
      const id = prIdOf(c);
      return id != null && promotedPrIds.has(id) ? 1 : 2;
    };
    const seen = new Set<number>();
    const out: number[] = [];
    for (const c of [...all].sort((a, b) => rank(a) - rank(b))) {
      const id = prIdOf(c);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= ATTENTION_LIVENESS_MAX_IDS) break;
    }
    return out;
  }, [all, promotedPrIds]);
  useAttentionLiveness(workspaceId, livenessPrIds, !isLoading && !isError);

  // ── THE PRO NARRATION (optional, additive) ────────────────────────────────────────────────
  //
  // ⚠ EVERYTHING ABOVE THIS LINE IS THE FREE PRODUCT AND MUST STAY THAT WAY. The board, the
  // ranked head, the divider and the tail all come from `/api/attention` alone — a core route,
  // registered unconditionally, whose rank is computed by `db/work-plan.ts`. With the Pro
  // submodule absent, `useWorkPlan` self-gates on the capability and never fetches, every value
  // below is undefined, and the screen is complete. That is the property that makes the narration
  // safe to sell separately: it decorates a surface that stands on its own.
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
  // translation table.
  //
  // ⚠ THE JOIN KEY STAYS `WorkPlanItem.id`. The plugin's id-intersection check, its payload hash
  // and every stored plan speak `wp:<kind>:<id>`; `cardId` is a lookup the SPA performs, not a
  // second spelling of row identity. Nothing in the plugin changes.
  //
  // ⚠ AND IT IS INTERSECTED WITH THE HEAD. The order comes from `/api/attention` and the prose
  // from `/api/pro/work-plan` — two independent requests that can be out of phase — so without
  // this, a sentence reading "start here" can render under the "Everything else" divider.
  const whyById = useMemo(() => {
    const out = new Map<string, string>();
    if (headSuppressed || plan == null) return out;
    const inHead = new Set(head.map((c) => c.id));
    const wpToCard = new Map(
      (wp.data?.evidence?.items ?? []).flatMap((i) =>
        i.cardId != null ? ([[i.id, i.cardId]] as const) : [],
      ),
    );
    for (const step of plan.steps) {
      const cardId = wpToCard.get(step.id);
      if (cardId != null && inHead.has(cardId)) out.set(cardId, step.why);
    }
    return out;
  }, [headSuppressed, plan, head, wp.data?.evidence?.items]);

  // ⚠ SUPPRESSED TOGETHER WITH THE HEAD. A `why` says "do this first"; on an isolated flat list
  // there is no first, so the headline, every `why`, `parked` and the dropped-id note all go dark
  // as one — and the generate button is DISABLED rather than hidden, because an enabled button
  // whose output cannot render spends a credit for nothing and gets clicked twice.
  const narration = headSuppressed ? null : plan;

  const notice = generate.data?.throttled
    ? 'A plan is already being written — the latest shows here shortly.'
    : generate.data?.creditsExhausted
      ? 'Out of AI credits this month — the plan below is the last one written.'
      : generate.data?.empty
        ? 'Nothing needs doing in this workspace right now.'
        : null;

  // ⚠ THE ALL-CLEAR MUST STAY REACHABLE. A healthy workspace can hold 15-30 `merge`/
  // `update_branch` rows (one real workspace has 114 merge-ready PRs against a 15-per-kind cap),
  // while the daily-brief strip self-hides at all-zero. Without this the board would show thirty
  // rows beside a hidden strip and "Nothing needs attention" would be unreachable on a workspace
  // where genuinely nothing is waiting on anyone. So when EVERY card is a forward kind, the board
  // says so — above the rows, which still render.
  const onlyForward = cards.length > 0 && cards.every((c) => c.kind === 'merge' || c.kind === 'update_branch');

  return (
    <div className="space-y-3" data-testid="attention-view">
      <div className="flex items-center gap-2">
        {/* LABEL-ONLY rename (the Insights→Reports precedent): the store/URL literal stays
            `'attention'`, because an unknown `?activityRepo=` value falls into the parseInt
            branch, yields NaN and lands the reader on the Feed — breaking Back on history
            entries minted earlier in the same session. */}
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Pending</h2>
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
          // ⚠ THE ASIDE NAMES THE POPULATION IT IS QUALIFYING. Under 'others' the my_turn cards on
          // this board are precisely the ones NOT yours, so a hard-coded "your turn" would put the
          // wrong label on the right number — a one-row, two-populations mislabel of the same
          // family the cap rules exist to prevent.
          <span className="text-[11px] text-gray-400" title={cap.title}>
            · {attentionRelevance === 'others' ? 'review or reply' : 'your turn'} {cap.shown} of{' '}
            {cap.total}
          </span>
        )}
        {!isLoading && !isError && ciCap != null && (
          <span className="text-[11px] text-gray-400" title={ciCap.title}>
            · {ciCap.shown} of {ciCap.total} red builds
          </span>
        )}
        {/* ── the Pro narration's controls + honesty signals ──────────────────────────────
            ⚠ `stale` matters MORE here than it did in the standalone panel: the board
            re-orders on the attention query's own 5-minute clock while the prose does not, so
            without it the italic lines would silently describe a list that has moved. */}
        {canNarrate && !isLoading && !isError && cards.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            {narration != null && wp.data?.stale === true && (
              <span
                className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                title="The list has moved on since this plan was written — the rows are current, the italic lines describe the list as it stood."
              >
                stale
              </span>
            )}
            {narration != null && (
              <span className="shrink-0 text-[10px] text-gray-400" title={narration.model}>
                written {relativeTime(narration.generatedAt)}
              </span>
            )}
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={busy || outOfCredits || headSuppressed}
              className="rounded bg-ai-signal px-2.5 py-0.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
              title={
                headSuppressed
                  ? 'Clear the filter to plan your day — an ordered plan has nothing to order inside a single kind.'
                  : outOfCredits
                    ? 'Out of AI credits — resets next month'
                    : 'Have the model say why the top items are worth doing now. The rows, figures and ranking are computed either way.'
              }
            >
              {busy ? (
                'Planning…'
              ) : narration != null ? (
                <span className="inline-flex items-center gap-1">
                  <RefreshIcon size={11} />
                  Regenerate
                </span>
              ) : (
                'Plan my day'
              )}
            </button>
          </div>
        )}
        {/* Capability off: cloud gets ONE line, OSS/local gets nothing at all (absence, never an
            advert). ⚠ IT MUST NOT IMPLY THE ORDER IS PRO — the ranking above is free, and only
            the sentences are not. */}
        {!canNarrate && isCloud && !isLoading && !isError && cards.length > 0 && (
          <span className="ml-auto text-[10px] text-gray-400">
            <span className="mr-1 rounded bg-ai-signal/15 px-1 text-[10px] font-semibold text-ai-signal">
              Pro
            </span>
            Have the model say why these are first.
          </span>
        )}
      </div>

      {canNarrate && generate.isError && (
        <div className="text-[11px] text-red-500">
          {(generate.error as Error)?.message ?? 'Couldn’t write the plan.'}
        </div>
      )}
      {canNarrate && !generate.isError && notice != null && (
        <div className="text-[11px] text-gray-400">{notice}</div>
      )}

      {/* GENERATED — the one sentence framing the day, above the head it describes. */}
      {narration != null && narration.headline.trim() !== '' && (
        <p
          key={narration.generatedAt}
          className="digest-fade-in flex items-start gap-1.5 text-[12px] italic text-ai-ink"
        >
          <SparkleIcon size={12} className="mt-0.5 shrink-0 text-ai-signal" />
          <span>{narration.headline}</span>
        </p>
      )}
      {narration != null && narration.droppedIds > 0 && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">
          {narration.droppedIds} reference{narration.droppedIds === 1 ? '' : 's'} the model named{' '}
          {narration.droppedIds === 1 ? 'was' : 'were'} not on this list and{' '}
          {narration.droppedIds === 1 ? 'was' : 'were'} discarded.
        </p>
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
        <div className="text-sm text-red-500">Couldn’t load what needs attention.</div>
      ) : cards.length === 0 && (attentionIsolation != null || attentionRelevance != null) ? (
        // A filter that matches nothing gets its OWN empty state, naming the filter(s) and
        // offering the way out of each. The generic "nothing needs attention 🎉" below would be a
        // lie here — the board is filtered, and there may be plenty of other cards behind it.
        // ⚠ EVERY LENS VALUE REACHES THIS BRANCH — the test is `!= null`, never a truthiness check
        // on a boolean that no longer exists. A lens that emptied the board while 50 cards sit
        // behind it is exactly the "where did my work go" moment, so neither half of the split may
        // fall through to the celebration.
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
            items {attentionRelevance != null ? `${LENS_COPY[attentionRelevance].empty} ` : ''}
            right now.
          </div>
          <div className="mt-1 text-[11px]">
            {attentionIsolation != null &&
              (visible.length > 0
                ? `The board is filtered to that one kind — ${visible.length} other item${
                    visible.length === 1 ? ' is' : 's are'
                  } hidden. `
                : 'The board is filtered to that one kind. ')}
            {attentionRelevance != null &&
              (hiddenByLens > 0
                ? `${hiddenByLens} item${hiddenByLens === 1 ? '' : 's'} ${
                    LENS_COPY[attentionRelevance].hidden
                  } ${hiddenByLens === 1 ? 'is' : 'are'} hidden — ${
                    hiddenByLens === 1 ? 'it does' : 'they do'
                  } still need a review.`
                : `The board is filtered to ${LENS_COPY[attentionRelevance].bare}.`)}
          </div>
          <div className="mt-2 flex items-center justify-center gap-2">
            {attentionRelevance != null && (
              <button
                type="button"
                onClick={() => setAttentionRelevance(null)}
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
          <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
          Nothing is pending in this Workspace right now.
          <div className="mt-1 text-[11px]">
            Everything waiting on you or your workspace shows up here, most actionable first. PRs
            that are simply ready to land are listed too, but are not counted as waiting on you.
          </div>
        </div>
      ) : (
        <>
          {/* THE ALL-CLEAR VARIANT — see `onlyForward`. The rows below are real work, but nothing
              on this board is WAITING on anyone, and saying so is what keeps this screen and the
              (self-hiding) daily-brief strip telling the same story. */}
          {onlyForward && (
            <div className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[12px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
              Nothing is waiting on you in this Workspace —{' '}
              <span className="font-medium text-gray-600 dark:text-gray-300">
                {cards.length} ready to land
              </span>
              .
            </div>
          )}
          <AttentionCards
            cards={ordered}
            users={data?.users}
            headCount={head.length}
            promotedPrIds={promotedPrIds}
            whyById={whyById}
            parked={narration?.parked ?? null}
          />
        </>
      )}
    </div>
  );
}
