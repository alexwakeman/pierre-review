import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, Repo, ToolId, ToolSwitchesResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// SETTINGS → FEATURES, THE TOOL SWITCHES (shared tool-switches.ts), client side. Account grain, so it rides
// `['me']`. The response carries both switches resolved: seat them at once, then refetch `['me']`, because
// the AI switch also changes what `me.ai` reports (switched off reads as not set up).
export function useSetToolSwitch() {
  const qc = useQueryClient();
  return useMutation<ToolSwitchesResponse, Error, { id: ToolId; on: boolean | null }>({
    mutationKey: ['tool-switches'],
    mutationFn: ({ id, on }) => api.setToolSwitch(id, on),
    onSuccess: (res) => {
      qc.setQueryData<MeResponse>(['me'], (prev) => (prev != null ? { ...prev, tools: res.tools } : prev));
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// Score a repo's bot comments (opt-in), or stop (Repos & workspaces → the repo's panel). The repo list
// carries the switch; the panel's overview and the scoring status refetch so the bar starts at once.
export function useSetRepoBotScoring() {
  const qc = useQueryClient();
  return useMutation<Repo, Error, { repoId: number; enabled: boolean }>({
    mutationKey: ['repo-bot-scoring'],
    mutationFn: ({ repoId, enabled }) => api.setRepoBotScoring(repoId, enabled),
    onSuccess: (repo) => {
      qc.setQueryData<Repo[]>(['repos'], (prev) => prev?.map((r) => (r.id === repo.id ? { ...r, ...repo } : r)));
      void qc.invalidateQueries({ queryKey: ['repos'] });
      void qc.invalidateQueries({ queryKey: ['repo-overview', repo.id] });
      void qc.invalidateQueries({ queryKey: ['ml-status'] });
    },
  });
}
