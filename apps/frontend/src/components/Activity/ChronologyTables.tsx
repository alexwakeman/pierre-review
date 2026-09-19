import type {
  FlowConcentrationRow,
  FlowContrast,
  FlowContrastRow,
  FlowLandingTail,
  FlowPrLink,
  FlowPrRow,
  FlowRequestKind,
  FlowRequestStats,
  FlowSizeBand,
  FlowWeekdayRow,
} from '@pierre-review/shared';
import { safeExternalUrl } from '../../lib/ui.js';
import { ExternalLinkIcon, PullRequestIcon, WarningIcon } from '../Icons.js';
import { COURT_SHORT } from './bottlenecksModel.js';
import { Figure, useOpenFlowPr } from './ChronologyCharts.js';
import {
  dayLong,
  formatCount,
  formatShare,
  formatWorkHours,
  lookedBeforeAskedLine,
  requestCoverageLine,
} from './chronologyModel.js';

// Chronology's per-PR tables. Every figure is formatted here; every SENTENCE is the server's, and
// only where it is not a restatement of the table beside it — how each table is read lives behind
// its panel's "i" (chronologyInfo.tsx). The one-line disclosures under a table state a COUNT from
// the wire, never a finding.
//
// ⚠ NO PERSON. The concentration table carries a share and two medians per repository and never a
// name — the server sends none, and a reader who wants to know who it is can ask the team.

const TH = 'px-2 py-1.5 text-left text-[11px] font-medium text-gray-500 dark:text-gray-400';
/** A one-line disclosure under a table or list: a count, in a sentence. */
const NOTE = 'mt-1 text-xs text-gray-500 dark:text-gray-400';
const TD = 'px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200';
const NUM = 'text-right tabular-nums';

/** A pull request as a button that opens it in the app, with GitHub one click further. */
export function PrLink({ pr }: { pr: FlowPrLink }): JSX.Element {
  const open = useOpenFlowPr();
  const href = safeExternalUrl(pr.githubUrl);
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <button
        type="button"
        onClick={() => open(pr)}
        title={pr.prTitle}
        className="inline-flex min-w-0 items-baseline gap-1 text-left font-medium text-sky-700 hover:underline dark:text-sky-400"
      >
        <PullRequestIcon size={11} className="shrink-0 self-center" />
        <span className="shrink-0 whitespace-nowrap">
          {pr.repoFullName.split('/').pop()} #{pr.prNumber}
        </span>
        <span className="truncate font-normal text-gray-600 dark:text-gray-300">{pr.prTitle}</span>
      </button>
      {href != null && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on GitHub"
          aria-label={`Open ${pr.repoFullName} #${pr.prNumber} on GitHub`}
          className="shrink-0 self-center text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ExternalLinkIcon size={11} />
        </a>
      )}
    </span>
  );
}

// ── The fastest quarter against the slowest ───────────────────────────────────────────────────

function contrastValue(row: FlowContrastRow, v: number): string {
  if (row.unit === 'percent') return formatShare(v);
  if (row.unit === 'workHours') return formatWorkHours(v);
  return formatCount(Math.round(v));
}

const CONTRAST_VERDICT: Record<FlowContrastRow['verdict'], string> = {
  separates: 'Separates',
  weak: 'Weakly',
  none: 'No',
};

export function ContrastTable({ contrast }: { contrast: FlowContrast }): JSX.Element {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className={TH}>Median, or share of pull requests</th>
              <th className={`${TH} ${NUM}`}>Fastest quarter</th>
              <th className={`${TH} ${NUM}`}>Slowest quarter</th>
              <th className={`${TH} ${NUM}`}>Sets them apart?</th>
            </tr>
          </thead>
          <tbody>
            {contrast.rows.map((r) => (
              <tr key={r.signal} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/70">
                <td className={TD}>{r.label}</td>
                <td className={`${TD} ${NUM}`}>{contrastValue(r, r.fast)}</td>
                <td className={`${TD} ${NUM} font-semibold`}>{contrastValue(r, r.slow)}</td>
                <td
                  className={`${TD} ${NUM} ${
                    r.verdict === 'separates'
                      ? 'font-medium text-gray-900 dark:text-gray-50'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {CONTRAST_VERDICT[r.verdict]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={NOTE}>{formatCount(contrast.quartilePrs)} pull requests in each quarter.</p>
    </div>
  );
}

// ── Lead time by size, and by the day it opened ───────────────────────────────────────────────

function HBar({ value, max, className }: { value: number | null; max: number; className: string }): JSX.Element {
  const w = value == null || max <= 0 ? 0 : Math.max(1.5, Math.min(100, (value / max) * 100));
  return (
    <div className="h-2.5 w-full rounded-sm bg-gray-100 dark:bg-gray-800">
      <div className={`h-full rounded-sm ${className}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export function SizeBandsChart({ bands }: { bands: FlowSizeBand[] }): JSX.Element {
  const max = Math.max(1, ...bands.map((b) => b.medianLeadWorkHours ?? 0));
  return (
    <div className="space-y-2">
      {bands.map((b) => (
        <div key={b.label}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-gray-700 dark:text-gray-200">{b.label}</span>
            <span className="tabular-nums text-gray-500 dark:text-gray-400">
              {b.medianLeadWorkHours == null ? (
                b.prs === 0 ? 'none' : `${b.prs} — too few for a median`
              ) : (
                <>
                  <span className="font-semibold text-gray-800 dark:text-gray-100">
                    {formatWorkHours(b.medianLeadWorkHours)}
                  </span>{' '}
                  · first look {formatWorkHours(b.medianFirstLookWorkHours ?? 0)} ·{' '}
                  {formatCount(b.prs)} PRs
                </>
              )}
            </span>
          </div>
          <HBar value={b.medianLeadWorkHours} max={max} className="bg-gray-700 dark:bg-gray-300" />
        </div>
      ))}
    </div>
  );
}

export function WeekdayChart({ days }: { days: FlowWeekdayRow[] }): JSX.Element {
  const shown = days.filter((d) => d.working || d.prs > 0);
  const max = Math.max(1, ...shown.map((d) => Math.max(d.medianLeadHours ?? 0, d.medianLeadWorkHours ?? 0)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-gray-400 dark:bg-gray-500" />
          on the clock
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-gray-800 dark:bg-gray-100" />
          working hours
        </span>
      </div>
      {shown.map((d) => (
        <div key={d.weekday}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-gray-700 dark:text-gray-200">
              {dayLong(d.weekday)}
              {!d.working && <span className="text-gray-500 dark:text-gray-400"> (not a working day)</span>}
            </span>
            <span className="tabular-nums text-gray-500 dark:text-gray-400">
              {d.medianLeadWorkHours == null ? (
                d.prs === 0 ? 'none' : `${d.prs} — too few for a median`
              ) : (
                <>
                  {formatWorkHours(d.medianLeadHours ?? 0)} ·{' '}
                  <span className="font-semibold text-gray-800 dark:text-gray-100">
                    {formatWorkHours(d.medianLeadWorkHours)}
                  </span>{' '}
                  · {formatCount(d.prs)} PRs
                </>
              )}
            </span>
          </div>
          <div className="space-y-0.5">
            <HBar value={d.medianLeadHours} max={max} className="bg-gray-400 dark:bg-gray-500" />
            <HBar value={d.medianLeadWorkHours} max={max} className="bg-gray-800 dark:bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Approved and waiting ─────────────────────────────────────────────────────────────────────

export function LandingTailList({ tail }: { tail: FlowLandingTail }): JSX.Element {
  // Nothing waited: the server's one sentence is the whole finding. Otherwise the figures say it,
  // and the sentence (which restates them) stays on the wire.
  if (tail.prsOver === 0) {
    return <p className="text-xs text-gray-700 dark:text-gray-300">{tail.sentence}</p>;
  }
  const siblingsOver = tail.siblingsOver ?? 0;
  return (
    <div>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <Figure value={formatCount(tail.prsOver)} label="sat approved over a working day" />
        <Figure value={formatShare(tail.shareOfLanding)} label="of all time spent approved" />
        {tail.selfMergedOver > 0 && (
          <Figure value={formatCount(tail.selfMergedOver)} label="merged by their own author" />
        )}
        {/* "Merged alongside", the rows' own words: counted only when the other pull request
            merged while this one waited, not whenever the two share a ticket. */}
        {siblingsOver > 0 && (
          <Figure
            value={formatCount(siblingsOver)}
            label="merged alongside a pull request in another repository"
          />
        )}
      </div>
      {tail.rows.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800/70">
          {tail.rows.map((r) => (
            <li key={r.prId} className="py-1.5 text-xs">
              <div className="flex items-baseline gap-2">
                <PrLink pr={r} />
                <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  <span className="font-semibold text-gray-800 dark:text-gray-100">
                    {formatWorkHours(r.landWorkHours)}
                  </span>{' '}
                  working · {formatWorkHours(r.landHours)} on the clock
                </span>
              </div>
              {(r.selfMerged || r.ticketKey != null) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-[11px] text-gray-500 dark:text-gray-400">
                  {r.selfMerged && <span>Merged by its author</span>}
                  {r.ticketKey != null && <span className="font-mono">{r.ticketKey}</span>}
                  {r.siblings.length > 0 && (
                    <span className="inline-flex flex-wrap items-baseline gap-x-2">
                      <span>merged alongside:</span>
                      {r.siblings.map((s) => (
                        <PrLink key={s.prId} pr={{ ...s, prTitle: '' }} />
                      ))}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {tail.prsOver > tail.rows.length && (
        <p className={NOTE}>
          Showing the {formatCount(tail.rows.length)} slowest of {formatCount(tail.prsOver)}.
        </p>
      )}
    </div>
  );
}

// ── Who does the first review — without naming anyone ─────────────────────────────────────────

export function ConcentrationTable({ rows }: { rows: FlowConcentrationRow[] }): JSX.Element {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className={TH}>Repository</th>
              <th className={`${TH} ${NUM}`}>People giving first reviews</th>
              <th className={`${TH} ${NUM}`}>Busiest one’s share</th>
              <th className={`${TH} ${NUM}`}>Their first look</th>
              <th className={`${TH} ${NUM}`}>Everyone else’s</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.repoId} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/70">
                <td className={`${TD} font-mono`}>{r.repoFullName}</td>
                <td className={`${TD} ${NUM}`}>{r.firstReviewers}</td>
                <td className={`${TD} ${NUM} font-semibold`}>
                  {formatShare(r.topShare)}
                  <span className="font-normal text-gray-500 dark:text-gray-400"> of {r.prs}</span>
                </td>
                <td className={`${TD} ${NUM}`}>
                  <span className="inline-flex items-center justify-end gap-1">
                    {r.slower && <WarningIcon size={11} className="text-amber-700 dark:text-amber-400" />}
                    {r.topFirstLookWorkHours == null ? '—' : formatWorkHours(r.topFirstLookWorkHours)}
                    {r.slower && <span className="text-amber-700 dark:text-amber-400">slower</span>}
                  </span>
                </td>
                <td className={`${TD} ${NUM}`}>
                  {r.othersFirstLookWorkHours == null ? '—' : formatWorkHours(r.othersFirstLookWorkHours)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── The slowest, as a table — the scatter's keyboard and screen-reader view ────────────────────

export function SlowestTable({ prs }: { prs: FlowPrRow[] }): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-800">
            <th className={TH}>Pull request</th>
            <th className={`${TH} ${NUM}`}>Working</th>
            <th className={`${TH} ${NUM}`}>{COURT_SHORT.reviewer}</th>
            <th className={`${TH} ${NUM}`}>{COURT_SHORT.author}</th>
            <th className={`${TH} ${NUM}`}>{COURT_SHORT.landing}</th>
            <th className={`${TH} ${NUM}`}>Lines</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((p) => (
            <tr key={p.prId} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/70">
              <td className={`${TD} max-w-[18rem]`}>
                <PrLink pr={p} />
              </td>
              <td className={`${TD} ${NUM} font-semibold`}>{formatWorkHours(p.leadWorkHours)}</td>
              <td className={`${TD} ${NUM}`}>{formatWorkHours(p.workHours.reviewer)}</td>
              <td className={`${TD} ${NUM}`}>{formatWorkHours(p.workHours.author)}</td>
              <td className={`${TD} ${NUM}`}>{formatWorkHours(p.workHours.landing)}</td>
              <td className={`${TD} ${NUM}`}>{p.lines == null ? '—' : formatCount(p.lines)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Asking for a review: a named person, a team, or nobody ───────────────────────────────────

const REQUEST_ROW_LABEL: Record<FlowRequestKind, string> = {
  person: 'A named person',
  team: 'A team',
  none: 'Nobody',
};

export function RequestsTable({ stats }: { stats: FlowRequestStats }): JSX.Element {
  const coverage = requestCoverageLine(stats);
  const lookedFirst = lookedBeforeAskedLine(stats);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className={TH}>Asked first</th>
              <th className={`${TH} ${NUM}`}>Pull requests</th>
              <th className={`${TH} ${NUM}`}>Request to first look</th>
              <th className={`${TH} ${NUM}`}>Opened to first look</th>
            </tr>
          </thead>
          <tbody>
            {stats.rows.map((r) => (
              <tr key={r.kind} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/70">
                <td className={TD}>{REQUEST_ROW_LABEL[r.kind]}</td>
                <td className={`${TD} ${NUM}`}>{formatCount(r.prs)}</td>
                <td className={`${TD} ${NUM} font-semibold`}>
                  {r.kind === 'none' ? '—' : r.medianRequestToLookWorkHours == null ? '—' : formatWorkHours(r.medianRequestToLookWorkHours)}
                </td>
                <td className={`${TD} ${NUM}`}>
                  {r.medianFirstLookWorkHours == null ? '—' : formatWorkHours(r.medianFirstLookWorkHours)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {coverage != null && <p className={NOTE}>{coverage}</p>}
      {lookedFirst != null && <p className={NOTE}>{lookedFirst}</p>}
    </div>
  );
}
