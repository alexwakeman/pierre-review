import { useQuery } from '@tanstack/react-query';
import type { Repo, RepoOverviewResponse, SyncStatus, WorkspaceRepoMode } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useMe } from '../../hooks/useTriage.js';
import { useSetRepoBotScoring } from '../../hooks/useToolSwitches.js';
import { SetUpInFeatures } from '../AiSetup.js';
import { CheckIcon, CloseIcon } from '../Icons.js';
import { Switch } from '../ui/index.js';

// ONE REPO's PANEL in Repos & workspaces (WorkspaceManager): opened by clicking a repo, and on its own
// right after a repo is added. Three things, all read from Ensemble's database (opening it calls no GitHub):
//   - its first full sync (the last 90 days) while it runs: a bar, then "Synced";
//   - what was synced: pull requests by state, and how many people opened them;
//   - BOT SCORING, OPT-IN per repo (`PUT /api/repos/:id/bot-scoring`): off until switched on. Switched on,
//     the scoring of this repo's bot comments shows as a bar. Without the model, one line says so and links
//     to Settings → Features, where it is downloaded.

const POLL_MS = 2_000;

function Bar({ percent, tone, label }: { percent: number; tone: 'sync' | 'score' | 'done'; label: string }): JSX.Element {
  const fill = tone === 'done' ? 'bg-ui-success' : tone === 'score' ? 'bg-ai-signal-fill' : 'bg-ui-accent-fill';
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-ui bg-ui-hover"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className={`h-2 rounded-ui transition-all duration-500 ${fill}`} style={{ width: `${Math.max(2, percent)}%` }} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-ui border border-ui-line px-2 py-1.5">
      <div className="text-meta text-ui-mute">{label}</div>
      <div className="text-body font-semibold tabular-nums text-ui-ink">{value.toLocaleString()}</div>
    </div>
  );
}

/** The first full sync, from the repo's own sync status. */
function SyncSection({ repo, status }: { repo: Repo; status: SyncStatus | undefined }): JSX.Element {
  const running = status?.status === 'running';
  const full = status?.progress?.mode === 'full' || status?.lastFullSyncAt == null;
  if (status?.status === 'error') {
    return <p className="text-meta text-ui-danger">The sync failed: {status.lastSyncError ?? 'unknown error'}.</p>;
  }
  if (running && full) {
    const percent = Math.round((status?.progress?.percent ?? 0) * 100);
    const prs = status?.progress?.prsProcessed ?? 0;
    const paused = status?.progress?.paused;
    const phase = status?.progress?.foregroundComplete ? 'Loading the last 90 days' : 'Loading the last 14 days';
    return (
      <div data-testid="repo-panel-sync">
        <div className="mb-1 flex items-baseline justify-between gap-2 text-meta">
          <span className="font-medium text-ui-ink">{phase}</span>
          <span className="shrink-0 text-ui-mute">
            {paused?.reason === 'rate_limit'
              ? 'Paused for the GitHub rate limit'
              : paused?.reason === 'queued'
                ? 'Waiting for another sync'
                : `${percent}%${prs > 0 ? ` · ${prs.toLocaleString()} PRs` : ''}`}
          </span>
        </div>
        <Bar percent={percent} tone="sync" label={`${phase} of ${repo.fullName}`} />
      </div>
    );
  }
  if (status != null && status.lastFullSyncAt == null && !running) {
    return <p className="text-meta text-ui-mute" data-testid="repo-panel-sync">Waiting to sync.</p>;
  }
  return (
    <p className="inline-flex items-center gap-1 text-meta text-ui-success" data-testid="repo-panel-sync">
      <CheckIcon size={12} />
      Synced (the last 90 days)
    </p>
  );
}

function BotScoringSection({
  repo,
  mode,
  overview,
  onOpenSettings,
}: {
  repo: Repo;
  mode: WorkspaceRepoMode | null;
  overview: RepoOverviewResponse | undefined;
  onOpenSettings: () => void;
}): JSX.Element {
  const tool = useMe().data?.tools?.botAnalysis;
  const save = useSetRepoBotScoring();
  const enabled = overview?.botScoring.enabled ?? repo.botScoring === true;

  if (tool != null && !tool.installed) {
    return (
      <div className="space-y-2" data-testid="repo-panel-bot-setup">
        <p className="text-meta text-ui-mute">
          Bot comment analysis is not set up on this machine. Download the model to score this repo’s bot comments.
        </p>
        <SetUpInFeatures beforeOpen={onOpenSettings} />
      </div>
    );
  }
  if (tool != null && !tool.on) {
    return (
      <div className="space-y-2" data-testid="repo-panel-bot-setup">
        <p className="text-meta text-ui-mute">Bot comment analysis is switched off.</p>
        <SetUpInFeatures label="Switch it on in Settings → Features" beforeOpen={onOpenSettings} />
      </div>
    );
  }

  const pending = overview?.botScoring.pending ?? 0;
  const labelled = overview?.botScoring.labelled ?? 0;
  const total = pending + labelled;
  return (
    <div className="space-y-2">
      <Switch
        label="Score bot comments"
        hint="Labels how serious each bot review comment in this repo is, on this machine."
        aria-label={`Score bot comments in ${repo.fullName}`}
        data-testid="repo-panel-bot-scoring"
        checked={enabled}
        disabled={save.isPending}
        onChange={(e) => save.mutate({ repoId: repo.id, enabled: e.target.checked })}
      />
      {save.isError && <p className="text-meta text-ui-danger">{save.error.message || 'Couldn’t save.'}</p>}
      {enabled && mode === 'external' && (
        <p className="text-meta text-ui-mute">External repos are not scored. Make it Maintained to score it.</p>
      )}
      {enabled && mode !== 'external' && overview != null && (
        <div data-testid="repo-panel-scoring">
          {pending > 0 ? (
            <>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-meta">
                <span className="font-medium text-ui-ink">Scoring bot comments</span>
                <span className="shrink-0 text-ui-mute">
                  {labelled.toLocaleString()} of {total.toLocaleString()}
                </span>
              </div>
              <Bar
                percent={Math.round((labelled / Math.max(1, total)) * 100)}
                tone="score"
                label={`Scoring bot comments in ${repo.fullName}`}
              />
            </>
          ) : (
            <p className="inline-flex items-center gap-1 text-meta text-ui-success">
              <CheckIcon size={12} />
              {labelled > 0 ? `${labelled.toLocaleString()} bot comments scored` : 'No bot comments to score yet'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function RepoPanel({
  repo,
  mode,
  onClose,
  onOpenSettings,
}: {
  repo: Repo;
  /** The repo's membership in the workspace being viewed (null in the grid). */
  mode: WorkspaceRepoMode | null;
  onClose: () => void;
  /** Closes Repos & workspaces before Settings opens (Settings would open behind it). */
  onOpenSettings: () => void;
}): JSX.Element {
  const status = useQuery<SyncStatus>({
    queryKey: ['repo-sync-status', repo.id],
    queryFn: () => api.syncStatus(repo.id),
    refetchInterval: (q) => {
      return q.state.data?.status === 'running' ? POLL_MS : 15_000;
    },
  }).data;
  const syncing = status?.status === 'running';
  const overview = useQuery<RepoOverviewResponse>({
    queryKey: ['repo-overview', repo.id],
    queryFn: () => api.repoOverview(repo.id),
    // Poll while something is moving: the sync (PR counts grow) or this repo's scoring backlog.
    refetchInterval: (q) => (syncing || (q.state.data?.botScoring.pending ?? 0) > 0 ? POLL_MS : false),
  }).data;

  return (
    <section aria-label={`${repo.fullName} details`} className="space-y-4" data-testid="repo-panel">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-body font-semibold text-ui-ink" title={repo.fullName}>
          <span className="font-normal text-ui-faint">{repo.owner}/</span>
          {repo.name}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${repo.fullName} details`}
          className="hit shrink-0 rounded-ui p-1 text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <SyncSection repo={repo} status={status} />

      <div>
        <h4 className="mb-1.5 text-meta font-medium text-ui-mute">Pull requests synced</h4>
        <div className="grid grid-cols-2 gap-2" data-testid="repo-panel-stats">
          <Stat label="Total" value={overview?.prs.total ?? 0} />
          <Stat label="Open" value={overview?.prs.open ?? 0} />
          <Stat label="Merged" value={overview?.prs.merged ?? 0} />
          <Stat label="Closed" value={overview?.prs.closed ?? 0} />
        </div>
        <p className="mt-1.5 text-meta text-ui-mute">
          {(overview?.authors ?? 0).toLocaleString()} {overview?.authors === 1 ? 'person' : 'people'} opened them.
        </p>
      </div>

      <div>
        <h4 className="mb-1.5 text-meta font-medium text-ui-mute">Bot scoring</h4>
        <BotScoringSection repo={repo} mode={mode} overview={overview} onOpenSettings={onOpenSettings} />
      </div>
    </section>
  );
}
