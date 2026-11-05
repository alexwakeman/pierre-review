import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  MlSeverity,
  PrDetail as PrDetailT,
  PrFilesResponse,
  ReviewBotKind,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { indexThreadsByPath } from '../../lib/diff.js';
import type { ThreadStateBucket } from '../../lib/claudeThreadMarker.js';
import { BotTriageCard } from '../BotTriageCard.js';
import { CheckThreadsButton } from '../CheckThreadsButton.js';
import { ThreadList } from '../ThreadList/index.js';

/**
 * THE PR DETAIL'S THREADS TAB — the review threads without the code (it was the Changes tab's
 * "Threads only" view). The full bot triage card, Check threads, the state / severity / vendor
 * pills, reply and resolve on every card, Claude's judgements, and "Show in context", which takes
 * the reader to the thread in Changes (`openInChangesFor` → PrDetail `openInChanges`).
 *
 * Threads are grouped by file through the SAME rename-aware fold the diff uses
 * (`indexThreadsByPath`): a thread written before a rename lists under the file's current path.
 * The file list comes from the PR payload plus the cached diff when Changes has loaded it — read,
 * never fetched here (the diff is a GitHub-hydrating read).
 *
 * The filters arrive already GUARDED by PrDetail (`selectedPrId === prId`): they are global store
 * fields and only PrDetail knows whether they belong to this PR.
 */
export function PrThreadsTab({
  pr,
  usersById,
  aiEnabled,
  selectedThreadId,
  botFilter,
  stateFilter,
  severityFilter,
  openInChangesFor,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  aiEnabled: boolean;
  selectedThreadId: number | null;
  botFilter: ReviewBotKind | null;
  stateFilter: Set<ThreadStateBucket>;
  severityFilter: Set<MlSeverity>;
  openInChangesFor: (
    thread: ThreadDetail,
  ) => { run: () => void; approximate: boolean; line: number | null } | null;
}): JSX.Element {
  // A cache SUBSCRIPTION, never a fetch: the diff's file list carries `previousPath` for renames.
  const { data: cachedFiles } = useQuery<PrFilesResponse>({
    queryKey: ['pr-files', pr.id],
    queryFn: () => api.prFiles(pr.id),
    enabled: false,
    staleTime: Infinity,
  });
  const pathFor = useMemo(() => {
    const files: { path: string; previousPath?: string | null }[] = [
      ...pr.files.map((f) => ({ path: f.path })),
      ...(cachedFiles?.files ?? []),
    ];
    const out = new Map<number, string>();
    for (const [path, ts] of indexThreadsByPath(pr.threads, files)) {
      for (const t of ts) out.set(t.id, path);
    }
    return out;
  }, [pr.files, pr.threads, cachedFiles?.files]);

  return (
    <div className="pt-1" data-testid="pr-threads-tab">
      {/* The full triage card: its state counts are the DERIVED states (`rollupCounts`); the list's
          state chips count what the cards show (`threadStateBucket`). */}
      <BotTriageCard pr={pr} usersById={usersById} variant="full" />
      {/* Check threads: the AI re-judges only the threads that changed (me.ai). */}
      {aiEnabled && pr.threads.length > 0 && (
        <div className="px-3 pt-2">
          <CheckThreadsButton prId={pr.id} />
        </div>
      )}
      <ThreadList
        threads={pr.threads}
        usersById={usersById}
        prUrl={pr.githubUrl}
        prId={pr.id}
        repoId={pr.repoId}
        selectedThreadId={selectedThreadId}
        viewedSince={pr.lastViewedAt}
        botFilter={botFilter}
        stateFilter={stateFilter}
        severityFilter={severityFilter}
        openInChangesFor={openInChangesFor}
        pathFor={pathFor}
      />
    </div>
  );
}
