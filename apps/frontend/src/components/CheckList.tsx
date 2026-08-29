import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CheckRun, CiRerunMode } from '@pierre-review/shared';
import { CHECK_STATE_META, safeExternalUrl } from '../lib/ui.js';
import { useRerunCi, type RerunOutcome } from '../hooks/useCiRerun.js';
import {
  formatLogBytes,
  joinLogPages,
  useCheckLogs,
} from '../hooks/useCheckLogs.js';
import { ArrowIcon, ChevronIcon, ExternalLinkIcon } from './Icons.js';

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

// Where a check's name points. TWO cases, and they are deliberately not blurred:
//
//   • THE CHECK'S OWN URL (`own: true`) — `CheckRun.url`, which sync/upsert.ts's
//     `checkRunsFrom` fills from GraphQL `CheckRun.detailsUrl` (or `StatusContext.targetUrl`
//     for a legacy commit status). For GitHub Actions that IS the workflow-run job page
//     (.../actions/runs/<runId>/job/<jobId>) — the run a human actually wants — and for
//     third-party CI it is the vendor's own build page. There is no `html_url` on the wire:
//     the GraphQL selection only asks for detailsUrl/targetUrl, and for Actions the check-run
//     html url merely redirects to this same job page anyway.
//     ⚠ THIRD-PARTY SUPPLIED — ANY CI vendor writes detailsUrl — so it goes through
//     safeExternalUrl(), which allowlists http(s) and yields undefined for everything else.
//     React renders a `javascript:` href with nothing but a console warning.
//
//   • NO USABLE URL (`own: false`) — the field is null (a status context posted without a
//     targetUrl, or a payload from before the column shipped) or safeExternalUrl rejected it.
//     We then link the PR's OWN checks page, which always exists and always lands on this
//     same set of checks, rather than rendering a dead `<a href={undefined}>` or dropping the
//     affordance for that one row. `pr.githubUrl` is OUR value (GitHub's PR html url off our
//     row), not vendor-supplied, so it needs no sanitising — the same reasoning as
//     `${pr.githubUrl}/files` in ChangesTab.
function checkHref(check: CheckRun, prGithubUrl: string): { href: string; own: boolean } {
  const own = safeExternalUrl(check.url);
  return own ? { href: own, own: true } : { href: `${prGithubUrl}/checks`, own: false };
}

// One check row. ANY GitHub Actions check (it resolves a jobId from its detailsUrl)
// becomes a click-to-expand inline log viewer — the TAIL of the job's logs, fetched on
// demand and auto-scrolled to the bottom, with scrolling UP pulling in the earlier
// chunks. Deliberately NOT restricted to failed checks: GitHub serves logs for every
// Actions job, and "why was this green / what did it actually run" is a real question.
// Third-party checks carry only an external detailsUrl (no job id, no downloadable log),
// so they keep the original external-link/plain row.
//
// EVERY row's name is a link (see checkHref) — a check the reader can see but not open is
// a dead end, and "where did this actually run" is the first question a red check raises.
export function CheckRow({
  prId,
  prGithubUrl,
  check,
}: {
  prId: number;
  prGithubUrl: string;
  check: CheckRun;
}): JSX.Element {
  const m = CHECK_STATE_META[check.state];
  const link = checkHref(check, prGithubUrl);
  const jobId = jobIdOf(check);
  const loggable = jobId != null;
  const [expanded, setExpanded] = useState(false);
  const logs = useCheckLogs(prId, jobId, expanded && loggable);
  const view = joinLogPages(logs.data?.pages);

  const preRef = useRef<HTMLPreElement>(null);
  // Set just before a "load earlier" fetch so the prepended chunk can be pinned: we
  // restore the DISTANCE FROM THE BOTTOM, which is what stays constant when content is
  // added above. Without this the viewport jumps to a different part of the log every
  // time a page lands.
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const bottomedRef = useRef(false);
  const pageCount = logs.data?.pages.length ?? 0;
  const text = view?.text ?? '';

  useLayoutEffect(() => {
    const el = preRef.current;
    if (!el || !expanded) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      return;
    }
    // First paint of the first page: land at the bottom (the interesting end).
    if (!bottomedRef.current && text) {
      bottomedRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [expanded, pageCount, text]);

  const canLoadEarlier = logs.hasNextPage && !logs.isFetchingNextPage;
  const fetchNextPage = logs.fetchNextPage; // stable across renders (React Query)
  const loadEarlier = useCallback((): void => {
    const el = preRef.current;
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    void fetchNextPage();
  }, [fetchNextPage]);

  const onScroll = useCallback((): void => {
    const el = preRef.current;
    if (!el || !canLoadEarlier) return;
    if (el.scrollTop <= 80) loadEarlier();
  }, [canLoadEarlier, loadEarlier]);

  const toggle = (): void => {
    setExpanded((v) => {
      if (v) bottomedRef.current = false; // re-anchor to the bottom on the next open
      return !v;
    });
  };

  const dot = (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: m.color }}
      title={m.label}
    >
      {/* The state's own mark, on a filled disc — so it inherits the disc's white
          `currentColor` rather than painting its own. */}
      <m.icon size={10} />
    </span>
  );
  // Hover text: the full name (the label truncates), plus — in the fallback case ONLY — where
  // the click actually lands, so a link to the PR's Checks tab never reads as a broken link to
  // this job.
  const linkTitle = link.own
    ? check.name
    : `${check.name} — this check reports no link of its own; opens the PR's Checks tab on GitHub`;
  const gitHubLink = (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-blue-500 hover:underline"
      title={linkTitle}
    >
      Open on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
    </a>
  );

  if (!loggable) {
    // No downloadable log here, so nothing competes for the click and the WHOLE row stays the
    // link (the biggest hit area). The name is a <span> INSIDE that anchor, not its own <a> —
    // nested anchors are invalid HTML. Previously a check with no url rendered a plain <div>
    // and could not be opened at all; checkHref's fallback removes that dead end.
    return (
      <li className="text-xs">
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          title={linkTitle}
          className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {dot}
          <span className="min-w-0 truncate">{check.name}</span>
          <span className="ml-auto shrink-0 text-xs text-gray-400">{m.label}</span>
        </a>
      </li>
    );
  }

  return (
    <li className="text-xs">
      {/* An Actions check carries BOTH affordances, so the row is SPLIT rather than nested: the
          name is an <a> to the workflow run, the log toggle is a SIBLING <button>. This row used
          to be one big <button>, and an <a> inside a <button> is both invalid HTML and one click
          meaning two things — the same trap the whole-row handlers elsewhere in this codebase
          dodge with closest('a,button'). Because they are siblings, opening the run cannot also
          expand the logs, and no ancestor of this list carries a click handler (PrDetail's tab
          body is a plain scroller); the stopPropagation on the anchor is there so that stays true
          if one is ever added. flex-1 + justify-end gives the button every pixel right of the
          name, so the row still toggles almost everywhere it used to. */}
      <div className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800">
        {dot}
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          title={linkTitle}
          className="min-w-0 truncate hover:underline"
        >
          {check.name}
        </a>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          title={expanded ? 'Hide the job log' : 'Show the job log'}
          className="flex flex-1 items-center justify-end gap-1.5 text-gray-400"
        >
          <span className="text-xs">{m.label}</span>
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-blue-500">
            <ChevronIcon dir={expanded ? 'down' : 'right'} size={10} />
            {expanded ? 'hide logs' : 'logs'}
          </span>
        </button>
      </div>
      {expanded && (
        <div className="mb-1 mt-1">
          {logs.isLoading ? (
            <div className="px-1 py-2 text-gray-400">Loading logs…</div>
          ) : view?.available ? (
            <>
              <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[10px] text-gray-400">
                <span>
                  {view.partial && view.loadedBytes != null
                    ? `${view.lines} lines · ${formatLogBytes(view.loadedBytes)}${
                        view.totalBytes != null
                          ? ` of ${formatLogBytes(view.totalBytes)}`
                          : ''
                      }`
                    : `${view.lines} line${view.lines === 1 ? '' : 's'}`}
                </span>
                <span className="flex items-center gap-2">
                  {/* Kept OUTSIDE the <pre>: a control that appears/disappears inside
                      the scroller would change its scrollHeight and throw off the
                      prepend anchoring below. */}
                  {(logs.hasNextPage || logs.isFetchingNextPage) && (
                    <button
                      type="button"
                      className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
                      disabled={!canLoadEarlier}
                      onClick={loadEarlier}
                      title="Load the previous chunk of this log (or just scroll up)"
                    >
                      {logs.isFetchingNextPage ? (
                        'Loading earlier…'
                      ) : (
                        <>
                          <ArrowIcon dir="up" size={10} className="inline-block align-[-0.1em]" />{' '}
                          Load earlier
                        </>
                      )}
                    </button>
                  )}
                  {gitHubLink}
                </span>
              </div>
              <pre
                ref={preRef}
                onScroll={onScroll}
                className="max-h-[40rem] overflow-auto whitespace-pre rounded bg-gray-900 p-2 font-mono text-[11px] leading-[1.45] text-gray-100"
              >
                {view.text || '(empty log)'}
              </pre>
            </>
          ) : (
            <div className="px-1 py-2 text-gray-400">
              {view?.reason ?? "Couldn't load logs."} {gitHubLink}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// The list of checks (used on the Overview tab and the AI Analysis and Fix tab).
// `prGithubUrl` is `pr.githubUrl` — it is the FALLBACK link target for a check that reports
// no url of its own (see checkHref), so it is required rather than optional: an absent one
// would silently reinstate the unopenable row.
export function ChecksList({
  prId,
  prGithubUrl,
  checks,
}: {
  prId: number;
  prGithubUrl: string;
  checks: CheckRun[];
}): JSX.Element {
  return (
    <ul className="space-y-1">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} prId={prId} prGithubUrl={prGithubUrl} check={c} />
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
