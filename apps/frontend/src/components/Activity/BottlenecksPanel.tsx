import { useMemo, useState, type ReactNode } from 'react';
import type { CourtEvidencePr, PrCourt, RepoCourtProfile } from '@pierre-review/shared';
import { useFlowFindings } from '../../hooks/useFlowFindings.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { InfoButton } from '../InfoModal.js';
import {
  BotIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  InfoIcon,
  PullRequestIcon,
  WarningIcon,
} from '../Icons.js';
import { metaFor } from './AttentionCards.js';
import { FlowPointersPanel } from './FlowPointersPanel.js';
import {
  BudgetChart,
  COURT_SWATCH,
  COURT_TEXT,
  CourtLegend,
  CourtSplit,
  CourtTriangle,
  Figure,
  LeadScatter,
} from './ChronologyCharts.js';
import {
  ByRepositoryInfo,
  BudgetsInfo,
  ChronologyAboutInfo,
  ConcentrationInfo,
  ContrastInfo,
  LandingInfo,
  RequestsInfo,
  ScatterInfo,
  SplitInfo,
  TriangleInfo,
  UnreviewedInfo,
} from './chronologyInfo.js';
import {
  ConcentrationTable,
  ContrastTable,
  LandingTailList,
  RequestsTable,
  SizeBandsChart,
  SlowestTable,
  WeekdayChart,
} from './ChronologyTables.js';
import {
  calendarLine,
  CHRONOLOGY_WINDOWS,
  effectiveChronologyWindow,
  formatCount,
  formatShare,
  hasWorkingHours,
  prFiguresOf,
  slowestPrs,
  type ChronologyWindow,
} from './chronologyModel.js';
import {
  buildBottlenecksModel,
  coverageLineFor,
  exclusionLineFor,
  formatHours,
  formatPct,
  truncationLineFor,
} from './bottlenecksModel.js';

// "Chronology" — the COURT LEDGER, on the Reports rail.
//
// Every hour a pull request is open, somebody is holding the ball: a REVIEWER who has not looked,
// an AUTHOR who owes a response, or nobody at all — approved and waiting to land.
//
// ⚠ THIS SCREEN NAMES NO PERSON. Not a login, not an avatar, not a per-head count. The subject of
// every row is a repository and a court; people do not appear, and the server no longer sends
// actor ids to make that structural rather than a convention. "Guide the work, never rank the
// people" is the licence this feature operates under, and a screen an EM makes staffing decisions
// from is exactly where that line has to hold.
//
// ⚠ EVERY SENTENCE IS THE SERVER'S, TEMPLATED. No model touches this feature at any point. The
// panel formats FIGURES (bottlenecksModel) and renders PROSE (the server's) — it never composes a
// claim of its own out of the numbers.
//
// ⚠ AND ONLY THE PROSE THAT IS NOT A RESTATEMENT. Every panel is a `Block`: a title, an "i", and
// figures or a chart. How a panel is read lives behind its "i" (chronologyInfo.tsx); the page keeps
// the refusals, the one-line disclosures (coverage, what was set aside, a capped list — each a
// COUNT from the wire, never a finding), and the server's own sentence only where no figure says
// the same thing. `workHeadline`, `headline`, `narrative` and the tables' sentences ride the wire
// unrendered: each restated a chart that now sits beside it.
//
// ⚠ PRO (`periodReports`), AND THIS COMPONENT HOLDS NO CAPABILITY READ. The gate is three places,
// none of them here: `GET /api/flow-findings` 402s (the monetisation gate), `useFlowFindings`
// gates its `enabled` on the same flag so the SPA never learns it by error, and InsightsView
// swaps this panel for `ProLockPanel` under a `Pro`-badged tab. Keeping the capability out of here
// is what lets the "Measuring…" / "Could not load" branch below stay a two-state question about
// the REQUEST: mount this panel and there is, by construction, an entitled request in flight. If
// entitlement flips mid-session the whole body is replaced by the lock on the same render, because
// InsightsView reads the same /api/me — this file never has to render a paywall.

/** The evidence rows carry no author identity, so the lookup is always empty by construction. */
const NO_AUTHOR_LOOKUP = new Map<number, never>() as never;

/** A one-line disclosure: a count from the wire, in a sentence. */
const NOTE = 'text-xs text-gray-500 dark:text-gray-400';

/**
 * One openable pull request.
 *
 * ⚠ `githubUrl` is data-derived, so the external link goes through safeExternalUrl — React renders
 * a `javascript:` href with nothing but a console warning.
 *
 * ⚠ `court` is null for the merged-without-review list, where `hoursInCourt` carries no meaning.
 * Rendering it anyway printed "0h of 15m" — a figure that is not so much wrong as not a
 * measurement. A row shows the court clock only where there was a court to sit in.
 */
function EvidenceRow({ pr, court }: { pr: CourtEvidencePr; court: PrCourt | null }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const href = safeExternalUrl(pr.githubUrl);
  // Opened through the SAME path every other Activity card uses, so the tab, its chrome and the
  // Back-to-Activity arming are identical to a click from the Pending board.
  const meta = metaFor(
    { prId: pr.prId, prNumber: pr.prNumber, prTitle: pr.prTitle, repoFullName: pr.repoFullName },
    NO_AUTHOR_LOOKUP,
  );
  return (
    <li className="flex items-baseline gap-2 py-1 text-xs">
      <button
        type="button"
        onClick={() => openPrDetailTab(meta, { fromActivity: true })}
        title={pr.prTitle}
        className="inline-flex min-w-0 items-center gap-1 font-medium text-sky-600 hover:underline dark:text-sky-400"
      >
        <PullRequestIcon size={11} className="shrink-0" />
        <span className="shrink-0">#{pr.prNumber}</span>
        <span className="truncate text-gray-600 dark:text-gray-300">{pr.prTitle}</span>
      </button>
      {pr.authorIsBot && (
        // Should not occur — automation's own pull requests are excluded from this population —
        // but if the exclusion ever regresses, the row says so rather than passing a dependency
        // bump off as somebody's waiting work.
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-gray-100 px-1 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          title="Opened by automation"
        >
          <BotIcon size={10} />
          bot
        </span>
      )}
      <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-gray-500 dark:text-gray-400">
        {court != null ? (
          <>
            <span className={`font-semibold ${COURT_TEXT[court]}`}>
              {formatHours(pr.hoursInCourt)}
            </span>
            {' of '}
            {formatHours(pr.leadHours)}
          </>
        ) : (
          <>merged in {formatHours(pr.leadHours)}</>
        )}
      </span>
      {href != null && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on GitHub"
          aria-label={`Open ${pr.repoFullName} #${pr.prNumber} on GitHub`}
          className="shrink-0 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ExternalLinkIcon size={10} />
        </a>
      )}
    </li>
  );
}

/**
 * A repository called out in its court: its figures, its split, and the pull requests that held
 * the ball longest. Clock hours, so "d" is right here — unlike the working-hour figures above.
 */
function RepoRow({ repo }: { repo: RepoCourtProfile }): JSX.Element {
  const court = repo.dominant;
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">
          {repo.repoFullName}
        </span>
        <span className="whitespace-nowrap text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {formatCount(repo.prs)} PRs · median {formatHours(repo.medianLeadHours)} · three in four{' '}
          <span className="font-semibold text-gray-700 dark:text-gray-200">
            {formatHours(repo.p75LeadHours)}
          </span>
        </span>
      </div>
      <div className="mt-2">
        <CourtSplit courts={repo.courts} size="sm" />
      </div>
      {repo.evidence.length > 0 && court != null && (
        <div className="mt-2 border-t border-gray-100 pt-1.5 dark:border-gray-800/70">
          <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
            Longest in this court
          </div>
          <ul>
            {repo.evidence.map((pr) => (
              <EvidenceRow key={pr.prId} pr={pr} court={court} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * The window the reader last picked, remembered for the session so leaving the tab and coming back
 * does not snap it to 30 days. Not in the URL or the persisted filters: it is a reading choice on
 * one pane, and "Clear filters" must not be what resets it.
 */
let rememberedWindow: ChronologyWindow = 30;

function WindowPicker({
  value,
  onChange,
}: {
  value: ChronologyWindow;
  onChange: (w: ChronologyWindow) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Window" className="inline-flex rounded-md border border-gray-200 p-0.5 dark:border-gray-700">
      {CHRONOLOGY_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          className={`rounded px-2 py-0.5 text-xs ${
            value === w
              ? 'bg-gray-800 font-medium text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
          }`}
        >
          {w} days
        </button>
      ))}
    </div>
  );
}

/**
 * One panel: a title, the "i" that explains it, and its figures.
 *
 * ⚠ NO NOTE UNDER THE TITLE. Every panel used to open with a sentence about how to read it, and
 * the page read as a manual; that sentence is the modal now. The button sits BESIDE the heading,
 * not inside it, so the heading's accessible name stays the title alone.
 */
function Block({
  title,
  info,
  infoWidth,
  children,
  testId,
}: {
  title: string;
  /** The panel's explanation, shown in a modal behind the "i" beside the title. */
  info?: ReactNode;
  infoWidth?: 'md' | 'lg';
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <section data-testid={testId} className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="flex items-center gap-1">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h4>
        {info != null && (
          <InfoButton title={title} width={infoWidth}>
            {info}
          </InfoButton>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A per-PR chart drawn from the capped sample says so, in the same words wherever it appears. */
function CappedLine({ shown, measured }: { shown: number; measured: number }): JSX.Element {
  return (
    <p className={`mt-1 ${NOTE}`}>
      Showing {formatCount(shown)} of {formatCount(measured)}: every slow pull request, and an even
      sample of the rest.
    </p>
  );
}

/** A court's sub-heading inside "By repository": its swatch, its name, how many sit under it. */
function CourtHeading({
  label,
  count,
  swatch,
}: {
  label: string;
  count: number;
  swatch?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      {swatch != null && <span className={`h-2.5 w-2.5 rounded-sm ${swatch}`} />}
      <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">{label}</h5>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {count} {count === 1 ? 'repository' : 'repositories'}
      </span>
    </div>
  );
}

const SLOWEST_TABLE_ROWS = 20;

export function BottlenecksPanel(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const [windowDays, setWindowDaysState] = useState<ChronologyWindow>(() =>
    effectiveChronologyWindow(rememberedWindow),
  );
  const setWindowDays = (w: ChronologyWindow): void => {
    rememberedWindow = w;
    setWindowDaysState(w);
  };
  const [showSlowest, setShowSlowest] = useState(false);
  // ⚠ `workspaceId === null` means "not resolved yet" — the hook holds itself idle on skipToken,
  // so nothing here renders another workspace's numbers during the gap.
  const q = useFlowFindings(workspaceId, windowDays);
  const model = useMemo(() => buildBottlenecksModel(q.data), [q.data]);
  const resp = q.data;
  const working = hasWorkingHours(resp);
  const slowest = useMemo(() => slowestPrs(resp?.prs ?? [], SLOWEST_TABLE_ROWS), [resp?.prs]);

  if (model == null || resp == null) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {q.isError ? 'Could not load this workspace’s flow.' : 'Measuring…'}
      </div>
    );
  }

  const exclusions = exclusionLineFor(model.coverage);
  const truncation = truncationLineFor(model.coverage);
  // ⚠ Over EVERY measured pull request — the server's, or a recount of a list that is complete.
  // Null when the list is a sample from an older server: no figure beats a wrong one.
  const figures = prFiguresOf(resp);
  const dayHours =
    resp.settings == null ? 0 : (resp.settings.endMinute - resp.settings.startMinute) / 60;
  const prs = resp.prs ?? [];

  return (
    <div className="space-y-4" data-testid="bottlenecks-panel">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Chronology</h3>
            <InfoButton title="How Chronology works">
              <ChronologyAboutInfo settings={resp.settings ?? null} />
            </InfoButton>
          </div>
          <WindowPicker value={windowDays} onChange={setWindowDays} />
        </div>
        {/* ⚠ THE DISCLOSURES STAY ON THE PAGE, one line each. Retroactive history is coverage-
            biased, and what was set aside changes every share below — a reader who has to open a
            modal to learn either will not. */}
        <div className="mt-1 space-y-0.5">
          {resp.settings != null && (
            <p className={NOTE}>{calendarLine(resp.settings)} Set per workspace in Settings.</p>
          )}
          <p className={NOTE}>{coverageLineFor(model.coverage, model.windowDays)}</p>
          {exclusions != null && <p className={NOTE}>{exclusions}</p>}
          {truncation != null && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <WarningIcon size={12} className="mt-0.5 shrink-0" />
              <span>{truncation}</span>
            </p>
          )}
        </div>
      </div>

      {model.nothingMeasured ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          Nothing to measure in this workspace yet.
          <p className="mt-1 text-xs">
            A pull request has to merge, and a person has to have reviewed or commented on it,
            before its waiting time can be counted.
          </p>
        </div>
      ) : (
        <>
          {/* ══ THE WORKING-HOURS HALF (db/flow-detail.ts) ════════════════════════════════
              The split first, then each wait against its budget: an even split between the three
              courts is not a target, so the budgets are what say whether a wait was too long. An
              older server sends none of these fields; the page then opens on the CLOCK-hour split
              and renders its court half below. */}
          {working && resp.settings != null ? (
            <>
              <Block
                title="Who was holding it, in working hours"
                info={<SplitInfo />}
                testId="chronology-split"
              >
                <CourtSplit courts={resp.courtsWork ?? []} size="lg" />
              </Block>

              <Block title="Each wait against its budget" info={<BudgetsInfo />} testId="chronology-budgets">
                <BudgetChart rows={resp.budgets ?? []} dayHours={dayHours} />
              </Block>

              {prs.length > 0 && (
                <Block title="Every pull request" info={<ScatterInfo />} testId="chronology-scatter">
                  {figures != null && (
                    <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
                      <Figure
                        value={formatCount(figures.overWorkingDay)}
                        label="took more than a working day"
                      />
                      <Figure
                        value={formatShare(figures.slowestTenthShare)}
                        label={`of all working-hour waiting sits in the slowest ${formatCount(figures.slowestTenthCount)}`}
                      />
                    </div>
                  )}
                  <LeadScatter
                    prs={prs}
                    budgetHours={resp.settings.budgets.lead.good}
                    p75Hours={resp.p75LeadWorkHours ?? 0}
                  />
                  {resp.prsCapped && <CappedLine shown={prs.length} measured={model.measuredPrs} />}
                  <button
                    type="button"
                    onClick={() => setShowSlowest((v) => !v)}
                    aria-expanded={showSlowest}
                    className="mt-2 text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
                  >
                    {showSlowest ? 'Hide' : 'Show'} the {slowest.length} slowest as a table
                  </button>
                  {showSlowest && (
                    <div className="mt-2">
                      <SlowestTable prs={slowest} />
                    </div>
                  )}
                </Block>
              )}

              {(resp.contrast != null || (resp.sizeBands?.length ?? 0) > 0) && (
                <Block
                  title="What the slow ones have in common"
                  info={<ContrastInfo />}
                  testId="chronology-contrast"
                >
                  <div className="space-y-5">
                    {resp.contrast != null ? (
                      <ContrastTable contrast={resp.contrast} />
                    ) : (
                      <p className={NOTE}>
                        Too few pull requests to compare the fastest quarter with the slowest.
                      </p>
                    )}
                    <div className="grid gap-5 md:grid-cols-2">
                      <div>
                        <h5 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-200">By size</h5>
                        <SizeBandsChart bands={resp.sizeBands ?? []} />
                      </div>
                      <div>
                        <h5 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-200">
                          By the day it opened
                        </h5>
                        <WeekdayChart days={resp.weekdays ?? []} />
                      </div>
                    </div>
                  </div>
                </Block>
              )}

              {resp.landingTail != null && (
                <Block
                  title="Approved and waiting"
                  info={<LandingInfo dayHours={dayHours} />}
                  testId="chronology-landing"
                >
                  <LandingTailList tail={resp.landingTail} />
                </Block>
              )}

              {(resp.concentration?.length ?? 0) > 0 && (
                <Block
                  title="Who gives the first review"
                  info={<ConcentrationInfo />}
                  testId="chronology-concentration"
                >
                  <ConcentrationTable rows={resp.concentration ?? []} />
                </Block>
              )}

              {resp.requests != null && (
                <Block title="Asking for a review" info={<RequestsInfo />} testId="chronology-requests">
                  <RequestsTable stats={resp.requests} />
                </Block>
              )}

              {/* The one model-written block — AI palette, never a figure, every citation checked. */}
              <FlowPointersPanel workspaceId={workspaceId} days={windowDays} />

              {prs.length > 0 && (
                <Block
                  title="Where each pull request sits"
                  info={<TriangleInfo />}
                  testId="chronology-triangle"
                >
                  {figures != null && (
                    <div className="mb-2">
                      <Figure
                        value={`${formatCount(figures.neverWentBack)} of ${formatCount(model.measuredPrs)}`}
                        label="never went back to their author"
                      />
                    </div>
                  )}
                  <CourtTriangle prs={prs} overall={resp.courtsWork ?? []} />
                  {resp.prsCapped && <CappedLine shown={prs.length} measured={model.measuredPrs} />}
                </Block>
              )}
            </>
          ) : (
            // An older server: no working hours, so the page still opens on a split — in clock hours.
            <Block title="Who was holding it, in clock hours" testId="chronology-split">
              <CourtSplit courts={model.courts} size="lg" />
            </Block>
          )}

          {/* ══ THE CLOCK-HOUR HALF (db/pr-intervals.ts) ═════════════════════════════════
              Clock hours, because the rule that calls a repository out was calibrated on them. */}
          {(model.sections.length > 0 || model.quiet.length > 0) && (
            <Block
              title="By repository, in clock hours"
              info={<ByRepositoryInfo sections={model.sections} />}
              infoWidth="lg"
              testId="chronology-repos"
            >
              <div className="space-y-5">
                <CourtLegend />
                {model.sections.map((section) => (
                  <section key={section.court} className="space-y-2">
                    <CourtHeading
                      label={section.label}
                      count={section.repos.length}
                      swatch={COURT_SWATCH[section.court]}
                    />
                    {/* ⚠ THE ADVICE LIVES HERE, ONCE — a property of the COURT, not of a repository:
                        on every row it produced six identical paragraphs on a real workspace. The
                        server's one line is on the page; its full paragraph is behind the "i". */}
                    {section.summary !== '' && (
                      <p className="text-xs text-gray-700 dark:text-gray-300">{section.summary}</p>
                    )}
                    <ul className="space-y-2">
                      {section.repos.map((r) => (
                        <RepoRow key={r.repoId} repo={r} />
                      ))}
                    </ul>
                  </section>
                ))}

                {/* Measured and not lopsided-and-slow: the healthy ones, shown quietly so the panel
                    does not read as "everything is on fire". */}
                {model.quiet.length > 0 && (
                  <section className="space-y-2">
                    <CourtHeading label="Nothing stands out" count={model.quiet.length} />
                    <ul className="space-y-1.5">
                      {model.quiet.map((r) => (
                        <li
                          key={r.repoId}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-gray-200 px-3 py-2 dark:border-gray-800"
                        >
                          <CheckCircleIcon size={12} className="shrink-0 text-gray-500 dark:text-gray-400" />
                          <span className="font-mono text-xs text-gray-600 dark:text-gray-300">
                            {r.repoFullName}
                          </span>
                          <span className="w-24 shrink-0">
                            <CourtSplit courts={r.courts} size="bar" />
                          </span>
                          <span className="ml-auto text-xs tabular-nums text-gray-500 dark:text-gray-400">
                            {formatCount(r.prs)} PRs · three in four {formatHours(r.p75LeadHours)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            </Block>
          )}

          {model.unreviewed.length > 0 && (
            <Block
              title="Merged without a human review"
              info={<UnreviewedInfo />}
              testId="chronology-unreviewed"
            >
              <ul className="space-y-2">
                {model.unreviewed.map((u) => (
                  <li key={u.repoId} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">
                        {u.repoFullName}
                      </span>
                      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                        <span className="font-semibold text-amber-700 dark:text-amber-400">
                          {formatPct(u.share)}
                        </span>{' '}
                        — {u.withoutHumanReview} of {u.merged} merges
                      </span>
                    </div>
                    <ul className="mt-1.5 border-t border-gray-100 pt-1 dark:border-gray-800/70">
                      {u.evidence.map((pr) => (
                        <EvidenceRow key={pr.prId} pr={pr} court={null} />
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {/* ⚠ REFUSALS RENDER BY NAME. An absent section asserts "we checked and there is nothing
              here", which is a much stronger claim than either thing that actually happened. */}
          {model.refusals.map((r) => (
            <p
              key={r.kind}
              data-testid="bottleneck-refusal"
              className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              {r.basis === 'measured_clean' ? (
                <CheckCircleIcon size={12} className="mt-0.5 shrink-0" />
              ) : (
                <InfoIcon size={12} className="mt-0.5 shrink-0" />
              )}
              <span>
                {r.basis === 'insufficient_data' && (
                  <strong className="font-medium">Not enough data to say. </strong>
                )}
                {r.reason}
              </span>
            </p>
          ))}
        </>
      )}
    </div>
  );
}
