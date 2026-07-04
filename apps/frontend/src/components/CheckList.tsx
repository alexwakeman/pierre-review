import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CheckRun, CiRerunMode } from '@pierre-review/shared';
import { CHECK_STATE_META } from '../lib/ui.js';
import { api } from '../api/client.js';
import { useRerunCi, type RerunOutcome } from '../hooks/useCiRerun.js';

// A GitHub Actions check's detailsUrl is .../actions/runs/<runId>/job/<jobId>. The
// backend parses jobId/runId into fields, but we ALSO derive them from the url here so
// a PR detail cached before those fields shipped (url present, ids absent) still gets
// the log viewer / re-run affordance instead of degrading to a plain link.
const ACTIONS_JOB_RE = /\/actions\/runs\/\d+\/job\/(\d+)/;
const ACTIONS_RUN_RE = /\/actions\/runs\/(\d+)/;

export function jobIdOf(check: CheckRun): number | null {
  if (check.jobId != null) return check.jobId;
  const m = check.url ? ACTIONS_JOB_RE.exec(check.url) : null;
  return m ? Number(m[1]) : null;
}

export function runIdOf(check: CheckRun): number | null {
  if (check.runId != null) return check.runId;
  const m = check.url ? ACTIONS_RUN_RE.exec(check.url) : null;
  return m ? Number(m[1]) : null;
}

// One check row. A FAILED GitHub Actions check (it resolves a jobId from its
// detailsUrl) becomes a click-to-expand inline log viewer — the tail of the job's
// logs, fetched on demand and auto-scrolled to the bottom (the failure is at the end).
// Everything else keeps the original external-link/plain row.
export function CheckRow({
  prId,
  check,
}: {
  prId: number;
  check: CheckRun;
}): JSX.Element {
  const m = CHECK_STATE_META[check.state];
  const jobId = jobIdOf(check);
  const loggable =
    jobId != null && (check.state === 'failure' || check.state === 'error');
  const [expanded, setExpanded] = useState(false);
  const logs = useQuery({
    queryKey: ['check-logs', prId, jobId],
    queryFn: () => api.checkLogs(prId, jobId!, 200),
    enabled: expanded && loggable,
    staleTime: Infinity, // a finished job's logs are immutable
    gcTime: 5 * 60_000,
  });
  const preRef = useRef<HTMLPreElement>(null);
  // Scroll to the bottom once the logs render — the failure is at the tail.
  useLayoutEffect(() => {
    if (expanded && logs.data?.available) {
      const el = preRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [expanded, logs.data]);

  const dot = (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: m.color }}
      title={m.label}
    >
      {m.icon}
    </span>
  );
  const gitHubLink = check.url ? (
    <a
      href={check.url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-blue-500 hover:underline"
    >
      Open on GitHub ↗
    </a>
  ) : null;

  if (!loggable) {
    const inner = (
      <span className="flex items-center gap-2">
        {dot}
        <span className="min-w-0 truncate" title={check.name}>
          {check.name}
        </span>
        <span className="ml-auto shrink-0 text-xs text-gray-400">{m.label}</span>
      </span>
    );
    return (
      <li className="text-xs">
        {check.url ? (
          <a
            href={check.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {inner}
          </a>
        ) : (
          <div className="px-1 py-0.5">{inner}</div>
        )}
      </li>
    );
  }

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="block w-full rounded px-1 py-0.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <span className="flex items-center gap-2">
          {dot}
          <span className="min-w-0 truncate" title={check.name}>
            {check.name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-gray-400">
            <span className="text-xs">{m.label}</span>
            <span className="text-[10px] font-medium text-blue-500">
              {expanded ? '▾ hide logs' : '▸ logs'}
            </span>
          </span>
        </span>
      </button>
      {expanded && (
        <div className="mb-1 mt-1">
          {logs.isLoading ? (
            <div className="px-1 py-2 text-gray-400">Loading logs…</div>
          ) : logs.data?.available ? (
            <>
              <div className="mb-1 flex items-center justify-between px-1 text-[10px] text-gray-400">
                <span>
                  last {logs.data.returnedLines} of {logs.data.totalLines} lines
                </span>
                {gitHubLink}
              </div>
              <pre
                ref={preRef}
                className="max-h-[40rem] overflow-auto whitespace-pre rounded bg-gray-900 p-2 font-mono text-[11px] leading-[1.45] text-gray-100"
              >
                {logs.data.text || '(empty log)'}
              </pre>
            </>
          ) : (
            <div className="px-1 py-2 text-gray-400">
              {logs.data?.reason ?? "Couldn't load logs."} {gitHubLink}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// The list of checks (used on the Overview tab and the AI Analysis and Fix tab).
export function ChecksList({
  prId,
  checks,
}: {
  prId: number;
  checks: CheckRun[];
}): JSX.Element {
  return (
    <ul className="space-y-1">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} prId={prId} check={c} />
      ))}
    </ul>
  );
}

// Distinct Actions run ids among a set of checks (optionally only the failed ones).
function distinctRunIds(checks: CheckRun[], failedOnly: boolean): number[] {
  const ids = new Set<number>();
  for (const c of checks) {
    if (failedOnly && c.state !== 'failure' && c.state !== 'error') continue;
    const runId = runIdOf(c);
    if (runId != null) ids.add(runId);
  }
  return [...ids];
}

// "Re-run failed jobs" (primary) + "Re-run all jobs" (secondary) for a PR's GitHub
// Actions runs. Rendered only for viewers with write access when there's at least one
// rerunnable Actions run. GitHub queues the rerun asynchronously, so we confirm
// "re-run requested" rather than showing live progress (checks refresh on next sync).
export function CiRerunControl({
  prId,
  checks,
  viewerCanPush,
}: {
  prId: number;
  checks: CheckRun[];
  viewerCanPush: boolean;
}): JSX.Element | null {
  const rerun = useRerunCi(prId);
  const [outcome, setOutcome] = useState<RerunOutcome | null>(null);

  const allRunIds = distinctRunIds(checks, false);
  const failedRunIds = distinctRunIds(checks, true);
  if (!viewerCanPush || allRunIds.length === 0) return null;

  const fire = (mode: CiRerunMode, runIds: number[]): void => {
    if (runIds.length === 0) return;
    setOutcome(null);
    rerun.mutate({ runIds, mode }, { onSuccess: (o) => setOutcome(o) });
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        disabled={rerun.isPending || failedRunIds.length === 0}
        onClick={() => fire('failed', failedRunIds)}
        title="Re-run only the failed jobs of the failing workflow run(s)"
      >
        {rerun.isPending ? 'Requesting…' : 'Re-run failed jobs'}
      </button>
      <button
        type="button"
        className="whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        disabled={rerun.isPending}
        onClick={() => fire('all', allRunIds)}
        title="Re-run the entire workflow run(s) from scratch"
      >
        Re-run all jobs
      </button>
      {outcome && !rerun.isPending && (
        <span className="text-[11px] text-gray-500">
          Re-run requested — CI updates on the next sync.
          {outcome.failed > 0 &&
            ` (${outcome.failed} run${
              outcome.failed === 1 ? '' : 's'
            } couldn't be re-run.)`}
        </span>
      )}
      {rerun.isError && (
        <span className="text-[11px] text-red-500">
          {rerun.error instanceof Error ? rerun.error.message : 'Re-run failed'}
        </span>
      )}
    </div>
  );
}
