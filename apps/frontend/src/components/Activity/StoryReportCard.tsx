import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  STORY_REPORT_DEFAULT_WINDOW,
  STORY_REPORT_ERROR_LABEL,
  STORY_REPORT_GROUP_LABEL,
  STORY_REPORT_GROUPS,
  STORY_REPORT_MODEL,
  STORY_REPORT_WINDOW_CHOICES,
  type ReportingWindowInfo,
  type StoryReportBody,
  type StoryReportCandidate,
  type StoryReportPoint,
  type StoryReportRecord,
  type StoryReportWindowChoice,
} from '@pierre-review/shared';
import {
  useCancelStoryReport,
  useStartStoryReport,
  useStoryReport,
  useStoryReports,
  useStoryReportsOn,
  useStoryReportStarting,
} from '../../hooks/useStories.js';
import { AiRunGate } from '../AiSetup.js';
import { writeClipboard } from '../CopyButton.js';
import { CheckIcon, ChevronIcon, CopyIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { RegenProgressBar } from './RegenProgressBar.js';
import {
  indexCandidates,
  linkifyTicketKeys,
  STORY_REPORT_SECTION_TITLE,
  storyReportDate,
  storyReportFigures,
  pointIssueLabel,
  storyReportMarkdown,
  storyReportRangeDates,
  storyReportSections,
  storyReportWindowLabel,
  ticketHref,
  type CandidateIndex,
} from './storyReportModel.js';

// Reports → Stories → THE STORY REPORT (core, agentic, local-only, Pro on `periodReports`).
//
// ⚠ HIDDEN, NOT LOCKED, WITHOUT AGENTIC AI: `useStoryReportsOn()` is false in cloud and under
// `LIMN_AI_DISABLED=true`, and the card renders nothing (the tab keeps its lists and charts). A
// missing runtime or credential swaps only the button, through the ONE `AiRunGate`.
// ⚠ THE FIGURES ROW IS CODE, THE PROSE IS CLAUDE — styled apart, and the figures read the STORED
// population of the run, so they always describe the same window the text does.
// ⚠ EVERY EXPLANATION SITS BEHIND AN ⓘ — no caption paragraphs (Product voice).
// ⚠ A KEY IS A LINK ONLY WHEN IT IS ONE OF THE RUN'S PICKS (`linkifyTicketKeys`).

const MUTED = 'text-gray-500 dark:text-gray-400';
const BODY = 'text-gray-700 dark:text-gray-200';

function modelName(model: string): string {
  return model === STORY_REPORT_MODEL ? 'Haiku 5.5' : model;
}

export function StoryReportCard({
  workspaceId,
  reportingWindow,
}: {
  workspaceId: number | null;
  /** The workspace's reporting window (from GET /api/stories), to name the 'reporting' option. */
  reportingWindow: ReportingWindowInfo | null;
}): JSX.Element | null {
  const on = useStoryReportsOn();
  const [picked, setPicked] = useState<{ workspaceId: number | null; choice: StoryReportWindowChoice } | null>(null);
  // Derived, never written back: a pick made in another workspace reads as the default.
  const choice = picked != null && picked.workspaceId === workspaceId ? picked.choice : STORY_REPORT_DEFAULT_WINDOW;
  const q = useStoryReports(workspaceId, choice);
  const data = q.data;
  const running = data?.running ?? null;
  const runningHere = running != null && data != null && running.workspaceId === data.workspaceId && running.window === choice;
  const run = useStoryReport(runningHere ? running.id : null);
  const live = run.data?.report ?? null;
  const active = runningHere && (live == null || live.status === 'queued' || live.status === 'running');
  const starting = useStoryReportStarting(workspaceId, choice);
  const start = useStartStoryReport(workspaceId, choice);
  const cancel = useCancelStoryReport();
  // One mutation observer serves every (workspace, window): its error belongs to the pair it was
  // started for, so a new pair clears it (a 409/422 from one window must not show under another).
  const resetStart = start.reset;
  useEffect(() => {
    resetStart();
  }, [resetStart, workspaceId, choice]);

  if (!on) return null;
  if (data != null && !data.trackerOn) return null;

  const optionLabel = (c: StoryReportWindowChoice): string =>
    storyReportWindowLabel(c, c === 'reporting' ? (data?.range.reporting ?? reportingWindow) : null);

  const report = data?.report ?? null;
  const latest = data?.latest ?? null;
  const lastFailed =
    latest != null && latest.id !== report?.id && (latest.status === 'failed' || latest.status === 'cancelled')
      ? latest
      : null;

  let action: ReactNode = null;
  if (data == null) {
    action = null;
  } else if (active || starting) {
    action = (
      <div className="flex w-full items-center gap-2 sm:w-64">
        <div className="flex-1">
          <RegenProgressBar active label="Writing the report" timeConstantSec={20} sub="Writing…" />
        </div>
        {runningHere && (
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(running.id)}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
          >
            Cancel
          </button>
        )}
      </div>
    );
  } else if (running != null && !runningHere) {
    const sameWs = running.workspaceId === data.workspaceId;
    action = (
      <span className={`text-xs ${BODY}`}>
        Writing a report for {sameWs ? optionLabel(running.window) : 'another workspace'}.
        {sameWs && (
          <button
            type="button"
            onClick={() => setPicked({ workspaceId, choice: running.window })}
            className="ml-1 text-sky-700 hover:underline dark:text-sky-300"
          >
            Show it
          </button>
        )}
      </span>
    );
  } else if (data.candidates.length === 0) {
    action = <span className={`text-xs ${MUTED}`}>No stories to report on in this window.</span>;
  } else {
    action = (
      <AiRunGate>
        <button
          type="button"
          onClick={() => start.mutate()}
          className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2"
        >
          <SparkleIcon size={12} className="text-ai-signal" />
          {report != null ? 'Re-write' : 'Write report'}
        </button>
      </AiRunGate>
    );
  }

  return (
    <section data-testid="story-report" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
          Story report
          <InfoButton title="Story report" width="lg">
            <HowInfo candidates={data?.candidates ?? []} />
          </InfoButton>
        </h3>
        <div role="group" aria-label="Report window" className="flex flex-wrap gap-1">
          {STORY_REPORT_WINDOW_CHOICES.map((c) => {
            const sel = c === choice;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={sel}
                onClick={() => setPicked({ workspaceId, choice: c })}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  sel
                    ? 'border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-200'
                    : 'border-gray-300 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500'
                }`}
              >
                {optionLabel(c)}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center">{action}</div>
      </div>

      {start.isError && !starting && (
        <p className="text-xs text-rose-700 dark:text-rose-400">{start.error.message || 'Could not start the report.'}</p>
      )}
      {cancel.isError && <p className="text-xs text-rose-700 dark:text-rose-400">Could not cancel the run.</p>}
      {q.isError && <p className="text-xs text-rose-700 dark:text-rose-400">Could not load the story report.</p>}
      {lastFailed != null && !active && (
        <p className="text-xs text-rose-700 dark:text-rose-400">
          {lastFailed.status === 'cancelled'
            ? 'The last run was cancelled.'
            : STORY_REPORT_ERROR_LABEL[lastFailed.error ?? 'failed']}
        </p>
      )}

      {report != null && report.report != null ? (
        <ReportView record={report} body={report.report} stale={data?.currency === 'stale'} />
      ) : (
        data != null &&
        !active &&
        !starting &&
        lastFailed == null &&
        data.candidates.length > 0 && <p className={`text-xs ${MUTED}`}>No report for this window yet.</p>
      )}
    </section>
  );
}

// ── ⓘ texts ──────────────────────────────────────────────────────────────────────────────────

function HowInfo({ candidates }: { candidates: StoryReportCandidate[] }): JSX.Element {
  return (
    <>
      <p>
        Code picks up to 19 stories from the window: some done well, some that fell short, some with no
        criteria, and a few odd ones out. A story with no criteria is never counted as falling short.
      </p>
      <p>
        Claude ({modelName(STORY_REPORT_MODEL)}) reads each picked story, its ticket review and its
        pull requests, then writes one report. It runs on your own Claude Code login or Anthropic API
        key. Nothing is posted anywhere.
      </p>
      <p>
        A report is kept until you re-write it. It is marked out of date when a picked story, its
        review or its pull requests change.
      </p>
      {candidates.length > 0 && <CandidateList title="A new report would read" candidates={candidates} />}
    </>
  );
}

function CandidateList({ title, candidates }: { title: string; candidates: StoryReportCandidate[] }): JSX.Element {
  return (
    <div>
      <p className="font-semibold">
        {title} {candidates.length} {candidates.length === 1 ? 'story' : 'stories'}
      </p>
      {STORY_REPORT_GROUPS.map((g) => {
        const rows = candidates.filter((c) => c.group === g);
        if (rows.length === 0) return null;
        return (
          <div key={g} className="mt-1">
            <div className="font-medium">{STORY_REPORT_GROUP_LABEL[g]}</div>
            <ul className="list-disc pl-4">
              {rows.map((c) => (
                <li key={c.ident}>
                  {c.key}
                  {c.whyPicked.length > 0 ? `: ${c.whyPicked.join('; ')}` : ''}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function AboutInfo({ record }: { record: StoryReportRecord }): JSX.Element {
  const dropped = record.dropped;
  const droppedTotal = dropped != null ? dropped.unknownTickets + dropped.items + dropped.overCap : 0;
  return (
    <>
      <p>
        Written by Claude ({modelName(record.model)}) on {storyReportDate(record.completedAt ?? record.createdAt)}
        {record.costUsd != null ? `, for US$${record.costUsd.toFixed(2)}` : ''}.
      </p>
      {droppedTotal > 0 && (
        <p>
          {droppedTotal} {droppedTotal === 1 ? 'item was' : 'items were'} removed because they named a
          ticket outside the picked stories, or went over the length limit.
        </p>
      )}
      <CandidateList title="It read" candidates={record.picked} />
    </>
  );
}

function FiguresInfo({ picked }: { picked: number }): JSX.Element {
  return (
    <>
      <p>
        Counted by code over every story in the window, not only the {picked} the report read.
      </p>
      <p>
        <strong>With written criteria</strong> counts tickets with a filled acceptance criteria field.
        <strong> Fully met</strong> and <strong>With gaps</strong> count tickets a ticket review checked.
        Working time runs from the first pull request opened to the last one merged, in working hours.
      </p>
      <p>
        Each story issue counts only the stories Claude has read in their current form (&ldquo;read&rdquo;). Stories
        with no criteria are counted on their own.
      </p>
    </>
  );
}

// ── The report ───────────────────────────────────────────────────────────────────────────────

function ReportView({ record, body, stale }: { record: StoryReportRecord; body: StoryReportBody; stale: boolean }): JSX.Element {
  const index = useMemo(() => indexCandidates(record.picked), [record.picked]);
  const sections = storyReportSections(body);
  const figures = storyReportFigures(record.population);
  const dates = storyReportRangeDates(record.range);
  const [showLeftOut, setShowLeftOut] = useState(false);
  return (
    <article data-testid="story-report-body" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-ai-ink">
          <SparkleIcon size={12} className="text-ai-signal" />
          Written by Claude · {storyReportDate(record.completedAt ?? record.createdAt)}
        </span>
        <span className={MUTED}>
          {storyReportWindowLabel(record.window, record.range.reporting)}
          {dates !== '' ? ` · ${dates}` : ''}
        </span>
        <InfoButton title="About this report" width="lg">
          <AboutInfo record={record} />
        </InfoButton>
        {stale && (
          <span className="rounded border border-amber-400 px-1.5 text-[11px] text-amber-800 dark:border-amber-600 dark:text-amber-300">
            Out of date: stories changed since
          </span>
        )}
        <CopyMarkdownButton record={record} />
      </div>

      <h2 className="text-xl font-semibold leading-snug text-gray-900 dark:text-gray-50">
        <LinkedText text={body.headline} index={index} />
      </h2>
      <p className={`text-sm leading-relaxed ${BODY}`}>
        <LinkedText text={body.summary} index={index} />
      </p>

      <div data-testid="story-report-figures" className="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-900">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
          Figures
          <InfoButton title="Figures">
            <FiguresInfo picked={record.picked.length} />
          </InfoButton>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          {figures.map((f) => (
            <div key={f.key}>
              <dt className="text-[11px] text-gray-600 dark:text-gray-300">{f.label}</dt>
              <dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-50">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {sections.map((key) => (
        <section key={key} className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{STORY_REPORT_SECTION_TITLE[key]}</h4>
          {key === 'doingWell' || key === 'fallingShort' ? (
            <ul className="space-y-3">
              {body[key].map((p, i) => (
                <PointItem key={i} point={p} index={index} tone={key === 'doingWell' ? 'positive' : 'negative'} />
              ))}
            </ul>
          ) : key === 'spotlights' ? (
            <ul className="space-y-3">
              {body.spotlights.map((s, i) => (
                <li key={i} className={`border-l-2 pl-3 ${s.tone === 'positive' ? 'border-emerald-500' : 'border-rose-500'}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TicketChip ticket={s.ticket} index={index} />
                    <span
                      className={`text-[11px] font-medium ${
                        s.tone === 'positive' ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {s.tone === 'positive' ? 'Good example' : 'Weak example'}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-gray-800 dark:text-gray-100">
                    <LinkedText text={s.headline} index={index} />
                  </p>
                  <p className={`mt-0.5 text-sm ${BODY}`}>
                    <LinkedText text={s.detail} index={index} />
                  </p>
                </li>
              ))}
            </ul>
          ) : key === 'themes' ? (
            <ul className="space-y-3">
              {body.themes.map((t, i) => (
                <li key={i} className="border-l-2 border-gray-300 pl-3 dark:border-gray-600">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{t.theme}</p>
                  <p className={`mt-0.5 text-sm ${BODY}`}>
                    <LinkedText text={t.detail} index={index} />
                  </p>
                  <TicketChips tickets={t.tickets} index={index} />
                </li>
              ))}
            </ul>
          ) : (
            <ol className="list-decimal space-y-2 pl-5">
              {body.actions.map((a, i) => (
                <li key={i} className="text-sm text-gray-800 dark:text-gray-100">
                  <span className="font-medium">{a.action}</span>
                  <p className={`mt-0.5 ${BODY}`}>
                    <LinkedText text={a.why} index={index} />
                  </p>
                  <TicketChips tickets={a.tickets} index={index} />
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}

      {body.leftOut.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showLeftOut}
            onClick={() => setShowLeftOut((o) => !o)}
            className={`inline-flex items-center gap-1 text-xs ${BODY} hover:underline`}
          >
            <ChevronIcon dir={showLeftOut ? 'down' : 'right'} size={10} />
            Not covered ({body.leftOut.length})
          </button>
          {showLeftOut && (
            <ul className={`mt-1 space-y-1 pl-4 text-xs ${BODY}`}>
              {body.leftOut.map((l, i) => (
                <li key={i}>
                  <TicketChip ticket={l.ticket} index={index} /> {l.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

function PointItem({ point, index, tone }: { point: StoryReportPoint; index: CandidateIndex; tone: 'positive' | 'negative' }): JSX.Element {
  const issue = pointIssueLabel(point, tone);
  return (
    <li className={`border-l-2 pl-3 ${tone === 'positive' ? 'border-emerald-500' : 'border-rose-500'}`}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-gray-800 dark:text-gray-100">
        <span>{point.title}</span>
        {issue != null && (
          <span className="rounded border border-gray-300 px-1.5 text-[11px] font-medium text-gray-700 dark:border-gray-700 dark:text-gray-200">
            {issue}
          </span>
        )}
      </p>
      <p className={`mt-0.5 text-sm ${BODY}`}>
        <LinkedText text={point.detail} index={index} />
      </p>
      <TicketChips tickets={point.tickets} index={index} />
    </li>
  );
}

function LinkedText({ text, index }: { text: string; index: CandidateIndex }): JSX.Element {
  return (
    <>
      {linkifyTicketKeys(text, index).map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : s.href != null ? (
          <a key={i} href={s.href} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-300">
            {s.key}
          </a>
        ) : (
          <span key={i}>{s.key}</span>
        ),
      )}
    </>
  );
}

function TicketChip({ ticket, index }: { ticket: string; index: CandidateIndex }): JSX.Element {
  const href = ticketHref(ticket, index);
  const cls = 'rounded border border-gray-300 px-1.5 text-[11px] font-medium dark:border-gray-700';
  return href != null ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${cls} text-sky-700 hover:underline dark:text-sky-300`}>
      {ticket}
    </a>
  ) : (
    <span className={`${cls} text-gray-700 dark:text-gray-200`}>{ticket}</span>
  );
}

function TicketChips({ tickets, index }: { tickets: string[]; index: CandidateIndex }): JSX.Element | null {
  if (tickets.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tickets.map((t) => (
        <TicketChip key={t} ticket={t} index={index} />
      ))}
    </div>
  );
}

function CopyMarkdownButton({ record }: { record: StoryReportRecord }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onCopy = (): void => {
    void writeClipboard(storyReportMarkdown(record)).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      window.setTimeout(() => setState('idle'), 1600);
    });
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className="ml-auto inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
    >
      {state === 'copied' ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy as Markdown'}
    </button>
  );
}
