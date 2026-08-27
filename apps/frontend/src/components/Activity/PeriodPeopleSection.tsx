import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AutomatedReviewerKind, ReviewerRole, User, WorkspaceReviewer } from '@pierre-review/shared';
import { useFilters, type PeopleReportSelection } from '../../store/filters.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { buildMemberSections } from '../../hooks/useMemberSections.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useDetectedReviewers } from '../../hooks/useBotTriage.js';
import { useMergers, useRepos, useRosterTimeline, useUsers } from '../../hooks/useTimeline.js';
import { useProCapabilities, useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { useWorkspaces, workspaceRepoIds } from '../../hooks/useWorkspaces.js';
import { usePeriodReportsList } from '../../hooks/usePeriodReports.js';
import { beginDisabledReason, orderSelections } from '../../lib/peopleReport.js';
import { automatedReviewerMeta, userLabel } from '../../lib/ui.js';
import { CloseIcon, PersonIcon } from '../Icons.js';
import { MaintainerShield, MemberSectionList } from '../UserSelectPanel.js';

// The Reports "People" section (plan P4.2, reworked for the People report): a PICKER — a text
// field opening the Members-dropdown content inline, multi-select people AND bots committed
// straight to removable chips, and a "Begin report" button that opens the people-report tab for
// the period selected above (`insightsReportKey`).
//
// PREP, NOT SCORING (the surviving non-negotiable): the picker builds ONE report with a
// SECTION per selection — that multi-select is sanctioned. What this section must never
// become is a scoreboard: rows and chips are ALPHABETICAL and carry NO metrics, report
// sections are ALPHABETICAL (never metric-sorted), and no surface reached from here may
// rank people, sort them by any figure, or lay two people's numbers side by side in one
// table. If a metric column ever seems like a good idea here, it isn't.
//
// MEMBERSHIP IS WORKSPACE-SCOPED — the all-workspaces bug dies here. The member sections come
// from the ONE extracted builder (buildMemberSections) with `inScopeRepoIds` = the WHOLE active
// workspace's membership and `includeRosterRemainder: false`, so nobody outside this
// workspace's repos can appear (the old roster-minus-bots list showed every workspace's humans
// under every workspace's Reports pane). The bot verdict is the UNION predicate (workspace
// `automated` ∪ users.isBot, a manual "human" winning both ways — the Feed rule); bots are
// pickable from their own flat section built from the detected-reviewers listing (the union
// truth — comment-only reviewers included, the bot-settings-comment-only lesson), never from a
// login heuristic. The server stays the final word anyway: a stranger's section renders the
// report's own null state (core getPersonPeriod resolves lanes).

// Short per-role suffix for a bot row — what the automation DOES, next to its vendor name.
const ROLE_SHORT: Record<ReviewerRole, string> = {
  review: 'reviewer',
  quality_check: 'quality check',
  dependency: 'dependency bot',
  code_agent: 'code agent',
  release: 'release automation',
  housekeeping: 'housekeeping',
};

/** How many maintainer shortcut pills the row above the search box may carry. */
const MAINTAINER_PILL_CAP = 10;

/** Breathing room left between the panel and the edge of the pane that clips it. */
const PANEL_GUTTER = 8;
/**
 * Never collapse the panel to a useless sliver: below this we keep the height and let the panel
 * overhang rather than render a two-row list nobody can search in. A pane this short is already
 * a degenerate layout, and an overhanging panel is still usable where a 40px one is not.
 */
const PANEL_MIN = 180;

/** A bot's colour-resolver input — null vendor kind degrades to the unbranded bucket, exactly
 *  as useBotColors treats a kind-less reviewer (neutral until a palette hue exists). */
function botColorKeyOf(r: WorkspaceReviewer): { login: string | null; kind: AutomatedReviewerKind } {
  return { login: r.login, kind: r.kind ?? 'in_house' };
}

export function PeriodPeopleSection(): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const reportKey = useFilters((s) => s.insightsReportKey);
  const openPeopleReport = useFilters((s) => s.openPeopleReport);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const { data: mergers } = useMergers();
  const { data: detected } = useDetectedReviewers(workspaceId);
  const botColor = useBotColors(workspaceId);

  // The periods list — the SAME query the Reports panel holds (shared cache entry); "Begin
  // report" needs the selected key to actually resolve in it before a tab can be seeded.
  const list = usePeriodReportsList(periodReports, workspaceId);
  const periods = list.data?.periods ?? [];
  // The period the roster is read over — DERIVED, never written back (D7: the Reports panel owns
  // `insightsReportKey` and seats it; a scalar may legitimately hold a key this list no longer
  // carries). Falls back to the newest listed period so the picker is populated on first paint.
  const rosterWindow = useMemo(() => {
    const all = list.data?.periods ?? [];
    const p = all.find((x) => x.periodKey === reportKey) ?? all[0] ?? null;
    if (p == null) return null;
    const fromMs = Date.parse(p.periodStart);
    const toMs = Date.parse(p.periodEnd);
    return Number.isFinite(fromMs) && Number.isFinite(toMs) ? { fromMs, toMs } : null;
  }, [list.data, reportKey]);

  // Member-AGNOSTIC window activity, WORKSPACE-WIDE over the reported period. Deliberately NOT
  // the Timeline board's spellings (useSearchTimeline / useSearchOpenPrs): both carry the repo
  // picker's narrowing, and the timeline one also carries the board's Range preset — neither
  // control is mounted on this pane, so they would narrow the roster with no visible cause.
  const { data: searchTimeline } = useRosterTimeline(rosterWindow);
  const { data: searchOpenPrs } = useWorkspaceOpenPrs();

  // The staged report subjects. Chips ARE the visible staged state (no staged/Apply pair — the
  // toolbar dropdown keeps Apply because its commit refetches boards; this costs nothing until
  // "Begin report"). Local state, alphabetised at render; the seed is written only on Begin.
  const [chips, setChips] = useState<PeopleReportSelection[]>([]);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  // Per-section "show more" reveal state — MemberSectionList's collapse, owned here so the
  // inline panel keeps its reveal while chips change. Deliberately NOT reset on close (the
  // toolbar dropdown's openPanel() does reset it): staging a report is a repeated open/close
  // over the same long list, and re-collapsing every section each time is the wrong default.
  const [shownOthers, setShownOthers] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // Where the upward panel may actually be drawn. The picker sits inside a scroll pane, so
  // `bottom-full` alone runs the panel off the top of that pane whenever the report above it is
  // short (an ungenerated period is only a few rows tall) — the list's first repo section then
  // scrolls under the pinned-tab bar and cannot be reached. We measure the gap to the nearest
  // scrolling ancestor and cap the panel to it, flipping DOWN when up has less room than down.
  const [place, setPlace] = useState<{ dir: 'up' | 'down'; max: number }>({ dir: 'up', max: 0 });

  // Escape / click-outside close the inline panel; chips persist (they live outside it).
  // Escape must stopPropagation — the global useKeyboard handler would clearSelection().
  useClickOutside(rootRef, () => setOpen(false), open);

  // Measure while the panel is open: on open, on resize, and on any ancestor scroll (capture,
  // so it fires for the inner pane too). Cheap — two getBoundingClientRect calls per event.
  useEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const row = rowRef.current;
      if (row == null) return;
      const r = row.getBoundingClientRect();
      let el: HTMLElement | null = row.parentElement;
      let clipTop = 0;
      let clipBottom = window.innerHeight;
      while (el != null && el !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          const c = el.getBoundingClientRect();
          clipTop = Math.max(clipTop, c.top);
          clipBottom = Math.min(clipBottom, c.bottom);
          break;
        }
        el = el.parentElement;
      }
      const above = r.top - clipTop - PANEL_GUTTER;
      const below = clipBottom - r.bottom - PANEL_GUTTER;
      // Up is the default and stays the default on a tie — only a genuinely roomier below flips it.
      const dir = above >= below ? 'up' : 'down';
      setPlace({ dir, max: Math.max(PANEL_MIN, Math.floor(dir === 'up' ? above : below)) });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The UNION bot verdict (workspace `automated` ∪ users.isBot; a manual "human" beats the
  // global flag) — partitions the roster: whatever it rejects from the member sections is
  // exactly what the Bots section below may hold.
  const isUnionBot = useMemo(() => {
    const reviewerByUserId = new Map(
      (detected?.reviewers ?? []).map((r) => [r.userId, r] as const),
    );
    return (u: User): boolean => {
      const r = reviewerByUserId.get(u.id);
      if (r != null) {
        if (r.automated) return true;
        if (r.isManualOverride) return false;
      }
      return u.isBot;
    };
  }, [detected]);

  const chippedIds = useMemo(() => new Set(chips.map((c) => c.userId)), [chips]);

  // The WHOLE active workspace's membership — the ONE scope every fold below reads (never
  // `f.repoIds`: the repo picker is Timeline-only, and Reports always covers every repo in the
  // workspace).
  const inScopeRepoIds = useMemo(
    () => new Set(workspaceRepoIds(workspaceId, workspaces ?? [])),
    [workspaceId, workspaces],
  );

  // The member sections — the ONE extracted builder at that scope.
  // `includeRosterRemainder: false` + the chip ids as `selectedIds`, so a picked member with no
  // window activity keeps a visible "Other" row while the account-wide remainder cannot appear
  // at all.
  const { sections, maintainerIds } = useMemo(
    () =>
      buildMemberSections({
        users,
        repos,
        searchTimeline,
        searchOpenPrs,
        mergers,
        inScopeRepoIds,
        repoScoped: false,
        selectedIds: [...chippedIds],
        allowedBotIds: [],
        isBot: isUnionBot,
        includeRosterRemainder: false,
      }),
    [users, repos, searchTimeline, searchOpenPrs, mergers, inScopeRepoIds, chippedIds, isUnionBot],
  );

  // The pickable BOTS — one flat alphabetical section from the detected-reviewers listing's
  // automated rows (the union truth), each row showing its vendor/role. NOT the builder's
  // `users.isBot`-only botSections: a comment-only reviewer has no isBot flag and would vanish.
  const botRows = useMemo(
    () =>
      (detected?.reviewers ?? [])
        .filter((r) => r.automated)
        .sort((a, b) => a.label.localeCompare(b.label) || a.userId - b.userId),
    [detected],
  );

  const byUserId = useMemo(() => new Map((users ?? []).map((u) => [u.id, u] as const)), [users]);

  // The maintainer shortcut pills — the workspace's maintainers as one-click checkboxes above the
  // search box, so the common case (a 1:1 round with the people who hold merge rights) doesn't
  // need the dropdown at all. Humans only: a bot cannot hold merge rights under the maintainer
  // definition (`buildMemberSections` filters them out), so there is no bot half here.
  //
  // NOT A LEADERBOARD — the distinction the guardrail above turns on. The cut to ten is made on
  // repo BREADTH (how many of the workspace's repos grant this person merge rights), which is a
  // fact about RIGHTS, not about output, and it NEVER REACHES THE SCREEN: after the cut the row is
  // re-sorted ALPHABETICALLY (the orderSelections idiom) and renders no number, no count and no
  // breadth figure. The breadth is a selection input only. Do not "fix" this into a sorted strip
  // with an N beside each name — that is the scoreboard this feature exists not to be.
  //
  // ⚠ The order must be TOTAL before the slice. `maintainerIds` iterates in the `mergers` payload's
  // order, which is `getMergers`' selectDistinct with NO `ORDER BY` — server heap order, and heap
  // order flips after any UPDATE on Postgres. A bare `.slice(0, 10)` would hand a different ten to
  // local and to cloud, and a different ten to the same user after a sync.
  const maintainerPills = useMemo(() => {
    if (maintainerIds.size === 0) return [];
    const breadth = new Map<number, number>();
    for (const m of mergers ?? []) {
      if (!inScopeRepoIds.has(m.repoId)) continue;
      for (const uid of m.userIds) {
        if (!maintainerIds.has(uid)) continue;
        breadth.set(uid, (breadth.get(uid) ?? 0) + 1);
      }
    }
    return [...maintainerIds]
      .map((id) => byUserId.get(id))
      .filter((u): u is User => u != null)
      .map((user) => ({ user, label: userLabel(user, user.id), breadth: breadth.get(user.id) ?? 0 }))
      .sort(
        (a, b) => b.breadth - a.breadth || a.label.localeCompare(b.label) || a.user.id - b.user.id,
      )
      .slice(0, MAINTAINER_PILL_CAP)
      .sort((a, b) => a.label.localeCompare(b.label) || a.user.id - b.user.id);
  }, [maintainerIds, mergers, inScopeRepoIds, byUserId]);

  if (workspaceId == null) return null;

  const selectionOfUser = (u: User): PeopleReportSelection => ({
    kind: 'human',
    userId: u.id,
    login: u.githubLogin,
    label: userLabel(u, u.id),
    avatarUrl: u.avatarUrl,
  });
  const selectionOfBot = (r: WorkspaceReviewer): PeopleReportSelection => ({
    kind: 'bot',
    userId: r.userId,
    login: r.login,
    label: r.label,
    avatarUrl: r.avatarUrl,
  });

  const removeChip = (userId: number): void =>
    setChips((prev) => prev.filter((c) => c.userId !== userId));
  const addChip = (sel: PeopleReportSelection): void =>
    setChips((prev) => (prev.some((c) => c.userId === sel.userId) ? prev : [...prev, sel]));
  // Toggling a checked row un-chips it (member rows resolve through the roster; the row could
  // only be checked because a chip carries its id).
  const toggleMemberId = (id: number): void => {
    if (chippedIds.has(id)) {
      removeChip(id);
      return;
    }
    const u = byUserId.get(id);
    if (u) addChip(selectionOfUser(u));
  };
  // The per-section all/none + the Maintainers quick-select (same toggleMany mechanics as the
  // dropdown — on stages everyone shown, off un-chips them).
  const toggleManyMembers = (ids: number[], on: boolean): void => {
    if (!on) {
      setChips((prev) => prev.filter((c) => !ids.includes(c.userId)));
      return;
    }
    setChips((prev) => {
      const have = new Set(prev.map((c) => c.userId));
      const added = ids
        .filter((id) => !have.has(id))
        .map((id) => byUserId.get(id))
        .filter((u): u is User => u != null)
        .map(selectionOfUser);
      return added.length ? [...prev, ...added] : prev;
    });
  };

  const q = filter.trim().toLowerCase();
  // Bot rows narrow on classification label + login — the "same matches() rule" with the label
  // standing in for a display name.
  const visibleBotRows = botRows.filter(
    (r) => !q || r.label.toLowerCase().includes(q) || r.login.toLowerCase().includes(q),
  );

  // "Begin report" preconditions, each named when missing (the button explains itself;
  // the rule is the tested fold in lib/peopleReport.ts).
  const disabledReason = beginDisabledReason({
    chipCount: chips.length,
    reportKey,
    periodKeys: periods.map((p) => p.periodKey),
    listLoading: list.isLoading,
  });
  const canBegin = disabledReason == null;
  const beginTitle =
    disabledReason ??
    'Open the People report for the period selected above — one section per person or bot, alphabetical';

  const orderedChips = orderSelections(chips);

  return (
    // Screen affordance, not part of the forwardable/printed artifact.
    <section aria-label="People" className="print:hidden" ref={rootRef}>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          People
        </span>
        <span className="text-[11px] text-gray-400">
          prep for 1:1s, not a scorecard — sections alphabetical, no rankings
        </span>
      </div>

      {/* Chips — the staged selections. ALPHABETICAL by label, humans and bots interleaved
          (never click order, never kind-grouped: the order previews the report's). */}
      {orderedChips.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {orderedChips.map((c) => (
            <span
              key={c.userId}
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 py-0.5 pl-1.5 pr-1 text-[11px] text-gray-700 dark:border-gray-700 dark:text-gray-200"
            >
              {c.kind === 'bot' ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: botColor({ login: c.login, kind: 'in_house' }) }}
                />
              ) : c.avatarUrl != null ? (
                <img
                  src={c.avatarUrl}
                  width={14}
                  height={14}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-3.5 w-3.5 shrink-0 rounded-full bg-gray-200 dark:bg-gray-800"
                />
              ) : (
                <PersonIcon size={14} className="shrink-0" />
              )}
              <span className="max-w-[12rem] truncate" title={c.login ?? c.label}>
                {c.label}
              </span>
              <button
                type="button"
                onClick={() => removeChip(c.userId)}
                aria-label={`Remove ${c.label} from the report`}
                className="rounded px-0.5 opacity-60 hover:opacity-100"
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* The maintainer shortcut row — DEFAULT-VISIBLE, DEFAULT-UNCHECKED. They must never arrive
          checked: each checked chip is a separately BILLED narrative generation when Begin runs,
          so a pre-selected row would spend credits on a page load. The panel's "Maintainers ·
          select all" stays the all/none; these are the shortcut to individuals. */}
      {maintainerPills.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {maintainerPills.map(({ user, label }) => {
            const checked = chippedIds.has(user.id);
            return (
              <label
                key={user.id}
                title={
                  checked ? `Remove ${label} from the report` : `Add ${label} to the report`
                }
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2 text-[11px] transition ${
                  checked
                    ? 'border-[#8957e5]/50 bg-[#8957e5]/15 text-[#8957e5]'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleMemberId(user.id)}
                  className="h-3 w-3"
                />
                <MaintainerShield />
                <span className="max-w-[10rem] truncate">{label}</span>
              </label>
            );
          })}
        </div>
      )}

      {/* The text field and "Begin report" on ONE row, with the Members-panel content opening
          UPWARD out of it. The picker is the last thing in a long report inside a scroll pane, so
          a downward in-flow panel pushed the field itself — and the button under it — down the
          page every time it opened. `relative` sits HERE, inside the click-outside root, so the
          panel still dismisses on an outside pointerdown. */}
      <div className="relative">
        <div ref={rowRef} className="flex max-w-md items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Add people or bots…"
            aria-label="Add people or bots to the report"
            className="flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 text-xs focus:border-ai-signal/60 focus:outline-none dark:border-gray-700"
          />
          <button
            type="button"
            disabled={!canBegin}
            onClick={() => {
              // `workspaceId` is non-null here (the early return above) — it is pinned into the
              // seed so a later workspace switch cannot re-scope the open report silently.
              if (reportKey != null) openPeopleReport(workspaceId, reportKey, chips);
            }}
            title={beginTitle}
            className="shrink-0 rounded border border-ai-border px-2.5 py-1 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Begin report{chips.length > 0 ? ` (${chips.length})` : ''}
          </button>
        </div>

        {open && (
          <div
            style={{ maxHeight: place.max }}
            className={`absolute left-0 z-30 flex w-full max-w-md flex-col rounded border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-800 dark:bg-gray-900 ${
              place.dir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            {maintainerIds.size > 0 &&
              (() => {
                // Maintainers quick-select — stages every maintainer as chips (toggles off
                // again once they're all chipped), same mechanics as the dropdown's. It lives in
                // the padded SHELL, not the scroller below, or it slides up under the pinned repo
                // names as the list scrolls (the toolbar dropdown's shape).
                const ids = [...maintainerIds];
                const allChecked = ids.every((id) => chippedIds.has(id));
                return (
                  <button
                    type="button"
                    onClick={() => toggleManyMembers(ids, !allChecked)}
                    title="Add every maintainer in this workspace to the report"
                    className={`mb-1 flex w-full shrink-0 items-center gap-2 rounded px-2 py-1 text-xs transition ${
                      allChecked
                        ? 'bg-[#8957e5]/15 text-[#8957e5]'
                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    <MaintainerShield />
                    <span className="font-medium">Maintainers</span>
                    <span className="text-gray-400">({ids.length})</span>
                    <span className="ml-auto text-[10px] text-gray-400">
                      {allChecked ? 'clear' : 'select all'}
                    </span>
                  </button>
                );
              })()}

            {/* ⚠ The SCROLLER CARRIES NO PADDING, and that is the whole fix for the band under
                the pinned repo names: Chromium clamps `sticky; top: 0` to the scroll container's
                CONTENT box, so `p-1.5` on the scrolling element pinned every header 6px below the
                panel's inner edge with rows visibly passing through the gap. The padding belongs
                on the shell above. Do NOT instead give the header a negative `top`/`-mt` —
                MemberSectionList is SHARED with the toolbar Members dropdown, whose scroller has
                no padding and would gain a 6px overlap. */}
            <div className="max-h-72 min-h-0 flex-1 overflow-y-auto">
              {/* The reused Members-dropdown body — the builder's exact grouping and
                  maintainer-first order (that ordering IS the dropdown content being matched);
                  only the surfaces this picker OWNS are alphabetical. */}
              <MemberSectionList
                sections={sections}
                filter={filter}
                staged={chippedIds}
                onToggle={toggleMemberId}
                onToggleMany={toggleManyMembers}
                maintainerIds={maintainerIds}
                shownOthers={shownOthers}
                setShownOthers={setShownOthers}
              />

              {/* ONE flat Bots section — the union truth (detected reviewers), alphabetical by
                  label, vendor/role named per row. Humans are excluded by the same union predicate
                  that excluded bots above: the two cohorts partition. */}
              {visibleBotRows.length > 0 && (
                <div className="mt-1 border-t border-gray-200 pt-1 dark:border-gray-700">
                  <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-1 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800 dark:bg-gray-900">
                    Bots
                  </div>
                  {visibleBotRows.map((r) => {
                    const meta = r.kind != null ? automatedReviewerMeta(r.kind) : null;
                    const suffix = [meta?.label, ROLE_SHORT[r.role]]
                      .filter((s): s is string => s != null && s !== '')
                      .join(' · ');
                    return (
                      <label
                        key={r.userId}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <input
                          type="checkbox"
                          checked={chippedIds.has(r.userId)}
                          onChange={() =>
                            chippedIds.has(r.userId)
                              ? removeChip(r.userId)
                              : addChip(selectionOfBot(r))
                          }
                        />
                        <span
                          aria-hidden="true"
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: botColor(botColorKeyOf(r)) }}
                        />
                        <span className="min-w-0 truncate" title={r.login}>
                          {r.label}
                        </span>
                        {suffix && (
                          <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                            {suffix}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
