import { useState } from 'react';
import type { AiFixCheckResult, AiFixChecks, CheckRunReport } from '@pierre-review/shared';
import { CheckCircleIcon, ChevronIcon, PendingBuildFailedIcon, SkipIcon, TimerIcon, WarningIcon } from '../Icons.js';
import { StatusIcon, type StatusTone } from '../ui/StatusIcon.js';

// "RUN TESTS" RESULTS, READ-ONLY (history). The option is gone: AI Fix and Implement now run in the
// workspace session (docs/SANDBOX.md), where the agent runs the repository's own checks itself. Older
// fix rows, and older story-build repositories, keep their `checks` record, shown here.

// ---- the results -----------------------------------------------------------------------------------

const STATUS_WORDS: Record<AiFixCheckResult['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  timed_out: 'Timed out',
  skipped: 'Skipped',
  error: 'Did not run',
};

function statusLook(status: AiFixCheckResult['status']): { tone: StatusTone; icon: JSX.Element } {
  switch (status) {
    case 'passed':
      return { tone: 'ready', icon: <CheckCircleIcon /> };
    case 'failed':
      return { tone: 'blocked', icon: <PendingBuildFailedIcon /> };
    case 'timed_out':
      return { tone: 'blocked', icon: <TimerIcon /> };
    case 'skipped':
      return { tone: 'quiet', icon: <SkipIcon /> };
    default:
      return { tone: 'blocked', icon: <WarningIcon /> };
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

function CheckRow({ r, label }: { r: AiFixCheckResult; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const look = statusLook(r.status);
  const hasOutput = r.output.trim() !== '';
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta">
        <StatusIcon tone={look.tone} icon={look.icon} label={STATUS_WORDS[r.status]} tintIconOnly className="w-24 shrink-0" />
        <span className="font-mono text-ui-ink">{label ?? r.name}</span>
        {r.status !== 'skipped' && <span className="text-ui-mute">{formatDuration(r.durationMs)}</span>}
        {hasOutput && (
          <button
            type="button"
            className="hit inline-flex items-center gap-1 text-ui-mute hover:text-ui-ink"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} />
            Output
          </button>
        )}
      </div>
      {r.note && <p className="ml-[6.5rem] text-meta text-ui-mute">{r.note}</p>}
      {open && hasOutput && (
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-ui bg-ui-surface p-2 font-mono text-meta leading-relaxed text-ui-ink">
          {r.output}
          {r.truncated && '\n(The middle of the output was cut.)'}
        </pre>
      )}
    </li>
  );
}

/** The one-line status beside Push: "Tests: 3 passed, 1 failed". Null when tests were not asked for. */
export function checksStatusLine(checks: AiFixChecks | null | undefined): { text: string; tone: StatusTone } | null {
  if (!checks) return null;
  if (!checks.ran) return { text: 'Tests did not run.', tone: 'neutral' };
  const all = [...checks.results, ...(checks.hook ? [checks.hook] : [])].filter((r) => r.status !== 'skipped');
  const passed = all.filter((r) => r.status === 'passed').length;
  const bad = all.length - passed;
  if (bad === 0) return { text: `Tests: ${passed} passed`, tone: 'ready' };
  return { text: `Tests: ${passed} passed, ${bad} failed`, tone: 'blocked' };
}

/** The one-line status beside Push. Takes a run's `CheckRunReport` (an AI Fix, a story build repository). */
export function ChecksStatus({ checks }: { checks: CheckRunReport | null | undefined }): JSX.Element | null {
  const line = checksStatusLine(checks);
  if (!line) return null;
  const look = line.tone === 'ready' ? <CheckCircleIcon /> : line.tone === 'blocked' ? <PendingBuildFailedIcon /> : <SkipIcon />;
  return <StatusIcon tone={line.tone} icon={look} label={line.text} className="text-meta" />;
}

/** The finished run's results. Takes a run's `CheckRunReport` (an AI Fix, a story build repository). */
export function ChecksReport({ checks }: { checks: CheckRunReport | null | undefined }): JSX.Element | null {
  const [installOpen, setInstallOpen] = useState(false);
  if (!checks) return null;
  const installFailed = checks.install.some((r) => r.status !== 'passed' && r.status !== 'skipped');
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-1 text-meta font-medium text-ui-mute">Tests</div>
      {checks.note && <p className={`mb-1 text-meta ${checks.ran ? 'text-ui-mute' : 'text-ui-warn'}`}>{checks.note}</p>}
      {checks.install.length > 0 && (
        <button
          type="button"
          className="hit mb-1 inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
          aria-expanded={installOpen}
          onClick={() => setInstallOpen((v) => !v)}
        >
          <ChevronIcon dir={installOpen ? 'down' : 'right'} />
          {installFailed ? 'Installing dependencies failed' : 'Dependencies installed'}
        </button>
      )}
      {installOpen && (
        <ul className="mb-1 divide-y divide-ui-line">
          {checks.install.map((r, i) => (
            <CheckRow key={i} r={r} label={r.command} />
          ))}
        </ul>
      )}
      {checks.results.length > 0 || checks.hook ? (
        <ul className="divide-y divide-ui-line">
          {checks.results.map((r) => (
            <CheckRow key={r.name} r={r} />
          ))}
          {checks.hook && <CheckRow r={checks.hook} />}
        </ul>
      ) : null}
      {(checks.agentRuns > 0 || checks.hookAttempts > 1) && (
        <p className="mt-1 text-meta text-ui-mute">
          {checks.agentRuns > 0 && `The AI ran checks ${checks.agentRuns} time${checks.agentRuns === 1 ? '' : 's'} while it worked.`}
          {checks.agentRuns > 0 && checks.hookAttempts > 1 && ' '}
          {checks.hookAttempts > 1 && `The pre-commit hook ran ${checks.hookAttempts} times.`}
        </p>
      )}
    </div>
  );
}
