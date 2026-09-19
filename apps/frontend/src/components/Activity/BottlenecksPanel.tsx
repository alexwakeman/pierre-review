import { useMemo, useState, type ReactNode } from 'react';
import type { CourtEvidencePr, PrCourt, RepoCourtProfile } from '@pierre-review/shared';
import { useFlowFindings } from '../../hooks/useFlowFindings.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { safeExternalUrl } from '../../lib/ui.js';
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
  CourtTriangle,
  LeadScatter,
} from './ChronologyCharts.js';
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
  neverWentBack,
  slowestPrs,
  slowestTenthShare,
  type ChronologyWindow,
} from './chronologyModel.js';
import {
  buildBottlenecksModel,
  barWidth,
  COURT_LABEL,
  COURT_ORDER,
  COURT_SHORT,
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

// ⚠ The validated court colours (see ChronologyCharts.tsx) — one set for every mark on the panel.
const COURT_BAR: Record<PrCourt, string> = COURT_SWATCH;
const COURT_TEXT: Record<PrCourt, string> = {
  reviewer: 'text-amber-700 dark:text-amber-400',
  author: 'text-teal-700 dark:text-teal-400',
  landing: 'text-indigo-600 dark:text-indigo-400',
};

function CourtBar({
  courts,
  title,
}: {
  courts: { court: PrCourt; share: number }[];
  title?: string;
}): JSX.Element {
  const by = new Map(courts.map((c) => [c.court, c.share]));
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-sm bg-gray-200 dark:bg-gray-800"
      title={title}
    >
      {COURT_ORDER.map((court) => (
        <div
          key={court}
          className={COURT_BAR[court]}
          style={{ width: barWidth(by.get(court) ?? 0) }}
        />
      ))}
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {COURT_ORDER.map((court) => (
        <span key={court} className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className={`h-2 w-2 rounded-sm ${COURT_BAR[court]}`} />
          {COURT_SHORT[court]}
        </span>
      ))}
    </div>
  );
}

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
    <li className="flex items-baseline gap-2 py-1 text-[11px]">
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
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          title="Opened by automation"
        >
          <BotIcon size={9} />
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
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <ExternalLinkIcon size={10} />
        </a>
      )}
    </li>
  );
}

function RepoRow({ repo }: { repo: RepoCourtProfile }): JSX.Element {
  const court = repo.dominant;
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">
          {repo.repoFullName}
        </span>
        <span className="whitespace-nowrap text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
          median {formatHours(repo.medianLeadHours)} · p75{' '}
          <span className="font-semibold text-gray-700 dark:text-gray-200">
            {formatHours(repo.p75LeadHours)}
          </span>
        </span>
      </div>
      <div className="mt-2">
        <CourtBar
          courts={repo.courts}
          title={repo.courts
            .map((c) => `${COURT_SHORT[c.court]} ${formatPct(c.share)}`)
            .join(' · ')}
        />
      </div>
      {/* The server's sentence, verbatim. Figures inside it are the server's own formatting; the
          per-court chips beside it are this file's. They describe the same numbers, so both come
          from the one `courts` array rather than being recomputed. */}
      {repo.narrative != null && (
        <p className="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          {repo.narrative}
        </p>
      )}
      {repo.evidence.length > 0 && court != null && (
        <div className="mt-2 border-t border-gray-100 pt-1.5 dark:border-gray-800/70">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
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

function Block({
  title,
  note,
  children,
  testId,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <section data-testid={testId} className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h4>
      {note != null && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A labelled figure — a number with its name beside it, never a sentence composed from it. */
function Figure({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-50">{value}</div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
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
  const tenth = useMemo(() => slowestTenthShare(resp?.prs ?? []), [resp?.prs]);
  const slowest = useMemo(() => slowestPrs(resp?.prs ?? [], SLOWEST_TABLE_ROWS), [resp?.prs]);

  if (model == null) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        {q.isError ? 'Could not load this workspace’s flow.' : 'Measuring…'}
      </div>
    );
  }

  const exclusions = exclusionLineFor(model.coverage);
  const truncation = truncationLineFor(model.coverage);

  return (
    <div className="space-y-4" data-testid="bottlenecks-panel">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Chronology
            </h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Every hour a pull request is open, somebody is holding it. Automation is measured on
              the Bots rail.
            </span>
          </div>
          <WindowPicker value={windowDays} onChange={setWindowDays} />
        </div>
        {resp?.settings != null && (
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {calendarLine(resp.settings)} Set per workspace in Settings.
          </div>
        )}
        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {coverageLineFor(model.coverage, model.windowDays)}
        </div>
        {exclusions != null && (
          <div className="text-xs text-gray-500 dark:text-gray-400">{exclusions}</div>
        )}
        {truncation != null && (
          <div className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <WarningIcon size={11} className="mt-0.5 shrink-0" />
            <span>{truncation}</span>
          </div>
        )}
      </div>

      {model.nothingMeasured ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing to measure in this Workspace yet.
          <div className="mt-1 text-[11px]">
            A pull request has to merge, and a person has to have reviewed or commented on it,
            before its waiting time can be attributed.
          </div>
        </div>
      ) : (
        <>
          {/* ══ THE WORKING-HOURS HALF (db/flow-detail.ts) ════════════════════════════════
              Budgets are the headline: an even split between the three courts is not a target,
              so the panel leads with how long each wait took against what the team set. An older
              server sends none of these fields, and the court half below still renders. */}
          {working && resp != null && resp.settings != null && (
            <>
              <Block
                title="Each wait against its budget"
                note="Working hours only. The bar reaches the point by which three in four pull requests had finished that wait; the dashed line is the budget."
                testId="chronology-budgets"
              >
                {resp.workHeadline != null && (
                  <p className="mb-3 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                    {resp.workHeadline}
                  </p>
                )}
                <BudgetChart
                  rows={resp.budgets ?? []}
                  dayHours={(resp.settings.endMinute - resp.settings.startMinute) / 60}
                />
              </Block>

              {(resp.prs?.length ?? 0) > 0 && (
                <Block
                  title="Every pull request"
                  note="One dot per merged pull request. Colour is the court it spent most of its working time in. Hover for its breakdown; click to open it."
                  testId="chronology-scatter"
                >
                  <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
                    <Figure
                      value={formatCount(
                        (resp.prs ?? []).filter((p) => p.leadWorkHours > (resp.settings!.endMinute - resp.settings!.startMinute) / 60).length,
                      )}
                      label="took more than a working day"
                    />
                    <Figure
                      value={formatShare(tenth.share)}
                      label={`of all working-hour waiting sits in the slowest ${formatCount(tenth.count)}`}
                    />
                  </div>
                  <LeadScatter
                    prs={resp.prs ?? []}
                    budgetHours={resp.settings.budgets.lead.good}
                    p75Hours={resp.p75LeadWorkHours ?? 0}
                  />
                  {resp.prsCapped && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Showing {formatCount(resp.prs?.length ?? 0)} of {formatCount(model.measuredPrs)}:
                      every slow pull request, and an even sample of the rest.
                    </p>
                  )}
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
                  note="The slowest quarter against the fastest, then lead time by size and by the day a pull request opened."
                  testId="chronology-contrast"
                >
                  <div className="space-y-5">
                    {resp.contrast != null ? (
                      <ContrastTable contrast={resp.contrast} />
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
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
                  note="Pull requests that sat approved for more than a working day before they merged."
                  testId="chronology-landing"
                >
                  <LandingTailList tail={resp.landingTail} />
                </Block>
              )}

              {(resp.concentration?.length ?? 0) > 0 && (
                <Block
                  title="Who gives the first review"
                  note="Per repository, how much of the first reviewing rests on one person, and whether pull requests waited longer when it was them."
                  testId="chronology-concentration"
                >
                  <ConcentrationTable rows={resp.concentration ?? []} />
                </Block>
              )}

              {resp.requests != null && (
                <Block
                  title="Asking for a review"
                  note="Whether a named person, a team or nobody was asked first, and how soon somebody looked."
                  testId="chronology-requests"
                >
                  <RequestsTable stats={resp.requests} />
                </Block>
              )}

              {/* The one model-written block — AI palette, never a figure, every citation checked. */}
              <FlowPointersPanel workspaceId={workspaceId} days={windowDays} />

              {(resp.prs?.length ?? 0) > 0 && (
                <Block
                  title="Where each pull request sits"
                  note="For context, not as a target. A pull request approved on its first review never goes back to its author and sits on the right-hand edge — that is the best case, and it is far from the middle."
                  testId="chronology-triangle"
                >
                  <div className="mb-2">
                    <Figure
                      value={`${formatCount(neverWentBack(resp.prs ?? []))} of ${formatCount(resp.prs?.length ?? 0)}`}
                      label="never went back to their author"
                    />
                  </div>
                  <CourtTriangle prs={resp.prs ?? []} overall={resp.courtsWork ?? []} />
                </Block>
              )}

              <div className="pt-2">
                <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                  By repository, in clock hours
                </h4>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Nights and weekends included. A repository is called out only when one court holds
                  at least half the time and the slowest quarter took eight clock hours or more.
                </p>
              </div>
            </>
          )}

          {/* ── The clock-hour headline: one sentence, the whole workspace ─────────────── */}
          <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <CourtBar courts={model.courts} />
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              {COURT_ORDER.map((court) => {
                const c = model.courts.find((x) => x.court === court);
                return (
                  <span key={court} className="inline-flex items-baseline gap-1.5">
                    <span className={`text-lg font-semibold tabular-nums ${COURT_TEXT[court]}`}>
                      {formatPct(c?.share ?? 0)}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">
                      {COURT_LABEL[court].toLowerCase()}
                    </span>
                  </span>
                );
              })}
            </div>
            {model.headline != null && (
              <p className="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                {model.headline}
              </p>
            )}
          </section>

          {/* ── One section per court, advice stated ONCE ──────────────────────────────── */}
          {model.sections.map((section) => (
            <section key={section.court} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-sm ${COURT_BAR[section.court]}`} />
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {section.label}
                </h4>
                <span className="text-[11px] text-gray-400">
                  {section.repos.length}{' '}
                  {section.repos.length === 1 ? 'repository' : 'repositories'}
                </span>
              </div>
              {/* ⚠ THE ADVICE LIVES HERE, ONCE. It is a property of the COURT, not of a repository:
                  putting it on every row produced six identical paragraphs on a real workspace,
                  which is the restatement problem that made the old path findings worthless. */}
              {section.directive !== '' && (
                <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                  {section.directive}
                </p>
              )}
              <ul className="space-y-2">
                {section.repos.map((r) => (
                  <RepoRow key={r.repoId} repo={r} />
                ))}
              </ul>
            </section>
          ))}

          {/* ── Merged without a human review ──────────────────────────────────────────── */}
          {model.unreviewed.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Merged without a human review
              </h4>
              <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                These landed with no review, comment or approval from a person. That is a branch
                protection setting, not a habit — and it is counted over work a person wrote, so
                automation’s own pull requests are not inflating it.
              </p>
              <ul className="space-y-2">
                {model.unreviewed.map((u) => (
                  <li
                    key={u.repoId}
                    className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">
                        {u.repoFullName}
                      </span>
                      <span className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
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
            </section>
          )}

          {/* ── Quiet repos, and the refusals ──────────────────────────────────────────── */}
          {model.quiet.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Nothing stands out
              </h4>
              <ul className="space-y-1.5">
                {model.quiet.map((r) => (
                  <li
                    key={r.repoId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-gray-200 px-3 py-2 dark:border-gray-800"
                  >
                    <CheckCircleIcon size={12} className="shrink-0 text-gray-400" />
                    <span className="font-mono text-[11px] text-gray-600 dark:text-gray-300">
                      {r.repoFullName}
                    </span>
                    <span className="w-24 shrink-0">
                      <CourtBar courts={r.courts} />
                    </span>
                    <span className="ml-auto text-[11px] tabular-nums text-gray-400">
                      {r.prs} PRs · p75 {formatHours(r.p75LeadHours)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ⚠ REFUSALS RENDER BY NAME. An absent section asserts "we checked and there is nothing
              here", which is a much stronger claim than either thing that actually happened. */}
          {model.refusals.map((r) => (
            <p
              key={r.kind}
              data-testid="bottleneck-refusal"
              className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400"
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

          <div className="pt-1">
            <Legend />
          </div>
        </>
      )}
    </div>
  );
}
