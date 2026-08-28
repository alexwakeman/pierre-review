import { useState } from 'react';
import type {
  BranchCheckRun,
  BranchMergedPr,
  BranchTrendsResponse,
  RepoBranchStatus,
} from '@pierre-review/shared';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useBranchTrends } from '../../hooks/useBranchTrends.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { trimTrailingPrRef } from '../../lib/prRef.js';
import { CHECK_STATE_META, CI_META, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { ChartCard, PALETTE } from '../charts/common.js';
import { DayStrip } from '../charts/DayStrip.js';
import { ChevronIcon } from '../Icons.js';
import { CiDot } from './BranchStatusChip.js';

// The GitHub URL for a PR: every segment is data, encoded, and run through safeExternalUrl
// before it can reach an href — the house rule for every data-derived URL, even one we
// assembled ourselves.
function prUrl(fullName: string | undefined, prNumber: number): string | undefined {
  if (!fullName) return undefined;
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return undefined;
  return safeExternalUrl(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${prNumber}`,
  );
}

// TabMeta for a listed merged PR. The title is the synced PR row's when we have it (`#N` as a
// placeholder otherwise); PrDetail backfills the rest of the chrome via usePinnedTabs.syncMeta
// once its detail query lands.
function prTabMeta(
  prId: number,
  prNumber: number,
  repoFullName: string,
  title?: string | null,
): TabMeta {
  return {
    id: prId,
    number: prNumber,
    title: title ?? `#${prNumber}`,
    repoFullName,
    authorLogin: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// The display label for one check. `workflowName` is null for a legacy StatusContext and for a
// non-Actions check suite, so the name stands alone there — nothing here may REQUIRE the workflow.
function checkLabel(check: BranchCheckRun): string {
  return check.workflowName != null ? `${check.workflowName} / ${check.name}` : check.name;
}

// One failing check, as a link when GitHub gave us a URL. CHECK_STATE_META is the SAME per-check
// vocabulary the PR checks UI uses — a trunk failure must not read as a different kind of object
// than a PR failure. The check's name is UNTRUSTED third-party text (whatever the CI vendor chose)
// so it is a plain text node, and `check.url` is third-party data (a StatusContext's targetUrl is
// whatever was posted), so it goes through safeExternalUrl.
function FailingCheck({ check }: { check: BranchCheckRun }): JSX.Element {
  const meta = CHECK_STATE_META[check.state];
  const href = safeExternalUrl(check.url);
  const label = checkLabel(check);
  const inner = (
    <span className="flex min-w-0 items-center gap-1">
      <span aria-hidden="true" style={{ color: meta.color }} className="flex shrink-0 items-center">
        <meta.icon size={11} />
      </span>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </span>
  );
  return href != null ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="min-w-0 text-red-600 hover:underline dark:text-red-400"
    >
      {inner}
    </a>
  ) : (
    <span className="min-w-0 text-red-600 dark:text-red-400">{inner}</span>
  );
}

// The repo row's inline summary: "· build +2". The leading CI label ("CI failing") is already
// rendered by the row, so this contributes the separator, the first failing check as a LINK, and a
// +N for the rest (the full list is in the tooltip, and behind the head commit's own caret).
function FailingSummary({ checks }: { checks: BranchCheckRun[] }): JSX.Element | null {
  // noUncheckedIndexedAccess: destructuring yields `BranchCheckRun | undefined`, so this guard is
  // required rather than defensive.
  const [first, ...rest] = checks;
  if (first == null) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-[11px]">
      <span aria-hidden="true" className="shrink-0 text-gray-300 dark:text-gray-600">
        ·
      </span>
      <FailingCheck check={first} />
      {rest.length > 0 && (
        <span className="shrink-0 text-gray-400" title={rest.map(checkLabel).join('\n')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

// How many consolidated commits the row's tooltip lists before eliding — a merge-commit PR can
// fold in dozens, and a native title has no scrollbar.
const PR_TIP_COMMITS = 20;

function PrRow({
  pr,
  fullName,
}: {
  pr: BranchMergedPr;
  fullName: string | undefined;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const avatar = safeExternalUrl(pr.authorAvatarUrl);
  // Narrowed LOCAL, not `pr.prId` inline: TS does not preserve property narrowing inside the
  // onClick closure.
  const prId = pr.prId;
  const prHref = prUrl(fullName, pr.prNumber);
  // Unresolved PR (not synced for this account): the newest consolidated commit's headline is
  // the best available stand-in for a title.
  const title = pr.title ?? pr.commits[0]?.messageHeadline ?? `#${pr.prNumber}`;
  // The consolidation, as the row's tooltip: sha + headline per trunk commit, newest first.
  // UNTRUSTED text — a `title` attribute renders as plain text, never HTML, which is the point.
  const tipLines = pr.commits
    .slice(0, PR_TIP_COMMITS)
    .map((c) => `${c.sha.slice(0, 7)}  ${c.messageHeadline}`);
  if (pr.commits.length > PR_TIP_COMMITS)
    tipLines.push(`… +${pr.commits.length - PR_TIP_COMMITS} more`);
  const tip = tipLines.join('\n');
  return (
    <li className="text-[11px]">
      <div className="flex items-center gap-2 py-0.5" title={tip}>
        <CiDot status={pr.ciStatus} size={5} />
        {prId != null ? (
          <button
            type="button"
            onClick={() =>
              openPrDetailTab(prTabMeta(prId, pr.prNumber, fullName ?? '', pr.title), {
                fromActivity: true,
              })
            }
            title={`Open #${pr.prNumber} in this app`}
            className="shrink-0 rounded bg-sky-500/10 px-1 font-mono text-[10px] text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
          >
            #{pr.prNumber}
          </button>
        ) : prHref != null ? (
          // Not synced for this account (squash-merged before the backfill window, or a repo
          // added later) — there is no local PR to open, so link out rather than drop the
          // reference.
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            title={`#${pr.prNumber} on GitHub — not synced here`}
            className="shrink-0 rounded bg-gray-500/10 px-1 font-mono text-[10px] text-gray-500 hover:text-sky-600 dark:text-gray-400 dark:hover:text-sky-400"
          >
            #{pr.prNumber}
          </a>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-gray-400">#{pr.prNumber}</span>
        )}
        {/* UNTRUSTED text (a PR title / commit message) — a plain text node, never markdown. */}
        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
          {trimTrailingPrRef(title, pr.prNumber)}
        </span>
        {/* The consolidation's size — the visible hint that the tooltip has the commit list. */}
        <span className="shrink-0 text-gray-400">
          {pr.commits.length} commit{pr.commits.length === 1 ? '' : 's'}
        </span>
        {(avatar != null || pr.authorLogin != null) && (
          <span className="flex shrink-0 items-center gap-1 text-gray-400">
            {avatar != null && (
              <img src={avatar} alt="" className="h-3.5 w-3.5 rounded-full" loading="lazy" />
            )}
            {pr.authorLogin != null && (
              <span className="max-w-[10rem] truncate">{pr.authorLogin}</span>
            )}
          </span>
        )}
        <span
          className="shrink-0 tabular-nums text-gray-400"
          title={new Date(pr.mergedAt).toLocaleString()}
        >
          {relativeTime(pr.mergedAt)}
        </span>
      </div>
    </li>
  );
}

// The ONE trend chart above an expanded row's commit list — the Bot Behaviour "Daily coverage"
// layout verbatim (DayStrip): one cell per day tinted by that day's FAILING trunk commits, with
// the thin line band above tracing PRs MERGED into the default branch per day. Both series ride
// one shared axis from the wire, so a red patch and a merge burst align cell-for-cell. Data
// arrives via useBranchTrends only once the row opens, so the collapsed strip never pays.
//
// The chart body sits in a FIXED-HEIGHT box: the commit list renders below immediately, and
// reserving the space is what keeps it from shifting when the query lands. The loading state is
// a muted one-liner inside that reserved space — no spinner.
function BranchTrends({
  data,
  isLoading,
  isError,
  full,
}: {
  data: BranchTrendsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  full: boolean;
}): JSX.Element {
  const daily = data?.daily ?? [];
  const hasData = daily.length > 0;
  const placeholder = (label: string): JSX.Element => (
    <div className="flex h-full items-center justify-center text-[10px] text-gray-400">
      {label}
    </div>
  );
  // A failed request is NOT "no data" — an error rendered as an empty state would present a
  // fact about the repo the server never asserted. Same reserved box, different words.
  const errLabel = 'Couldn’t load trends';
  // DayStrip's own default height with the opened band (2 + 14 + 16 + 5 + 12).
  const STRIP_H = 49;

  const strip = isLoading ? (
    placeholder('Loading trends…')
  ) : isError ? (
    placeholder(errLabel)
  ) : !hasData ? (
    placeholder('No trunk history yet')
  ) : (
    <DayStrip
      daily={daily.map((d) => d.failed)}
      dailyGood={daily.map((d) => d.passed)}
      startDate={daily[0]?.day ?? ''}
      silentRuns={[]}
      color={PALETTE.red}
      goodColor={PALETTE.green}
      opened={daily.map((d) => d.merged)}
      noun="failing commit"
      goodNoun="passing commit"
      openedVerb="merged"
    />
  );

  if (full) {
    // The per-repo console: the ChartCard composition, exactly as BotDetailPanel's
    // "Daily coverage" card.
    return (
      <div className="mb-2">
        <ChartCard
          title="Trunk health & throughput"
          note="one cell / day · red = failing, green = passing commits · line = PRs merged · retained window (UTC)"
        >
          <div style={{ height: STRIP_H }}>{strip}</div>
        </ChartCard>
      </div>
    );
  }

  // The cross-repo Feed strip lives in a max-h-64 scroll box — same chart, caption instead of
  // a card.
  return (
    <div className="mb-1 border-b border-gray-100 pb-1 dark:border-gray-800/60">
      <div className="text-[10px] text-gray-400">
        Trunk CI · red = failing, green = passing · line = PRs merged · retained window
      </div>
      <div style={{ height: STRIP_H }}>{strip}</div>
    </div>
  );
}

/**
 * One repo's trunk row: always-visible summary (branch, CI, last commit), expandable to the
 * recent commit list. Collapsed by default — the strip's job is to be scannable at a glance,
 * and the history is the follow-up question.
 */
function BranchRow({
  status,
  fullName,
  showRepoName,
  fullTrends,
}: {
  status: RepoBranchStatus;
  fullName: string | undefined;
  showRepoName: boolean;
  fullTrends: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ciMeta = CI_META[status.ciStatus];
  // Any retained trunk history at all (merged PRs OR direct pushes) — the expandable content is
  // the trend strip + the merged-PR list, and the strip has data whenever commits were synced.
  const hasHistory = status.lastCommitAt != null;
  // Lazy by construction: `open` is the enabled flag, and the toggle is disabled without
  // history, so a collapsed strip of N repos issues zero trend requests.
  const trends = useBranchTrends(status.repoId, open);
  return (
    <li className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/60">
      {/* The row is a DIV, not one big button: the failing-check names are real <a> links to
          GitHub, and an <a> inside a <button> is invalid interactive nesting — the browser hoists
          the anchor out and the click target becomes unpredictable. The expand toggle is its own
          <button> covering the summary text; the links sit BESIDE it. The hover tint therefore
          lives on the wrapper (so hovering a link still tints the row, the correct affordance now
          that the row is not a single control), and `disabled` stays on the toggle ALONE — a red
          trunk with no synced commits still has clickable failing-check links. */}
      <div className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          disabled={!hasHistory}
          // flex-1 replaces the timestamp's old ml-auto: the toggle now absorbs the row's slack.
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <span
            aria-hidden="true"
            className={`w-2 shrink-0 text-[9px] text-gray-400 ${hasHistory ? '' : 'opacity-0'}`}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} size={10} />
          </span>
          <CiDot status={status.ciStatus} />
          {showRepoName && (
            <span className="min-w-0 max-w-[14rem] truncate font-medium text-gray-700 dark:text-gray-200">
              {fullName ?? `repo ${status.repoId}`}
            </span>
          )}
          <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {status.branchName ?? '—'}
          </span>
          <span className="shrink-0 text-[11px] text-gray-400">
            {ciMeta?.label ?? 'no CI reported'}
          </span>
        </button>
        <FailingSummary checks={status.failingChecks} />
        <span className="shrink-0 text-[11px] tabular-nums text-gray-400">
          {status.lastCommitAt != null ? relativeTime(status.lastCommitAt) : 'never synced'}
        </span>
      </div>
      {open && hasHistory && (
        <div className="border-t border-gray-100 px-2 py-1 pl-6 dark:border-gray-800/60">
          <BranchTrends
            data={trends.data}
            isLoading={trends.isLoading}
            isError={trends.isError}
            full={fullTrends}
          />
          {status.mergedPrs.length > 0 ? (
            <ul>
              {status.mergedPrs.map((pr) => (
                <PrRow key={pr.prNumber} pr={pr} fullName={fullName} />
              ))}
            </ul>
          ) : (
            // Real state, not a gap: a branch fed only by direct pushes has trunk history (the
            // strip above) but nothing that arrived via a PR.
            <div className="py-0.5 text-[11px] text-gray-400">
              No merged PRs in the retained window — direct pushes only.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The cross-repo default-branch strip: every repo in scope, its trunk CI state, and (on
 * expand) what recently landed there with who wrote it.
 *
 * Why it exists: everything else in this app is PR-shaped, so a red default branch — which
 * invalidates every open PR's CI at once — had nowhere to show. It is a readout, NOT an alert
 * channel: it never contributes to attention counts, the rail sort, My Turn, or any badge.
 *
 * `repoIds` (optional) pins the strip to one repo, for the per-repo console header. Omitted, it
 * covers the active WORKSPACE, whole — like the rest of the Activity console. It does NOT follow
 * the FilterBar's per-repo picker: that is a TIMELINE-board filter whose control is unmounted
 * here, so honouring it would narrow this strip with no visible way to widen it again.
 */
export function BranchStatusPanel({
  repoIds,
  compact = false,
}: {
  repoIds?: number[] | null;
  compact?: boolean;
}): JSX.Element | null {
  const { data, isLoading } = useBranchStatus(repoIds);
  const { data: repos } = useRepos();
  const nameById = new Map((repos ?? []).map((r) => [r.id, r.fullName]));
  // Per-mount only, deliberately: this is a "let me look" toggle, not a remembered preference,
  // and a red trunk always forces it open regardless (see `expanded`).
  const [userExpanded, setUserExpanded] = useState(false);

  if (isLoading && data == null) return null;
  const rows = data?.repos ?? [];
  // Repos that have never been branch-synced carry nulls across the board. Showing a strip of
  // "—" rows on a fresh account is noise, so the whole panel hides until at least one repo has
  // real branch data; individual unsynced repos still get a row once any of them does (the row
  // count must match the repo list, so a partially-synced scope isn't silently shortened).
  const anySynced = rows.some((r) => r.branchName != null);
  if (!anySynced) return null;

  const failing = rows.filter(
    (r) => r.ciStatus === 'failure' || r.ciStatus === 'error',
  ).length;

  // ── COLLAPSE WHEN NOTHING IS RED ──────────────────────────────────────────────────────────
  //
  // The cross-repo Feed shows this panel above the stream, where a twelve-repo workspace spends
  // most of its life rendering twelve green rows nobody reads. Collapsed, it is the header line
  // alone — still always expandable, and `useBranchTrends` is lazy per row, so a collapsed strip
  // issues ZERO extra requests.
  //
  // ⚠ "GREEN" IS NOT A BOOLEAN. `CiStatus` has six members, and `pending`/`expected`/`unknown`
  // are neither red nor green (CiDot paints `unknown` as a HOLLOW grey dot). The rule is: collapse
  // unless some repo is `failure|error` — a pending build is not a call to action — and the
  // caption claims "all green" ONLY when every repo is `success`. Anything else gets the neutral
  // count with no verdict attached.
  //
  // ⚠ CROSS-REPO MOUNT ONLY. `RepoFeedHeader` mounts this `compact` for a SINGLE repo, where the
  // panel IS the trunk line; collapsing there would hide that repo's status inside its own
  // console header.
  const allGreen = rows.every((r) => r.ciStatus === 'success');
  const collapsible = !compact;
  const expanded = !collapsible || failing > 0 || userExpanded;

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-800"
      data-testid="branch-status-panel"
    >
      <div
        className={`flex items-center gap-2 px-2 py-1 ${
          expanded ? 'border-b border-gray-100 dark:border-gray-800/60' : ''
        }`}
      >
        {collapsible && (
          <button
            type="button"
            onClick={() => setUserExpanded((v) => !v)}
            aria-expanded={expanded}
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            title={expanded ? 'Hide the per-repo rows' : 'Show the per-repo rows'}
          >
            <ChevronIcon dir={expanded ? 'down' : 'right'} size={10} />
          </button>
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Default branches
        </span>
        {!expanded && allGreen && (
          <span className="text-[10px] text-gray-400">all green</span>
        )}
        {failing > 0 && (
          <span
            className="rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-600 dark:text-red-400"
            title="Default branches whose latest CI is failing"
          >
            {failing} failing
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400">
          {rows.length} repo{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className={`${compact ? '' : 'max-h-64 overflow-y-auto'}${expanded ? '' : ' hidden'}`}>
        {rows.map((r) => (
          <BranchRow
            key={r.repoId}
            status={r}
            fullName={nameById.get(r.repoId)}
            // In the single-repo console the name is already the header above; repeating it in
            // every row is noise.
            showRepoName={!compact}
            // INVERTED from `compact` on purpose: the `compact` panel is the per-repo console
            // header, which has the vertical room for full ChartCards; the non-compact panel is
            // the cross-repo Feed strip whose rows live in the max-h-64 scroll box above and get
            // the two-line compact strips instead.
            fullTrends={compact}
          />
        ))}
      </ul>
    </section>
  );
}
