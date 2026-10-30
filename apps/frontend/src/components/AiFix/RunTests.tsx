import { useEffect, useState } from 'react';
import type { AiFixCheckResult, AiFixChecks, AiFixChecksPreview, CheckRunReport } from '@pierre-review/shared';
import { useAiFixChecks } from '../../hooks/useAiFix.js';
import { CheckCircleIcon, ChevronIcon, PendingBuildFailedIcon, SkipIcon, TimerIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { StatusIcon, type StatusTone } from '../ui/StatusIcon.js';

// AI FIX "RUN TESTS" (docs/CLAUDE-REVIEW.md § AI Fix "Run tests"): the picker's option and the
// finished run's results. The checks are the project's OWN declared ones (server-side allow-list);
// they run in a sandbox, by name — the agent still has no shell.

// ---- the picker ----------------------------------------------------------------------------------

/** The reader's last choice per repository (local only): Run tests on/off and their ticks. */
export interface RunTestsMemory {
  on: boolean;
  ticks: Record<string, boolean>;
}
const MEMORY_KEY = (repo: string): string => `limn.aiFix.runTests.${repo}`;

function readMemory(repo: string): RunTestsMemory {
  try {
    const raw = localStorage.getItem(MEMORY_KEY(repo));
    if (!raw) return { on: false, ticks: {} };
    const v = JSON.parse(raw) as Partial<RunTestsMemory>;
    return { on: v.on === true, ticks: v.ticks && typeof v.ticks === 'object' ? v.ticks : {} };
  } catch {
    return { on: false, ticks: {} };
  }
}

function writeMemory(repo: string, m: RunTestsMemory): void {
  try {
    localStorage.setItem(MEMORY_KEY(repo), JSON.stringify(m));
  } catch {
    /* private mode: the choice is just not remembered */
  }
}

/** The names a start sends: ticked (or on by default), never refused. Empty when off or unavailable. */
export function pickedCheckNames(preview: AiFixChecksPreview | undefined, on: boolean, ticks: Record<string, boolean>): string[] {
  if (!on || !preview || preview.unavailable) return [];
  return preview.checks.filter((c) => c.refused == null && (ticks[c.name] ?? c.defaultOn)).map((c) => c.name);
}

/** What the picker reads: the checks list query (any source — a PR's head, a build repository's base). */
export interface RunTestsQuery {
  data: AiFixChecksPreview | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** The "Run tests" state a picker renders: on/off, the ticks, the list, and the names to send. */
export interface RunTestsState {
  on: boolean;
  setOn: (on: boolean) => void;
  ticks: Record<string, boolean>;
  setTick: (name: string, value: boolean) => void;
  query: RunTestsQuery;
  names: string[];
}

/** The reader's remembered choice for one repository (local only). */
export function useRunTestsMemory(repoFullName: string): { memory: RunTestsMemory; update: (m: RunTestsMemory) => void } {
  const [memory, setMemory] = useState<RunTestsMemory>(() => readMemory(repoFullName));
  useEffect(() => setMemory(readMemory(repoFullName)), [repoFullName]);
  const update = (m: RunTestsMemory): void => {
    setMemory(m);
    writeMemory(repoFullName, m);
  };
  return { memory, update };
}

/** The picker state from the remembered choice and ITS checks query (the query is enabled only while
 *  the box is ticked — the caller passes `memory.on` as its `enabled`). Shared by AI Fix and the story
 *  build's repository cards. */
export function runTestsState(m: { memory: RunTestsMemory; update: (m: RunTestsMemory) => void }, query: RunTestsQuery): RunTestsState {
  const { memory, update } = m;
  return {
    on: memory.on,
    setOn: (on: boolean) => update({ ...memory, on }),
    ticks: memory.ticks,
    setTick: (name: string, value: boolean) => update({ ...memory, ticks: { ...memory.ticks, [name]: value } }),
    query,
    names: pickedCheckNames(query.data, memory.on, memory.ticks),
  };
}

/**
 * The "Run tests" state for one PR's picker: whether it is on, the ticks, and the names to send.
 * The checks list is fetched only once the box is ticked (one GitHub read).
 */
export function useRunTests(prId: number, repoFullName: string): RunTestsState {
  const m = useRunTestsMemory(repoFullName);
  const query = useAiFixChecks(prId, m.memory.on);
  return runTestsState(m, query);
}

export function RunTestsOption({ state, disabled }: { state: RunTestsState; disabled: boolean }): JSX.Element {
  const { on, setOn, ticks, setTick, query } = state;
  const preview = query.data;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-meta text-ui-ink">
          <CheckboxBox checked={on} disabled={disabled} onChange={(e) => setOn(e.target.checked)} />
          Run tests
        </label>
        <InfoButton title="Run tests">
          <p>
            Limn runs the project’s own checks — the test, lint and type-check scripts it declares — in a
            sandbox: no network, no access to your home folder, no tokens.
          </p>
          <p>
            The AI can run them by name while it works. It still has no shell. When it finishes, Limn
            runs them once more and shows the results here.
          </p>
          <p>
            Dependencies are installed first, from the lockfile, without install scripts. Checks that
            need Docker run only when Docker is running.
          </p>
          <p>
            If the repository has a pre-commit hook, Limn commits with it. When the hook fails, the AI
            gets its output and tries again, twice at most.
          </p>
          <p>You can push whatever the results say.</p>
        </InfoButton>
      </div>
      {on && (
        <div className="ml-6 mt-1.5">
          {query.isLoading && <p className="text-meta text-ui-mute">Reading the project’s checks…</p>}
          {query.isError && <p className="text-meta text-ui-danger">Could not read the project’s checks.</p>}
          {preview && preview.unavailable && <p className="text-meta text-ui-warn">{preview.unavailable} The fix runs without them.</p>}
          {preview && !preview.unavailable && preview.unsandboxed && (
            <p className="mb-1 text-meta text-ui-warn">No sandbox here: tests run without one.</p>
          )}
          {preview && !preview.unavailable && preview.checks.length === 0 && (
            <p className="text-meta text-ui-mute">This project declares no tests, lint or type checks.</p>
          )}
          {preview && !preview.unavailable && preview.checks.length > 0 && (
            <ul className="space-y-1">
              {preview.checks.map((c) => (
                <li key={c.name}>
                  <label className={`flex items-start gap-2 text-meta ${c.refused ? 'cursor-default text-ui-mute' : 'cursor-pointer text-ui-ink'}`}>
                    <CheckboxBox
                      className="mt-0.5"
                      checked={c.refused == null && (ticks[c.name] ?? c.defaultOn)}
                      disabled={disabled || c.refused != null}
                      onChange={(e) => setTick(c.name, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="font-mono">{c.name}</span>
                      {c.needsDocker && <span className="text-ui-mute"> · needs Docker</span>}
                      <span className="block truncate text-ui-mute" title={c.command}>
                        {c.refused ?? c.command}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

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
