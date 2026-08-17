import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BotFlaggingSelector,
  BotWindowKind,
  MlCategory,
  SeverityAgreementCellRef,
  VendorDisagreeDirection,
} from '@pierre-review/shared';
import { useAutoLoadSentinel } from '../../hooks/useAutoLoadSentinel.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useBotFlagging } from '../../hooks/useBotFlagging.js';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { indexUsers } from '../../lib/ui.js';
import {
  SEVERITY_PICKS,
  TOPIC_PICKS,
  isCategoryFamily,
  isSeverityFamily,
  selectorLabel,
  severityPickOf,
  severityPickToSelector,
  type SeverityPick,
} from '../../lib/severityAgreement.js';
import {
  BotClusterCard,
  BotCommentCard,
  flaggedCommentKey,
  type BotFlaggedPrRef,
} from './BotCommentCard.js';
import { SeverityAgreementMatrixView } from './SeverityAgreementMatrix.js';

// WHAT THE BOTS ARE FLAGGING — the drill-down behind every tile and chip of the Bots rail's ML
// strip. Click "High severity" and this is the comments that number was folded from; click
// "Same-line overlap" and it is the line areas two bots both landed on.
//
// ⚠ EVERY NUMBER ON THIS SCREEN IS THE SERVER'S, and `total` is the tile's own count BY
// CONSTRUCTION: the route re-runs the strip's identical windowed label scan and the identical JS
// fold (`foldMlLabelRow`) before it slices a page. Nothing here may re-derive a count from the
// loaded rows — `lib/botComments.ts`'s `pillOf` in particular buckets a praise-flavoured
// walkthrough the OPPOSITE way from the backend, deliberately, so a client-side tally would
// disagree with the tile the user just clicked. `items.length` is only ever reported as "showing N
// of M", never as the population.
//
// THE TAB IS A SINGLETON THAT IS RE-SEEDED IN PLACE, NEVER REMOUNTED (`BOT_FLAGGING_TAB_KEY`) —
// clicking a second tile while this tab is open swaps the seed under a live component. That is why
// the local refinements below carry an explicit reset effect rather than relying on a remount.

// The window picker options — kept in lockstep with BotRoiPanel's and BotPrsDetail's WINDOWS, since
// all three write the SAME store field. The drill-down reproduces one number off the panel behind
// it, so the two must not be able to be measuring different windows.
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

// Only ever read while the query is DISABLED (no seed). The hook's `selector` is non-optional and
// hooks cannot be skipped, so it needs some value; this one is never sent.
const NO_SELECTOR: BotFlaggingSelector = { kind: 'findings' };

// The disagreement filter's cycle: off → any → the two directions → off. Four positions, three of
// them "on" — `any` answers "where do we and the bots differ at all?", and the two directions
// answer the follow-up ("is this bot inflating, or are we?"), which is the actual tuning question.
const DISAGREE_CYCLE: (VendorDisagreeDirection | null)[] = [null, 'any', 'over', 'under'];

const DISAGREE_LABEL: Record<VendorDisagreeDirection, { label: string; title: string }> = {
  any: {
    label: 'Disagreements only',
    title:
      'Only rows where the bot’s OWN severity badge differs from ours, in either direction. A row the bot left unbadged is NOT a disagreement — silence is not a claim — so those are excluded.',
  },
  over: {
    label: 'Bot called it worse',
    title:
      'Only rows the bot badged MORE severe than our model rated them (the grid’s upper-right triangle) — the shape of an over-eager reviewer.',
  },
  under: {
    label: 'Bot called it milder',
    title:
      'Only rows the bot badged LESS severe than our model rated them (the grid’s lower-left triangle) — the ones a nit-filter would silently drop.',
  },
};

function Skeleton(): JSX.Element {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
      ))}
    </div>
  );
}

// ── The population picker ─────────────────────────────────────────────────────────────────────
// The reader arrives here on ONE tile — "High severity", "Nits", "Top topic", a category chip —
// but their next question is almost never that same tile again. It is "…and the criticals?" or
// "…and what about security?". Without this control the answer is: close the tab, scroll back to
// the strip, find the chip, click it. The dropdown makes the drill-down re-point ITSELF.
//
// WHICH dropdown is decided by `isSeverityFamily` / `isCategoryFamily` — deliberately NOT a local
// `selector.kind === 'category'` test, which reads correctly and then swaps the control out from
// under the cursor the moment someone picks Praise (a `category` selector that belongs to the
// SEVERITY picker). The two predicates are disjoint and total over the arms the pickers own; see
// their docblocks. `findings` / `summaries` / `overlap` are in neither family and render NO
// dropdown at all rather than an empty one.
//
// ⚠ THE SELECTOR IS NOT LOCAL STATE. It is written straight back to the store seed, because the
// PINNED TAB'S CHIP derives its label from that very seed (PinnedTabsBar → selectorLabel). A local
// override would leave the chip naming the tile the reader has since navigated away from — the tab
// reading "Nits" over a page showing Security is worse than no label at all.
function PopulationPicker({
  workspaceId,
  repoIds,
  window,
  selector,
  onPick,
}: {
  workspaceId: number | null;
  // ⚠ THE SAME TRIPLE THE PAGE ITSELF IS MEASURED AT — workspace, repo narrowing, window. These
  // three ARE the `useBotAnalytics` cache key, so in the normal flow (arriving from the strip) the
  // option counts are already resident and this costs NO request; and the numbers they show are
  // the tiles' own, not a second opinion about the same window.
  repoIds: number[] | null;
  window: BotWindowKind;
  selector: BotFlaggingSelector;
  onPick: (s: BotFlaggingSelector) => void;
}): JSX.Element | null {
  const family = isSeverityFamily(selector)
    ? 'severity'
    : isCategoryFamily(selector)
      ? 'topic'
      : null;
  // Gated on the family so the two arms that render no dropdown never fetch. `enabled: false` still
  // serves a cached entry, which is all this needs anyway.
  const { data } = useBotAnalytics(workspaceId, window, family != null, repoIds);
  const ml = data?.ml;

  // The option lists, counts folded in. Built here rather than at each `<option>` so a background
  // refetch of the analytics query is the ONLY thing that rebuilds them — `selectorLabel` allocates
  // a selector per call, and this component re-renders with the whole page.
  //
  // ⚠ THE LABEL IS `selectorLabel(...).title` — the SAME function that titles the h2 below. Picking
  // an option therefore always lands on a heading that reads exactly like the option that was
  // clicked ("Nits", "High severity", "Praise"), which a hand-written option list drifts away from
  // the first time either name is edited.
  const options = useMemo(() => {
    // Absent analytics ⇒ label the options with no counts at all. NEVER hide or disable an option
    // waiting for a number: the list is the navigation, the counts are a bonus on top of it.
    const withCount = (s: BotFlaggingSelector, count: number | null): string => {
      const { title } = selectorLabel(s);
      return count == null ? title : `${title} · ${count.toLocaleString()}`;
    };
    const byCategory = new Map((ml?.byCategory ?? []).map((c) => [c.category, c.count]));
    const severity = SEVERITY_PICKS.map((pick) => {
      const s = severityPickToSelector(pick);
      // `high` is the major+critical PAIR the product reads together, so its count is their sum —
      // the same arithmetic the High-severity tile does. `praise` is the non-finding class and has
      // its own top-level count; it is NOT in `bySeverity`, which is findings-only by contract.
      const count =
        ml == null
          ? null
          : pick === 'high'
            ? ml.bySeverity.major + ml.bySeverity.critical
            : pick === 'praise'
              ? ml.praise
              : ml.bySeverity[pick];
      return { value: pick, label: withCount(s, count) };
    });
    // A topic with no findings this window stays SELECTABLE and reads `· 0`. Confirming a topic is
    // empty is a real question ("did anything security-flavoured land this sprint?"), and an option
    // that vanishes at zero answers it by looking like a missing feature.
    const topic = TOPIC_PICKS.map((category) => ({
      value: category,
      label: withCount(
        { kind: 'category', category },
        ml == null ? null : (byCategory.get(category) ?? 0),
      ),
    }));
    return { severity, topic };
  }, [ml]);

  if (family === null) return null;

  // Same chrome as the other Activity drill-downs' selects (BotThreadsDetail / BotOnlyPrsDetail),
  // sized to sit level with the window picker beside it.
  const cls =
    'rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-900';

  if (family === 'severity') {
    // Non-null by `isSeverityFamily` — that predicate IS `severityPickOf(s) !== null`.
    const current = severityPickOf(selector);
    return (
      <select
        value={current ?? ''}
        onChange={(e) => {
          // Read the pick back OUT of the option list rather than casting the raw string: an
          // unrecognised value is then a no-op instead of a selector shape the server can't answer.
          const pick = SEVERITY_PICKS.find((p: SeverityPick) => p === e.target.value);
          if (pick) onPick(severityPickToSelector(pick));
        }}
        className={cls}
        // A <select>'s accessible name is not its selected option, and there is no visible label in
        // this row — so it needs one here. (aria-label on a plain form control, NOT on a button
        // whose visible text carries the numbers; that is the other rule, elsewhere.)
        aria-label="Severity"
        title="Show a different severity over the same window and scope. The counts are the strip’s own numbers."
      >
        {options.severity.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <select
      // Narrowed by `isCategoryFamily`, which is the only way to reach this branch.
      value={selector.kind === 'category' ? selector.category : ''}
      onChange={(e) => {
        const category = TOPIC_PICKS.find((c: MlCategory) => c === e.target.value);
        if (category) onPick({ kind: 'category', category });
      }}
      className={cls}
      aria-label="Topic"
      title="Show a different topic over the same window and scope. Categories are multi-label, so these counts overlap."
    >
      {options.topic.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function BotFlaggingDetail(): JSX.Element {
  // The tile/chip this tab was opened on. READ, NEVER CONSUMED — it has to survive the tab's whole
  // lifetime (the header, the query and the tab chip all read it), so there is no `consume…`
  // counterpart the way the bot-PRs focus key has one. The next open overwrites it.
  const seed = useFilters((s) => s.botFlaggingSeed);
  const workspaceId = useFilters((s) => s.workspaceId);
  // The window is the SHARED transient store field, written by this picker and by the Bots rail's.
  // Never a local copy — see WINDOWS above.
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  // The repo the strip was measured at (per-repo Bots tab); null on the cross-repo Bots rail.
  const seedRepoId = seed?.repoId ?? null;
  const repoScope = useMemo(() => (seedRepoId != null ? [seedRepoId] : null), [seedRepoId]);
  const selector = seed?.selector ?? NO_SELECTOR;
  // The on-page pickers write the SEED, not local state — see PopulationPicker's note. A null seed
  // makes it a no-op in the store, which is also the only state in which no picker renders.
  const setSelector = useFilters((s) => s.setBotFlaggingSelector);

  // The two refinements. LOCAL to the tab (the seed, window and scope are shared), and both are
  // applied SERVER-side, because paging is — they ride the query key rather than filtering the
  // loaded rows, or "Load more" would page a population the caption doesn't describe.
  const [cell, setCell] = useState<SeverityAgreementCellRef | null>(null);
  const [disagree, setDisagree] = useState<VendorDisagreeDirection | null>(null);
  const refine = useMemo(() => ({ cell, disagree }), [cell, disagree]);

  // ⚠ THE RESET, and it is load-bearing. This tab is a SINGLETON re-seeded in place, so without
  // this effect clicking "Nits" while "Critical + disagreements only" is active would open a list
  // filtered to nothing and read as a broken screen. The window picker, a header workspace switch
  // and a re-open from another repo re-key the query the same way, also without remounting.
  //
  // It resets LOCAL state only — never the store seed. A corrective write to `botFlaggingSeed`
  // would forget which tile the tab is showing, and the chip's label with it.
  useEffect(() => {
    setCell(null);
    setDisagree(null);
  }, [seed, window, workspaceId, repoScope]);

  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const { data: repos } = useRepos();
  const repoName = useMemo(() => {
    if (seedRepoId == null) return null;
    return (repos ?? []).find((r) => r.id === seedRepoId)?.fullName ?? `repo ${seedRepoId}`;
  }, [repos, seedRepoId]);
  // ONE call for the whole screen — a bot's colour belongs to the SCREEN, not to a row (the cards
  // take the resolver as a prop and issue no queries of their own). Memoised by the hook, so the
  // cards' comparators keep skipping markdown re-parses.
  const botColor = useBotColors(workspaceId);

  const {
    items,
    total,
    filteredTotal,
    matrix,
    truncated,
    isLoading,
    hasMore,
    fetchMore,
    isFetchingMore,
  } = useBotFlagging({
    workspaceId,
    repoIds: repoScope,
    window,
    selector,
    refine,
    enabled: seed != null,
  });

  // ⚠ DERIVED FOR THE RENDER, NEVER WRITTEN BACK. When the population carries no vendor badge at
  // all (`declared === 0` — the common case, since most bots badge nothing) there is nothing to
  // compare, so the disagreement control suppresses ITSELF. A `setDisagree(null)` here instead
  // would permanently forget a choice the user made under a window where it did apply.
  //
  // Note the gate is "positively known to have badges", and the reset effect above already
  // guarantees a filter cannot survive into a different population — so `disagree != null` here is
  // belt-and-braces: if one ever did, the control stays visible rather than becoming an
  // unclearable filter.
  const canCompare = matrix != null && matrix.declared > 0;
  const showDisagree = canCompare || disagree != null;
  const refined = cell != null || disagree != null;
  const clearRefine = useCallback((): void => {
    setCell(null);
    setDisagree(null);
  }, []);
  const cycleDisagree = useCallback((): void => {
    setDisagree((cur) => DISAGREE_CYCLE[(DISAGREE_CYCLE.indexOf(cur) + 1) % DISAGREE_CYCLE.length] ?? null);
  }, []);

  // Re-point the tab at another population. The refinements are cleared IN THE SAME EVENT as the
  // seed write, exactly like the window picker's handler and for the same reason: the reset effect
  // above is post-commit, so on its own the render between the two would key the query on
  // (NEW selector × OLD refine) and fire a full extra `search`-tier request whose response is
  // thrown away unrendered. Batched, a re-point costs exactly one fetch.
  //
  // The effect still fires — `setBotFlaggingSelector` replaces the seed OBJECT, so its identity
  // changes — and that is wanted, not redundant: a matrix cell chosen under "critical" means
  // nothing under "nit". This handler only makes the reset happen one render EARLIER.
  const onPickSelector = useCallback(
    (s: BotFlaggingSelector): void => {
      setCell(null);
      setDisagree(null);
      setSelector(s);
    },
    [setSelector],
  );

  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);
  // ONE handler pair for both card types — `BotFlaggedPrRef` is the structural shape a comment row
  // and a cluster header both satisfy. Memoised because the cards' `memo` comparators compare
  // callback identity: a fresh closure per render would re-parse every visible markdown body on
  // every scroll tick.
  const metaOf = useCallback(
    (ref: BotFlaggedPrRef): TabMeta => {
      const u = ref.prAuthorId != null ? usersById.get(ref.prAuthorId) : undefined;
      return {
        id: ref.prId,
        number: ref.prNumber,
        title: ref.prTitle,
        repoFullName: ref.repoFullName,
        authorLogin: u?.githubLogin ?? null,
        authorDisplayName: u?.displayName ?? null,
        authorAvatarUrl: u?.avatarUrl ?? null,
      };
    },
    [usersById],
  );
  const onOpenPr = useCallback(
    (ref: BotFlaggedPrRef): void => {
      openPrDetailTab(metaOf(ref), { fromActivity: true });
    },
    [metaOf, openPrDetailTab],
  );
  const onOpenThread = useCallback(
    (ref: BotFlaggedPrRef, threadId: number): void => {
      openPrDetailTab(metaOf(ref), { fromActivity: true });
      // Deep-link the thread inside the PR: `selectThread` clears any state-pill preset (so a
      // resolved thread is still reachable) and PrDetail forces its Threads tab and scrolls to it.
      selectThread(ref.prId, threadId);
    },
    [metaOf, openPrDetailTab, selectThread],
  );

  const loaded = items.items.length;
  // Only the ref is taken: the footer is gated on `hasMore` rather than on the hook's own
  // `showSentinel` — see the comment at the render site.
  const { sentinelRef } = useAutoLoadSentinel({
    hasMore,
    isFetchingMore,
    itemCount: loaded,
    loadMore: fetchMore,
  });

  const { title, subtitle } = selectorLabel(selector);
  const isClusters = items.kind === 'clusters';
  const noun = isClusters ? 'line areas' : 'comments';

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        {/* The BARE tile name — `selectorLabel` returns it unprefixed and PinnedTabsBar adds its
            own "Flagged ·", so the tab chip and this heading always name the same population. */}
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
        <span className="text-[11px] text-gray-400">What the bots are flagging</span>
        {repoName && (
          <span
            className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            title="This drill-down was opened from a single repo’s Bots tab, so it measures that repo — the same narrowing the tile you clicked was computed at."
          >
            {repoName}
          </span>
        )}
        {/* ONE control group, right-aligned: "which population" and "over what window" are the two
            questions this page's chrome answers, and they were asked for together. The picker
            renders only for the selectors it can name (see PopulationPicker), so on Findings /
            Walkthroughs / Same-line overlap this collapses back to the window picker alone.
            Deliberately rendered above the loading, empty and failure branches too — a dropdown
            that disappears the moment its population is empty is the one control that could have
            got the reader out of there. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PopulationPicker
            workspaceId={workspaceId}
            repoIds={repoScope}
            window={window}
            selector={selector}
            onPick={onPickSelector}
          />
          {/* Window picker — writes the SHARED store field (see WINDOWS above). */}
          <div className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
            {WINDOWS.map((wOpt) => (
              <button
                key={wOpt.key}
                type="button"
                // Clears the refinements IN THE SAME EVENT as the window write, not just via the
                // reset effect below. The effect is post-commit, so on its own the render between
                // the two would key the query on (new window × OLD refine) and fire a full extra
                // request — on the `search` tier, for a response that is thrown away unrendered.
                // Batched together, the window change costs exactly one fetch.
                onClick={() => {
                  setCell(null);
                  setDisagree(null);
                  setWindow(wOpt.key);
                }}
                className={`px-2 py-0.5 text-[11px] font-medium ${
                  window === wOpt.key
                    ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                    : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {wOpt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="max-w-4xl text-[11px] text-gray-500 dark:text-gray-400">{subtitle}</p>

      {seed == null ? (
        // Unreachable in practice — the tab is ephemeral (never persisted, never parsed back from a
        // tab key), so it cannot exist without the seed that opened it. Said plainly rather than
        // rendered as an empty list, which would read as "nothing was flagged".
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Open this from a tile on the Bots rail to see what it counted.
        </div>
      ) : workspaceId == null || isLoading ? (
        // `workspaceId === null` is "not resolved yet", never "every workspace" — nothing
        // workspace-scoped may render against it.
        <Skeleton />
      ) : total == null || filteredTotal == null ? (
        // No page landed. The infinite query surfaces no error flag of its own, so an absent
        // `total` once loading has settled IS the failure state — and it must not be dressed up as
        // an empty result, which would claim these bots said nothing.
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Couldn’t load what the bots flagged in this window.
        </div>
      ) : (
        <>
          {/* Pre-refine facets: the grid describes the whole selector population, so clicking a
              cell never zeroes the cell it was clicked on. */}
          <SeverityAgreementMatrixView matrix={matrix} cell={cell} onSelectCell={setCell} />
          {isClusters && matrix != null && matrix.total > 0 && (
            // ⚠ On the overlap selector the grid folds the CLUSTERS' member comments, not the
            // clusters — a cluster is not an ML row. Its total is therefore unrelated to the list's
            // count and must never be read as its denominator.
            <p className="text-[11px] text-gray-400">
              Those counts are the bot comments inside these line areas, not the areas themselves —
              one overlap contributes a row per bot.
            </p>
          )}

          {/* Controls. The disagreement filter hides itself when the population carries no vendor
              badge at all: a control whose only possible answer is an empty list reads as broken,
              and this codebase has paid for that lesson once already. */}
          {(showDisagree || refined) && (
            <div className="flex flex-wrap items-center gap-2">
              {showDisagree && (
                <button
                  type="button"
                  onClick={cycleDisagree}
                  aria-pressed={disagree != null}
                  title={
                    disagree
                      ? `${DISAGREE_LABEL[disagree].title} Click to step to the next direction.`
                      : 'Narrow to rows where the bot’s own severity badge contradicts ours. Click again to step through over-calls and under-calls.'
                  }
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    disagree != null
                      ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/30 dark:text-amber-300'
                      : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                  }`}
                >
                  <span aria-hidden="true">⚖</span>
                  {disagree ? DISAGREE_LABEL[disagree].label : 'Disagreements only'}
                </button>
              )}
              {cell && (
                <span
                  className="rounded-full border border-sky-400 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300"
                  title="One cell of the grid above. Click that cell again to clear it."
                >
                  bot said {cell.vendor === 'none' ? 'nothing' : cell.vendor} · we scored{' '}
                  {cell.ours}
                </span>
              )}
              {refined && (
                <button
                  type="button"
                  onClick={clearRefine}
                  className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 underline-offset-2 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {truncated && (
            // The same honesty rule the strip's own scan cap follows: say that the numbers are a
            // most-recent sample rather than quietly presenting a capped count as the whole window.
            <div className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
              More matched this window than one read covers — the counts and the grid above describe
              the most recent sample, not the whole window.
            </div>
          )}

          {filteredTotal === 0 ? (
            // TWO DISTINCT EMPTY STATES. "Nothing matched your filters" without a way out reads as
            // a broken list; "nothing was flagged" must NOT offer to clear a filter that isn't on.
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              {refined ? (
                <>
                  None of these {total.toLocaleString()} {noun} match the filters you’ve applied.
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={clearRefine}
                      className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-500"
                    >
                      Clear filters
                    </button>
                  </div>
                </>
              ) : (
                <>
                  Nothing was flagged here in this window.
                  <div className="mt-1 text-[11px]">
                    {isClusters
                      ? 'No two review bots landed within a few lines of each other — either only one bot is reviewing, or they’re looking at different things.'
                      : 'Either the bots said nothing that fits, or their comments haven’t been scored yet — the enrichment pass always FOLLOWS the sync that stored them.'}
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {items.kind === 'clusters' ? (
                <div className="space-y-3">
                  {items.items.map((cl) => (
                    <BotClusterCard
                      key={cl.clusterId}
                      cluster={cl}
                      usersById={usersById}
                      botColor={botColor}
                      onOpenPr={onOpenPr}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {items.items.map((c) => (
                    // ⚠ `targetId` lives in three id spaces — the key must carry the kind.
                    <BotCommentCard
                      key={flaggedCommentKey(c)}
                      c={c}
                      usersById={usersById}
                      botColor={botColor}
                      onOpenPr={onOpenPr}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                </div>
              )}

              {/* NEVER A BARE COUNT. Three different numbers live here — how many are on screen,
                  how many survive the filters, and the SELECTOR population, which is the tile's own
                  number. "412 comments" under a filtered list would claim the third while showing
                  the first. */}
              <div
                className="text-[11px] tabular-nums text-gray-400"
                title={`The ${total.toLocaleString()} figure is the tile you clicked, recomputed from the same windowed scan and the same fold — not a separate query.`}
              >
                Showing {loaded.toLocaleString()} of {filteredTotal.toLocaleString()} {noun}
                {refined && (
                  <>
                    {' · '}
                    {filteredTotal.toLocaleString()} of {total.toLocaleString()} match these filters
                  </>
                )}
              </div>

              {/* Auto-load. The sentinel is the LAST element in the overlay's scroll pane, so the
                  observer roots on the pane the list actually scrolls in (see lib/scrollParent.ts);
                  the button stays as the manual fallback for when the observer can't fire.
                  ⚠ Gated on `hasMore`, NOT on the hook's `showSentinel` (which additionally requires
                  a non-empty list): the server counts a row whose parent PR it couldn't hydrate but
                  drops it from `items`, so a page CAN render zero cards with further pages behind
                  it. Without the button that list is a dead end with no affordance at all. The ref
                  rides along either way — the observer simply does nothing until there are rows,
                  which is what the hook's own guard already says. */}
              {hasMore && (
                <div ref={sentinelRef} className="flex justify-center pt-1">
                  {isFetchingMore ? (
                    <span className="flex items-center gap-2 py-1.5 text-xs text-gray-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-transparent dark:border-gray-600 dark:border-t-transparent" />
                      Loading more…
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={fetchMore}
                      className="rounded-full border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-800/50"
                    >
                      Load more
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
