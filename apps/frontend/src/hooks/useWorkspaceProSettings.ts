import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceProSettings, WorkspaceProSettingsUpdate } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { periodReportsListKey } from './usePeriodReports.js';

// The PER-WORKSPACE Pro config (Pro `pro_workspace_settings`; /api/pro/settings/workspace) —
// ONE row holding THREE settings: the sprint cadence + phase anchor, the comparison-window MODE,
// and the Jira/Linear tracker.
//
// ⚠ NONE OF THEM HAS AN ACCOUNT-LEVEL DEFAULT UNDERNEATH IT ANY MORE (plugin migrations 0031 and,
// for the mode, 0032). The response is what THIS workspace runs, full stop — two states, no
// chain, no `source` field to disclose. The old account fields on `ProSettings.sprint` are dormant
// and always null.
//
// ⚠ THE MODE AND THE CADENCE COMPOSE, WHICH IS WHY THEY SHARE A ROW. `'sprint'` on a workspace
// WITH a cadence is a sprint-position comparison; on one WITHOUT, it silently degrades to
// rolling-14. Read off different grains, one account setting produced two different window SHAPES
// across a reader's workspaces with nothing on screen saying which they got. `comparisonMode` is
// TOP-LEVEL in the patch, not inside `sprint`: that section declares `cadenceDays` REQUIRED so
// that clearing a cadence is always explicit, which would make a mode-only patch inexpressible.
//
// ⚠ THE KEY CARRIES `ws:<id>` AND THE FETCH IDLES ON AN UNRESOLVED SCOPE, like every scoped query
// here. `workspaceId === null` means "not resolved yet"; a request sent before it lands is answered
// from the account's DEFAULT workspace and then cached under whichever key the store settles on —
// which on THIS surface would show one team's cadence in another team's editor and save it there.
export function workspaceProSettingsKey(workspaceId: number | null): [string, string] {
  return ['workspace-pro-settings', workspaceKey(workspaceId)];
}

export function useWorkspaceProSettings(enabled: boolean, workspaceId: number | null) {
  return useQuery<WorkspaceProSettings>({
    queryKey: workspaceProSettingsKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.workspaceProSettings(workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateWorkspaceProSettings(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceProSettings, Error, WorkspaceProSettingsUpdate>({
    mutationFn: (patch) => {
      // Refuses rather than posting a request the server would resolve to the Default workspace.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.updateWorkspaceProSettings(workspaceId, patch);
    },
    onSuccess: (settings, patch) => {
      qc.setQueryData(workspaceProSettingsKey(workspaceId), settings);
      // ⚠ THE CADENCE REGRIDS EVERY WINDOW ON THIS WORKSPACE, so every surface framed by one has to
      // be re-read. The Reports list is the load-bearing one: its periods ARE the grid, and after a
      // change the stored reports at the old cadence move from the period picker into the archive.
      // The keys below are PREFIXES belonging to other files — a rename there is silent here: the
      // mutation succeeds, the invalidation targets a key nobody uses, and the UI reads "the
      // setting didn't take". They stay bare literals because they are PREFIXES, which is what
      // makes them sweep every workspace's `['<name>', 'ws:<id>']` slot.
      if (patch.sprint) {
        void qc.invalidateQueries({ queryKey: periodReportsListKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: ['period-report'] });
      }
      // ⚠ THE COMPARISON MODE SWEEPS THE SAME TWO INSIGHTS KEYS AS THE CADENCE, AND THAT CLAUSE
      // ARRIVED WITH THE SETTING. The mode moved here from the ACCOUNT patch in plugin migration
      // 0032, where `useUpdateProSettings` owned exactly this invalidation; the window is resolved
      // fresh on every /api/pro/insights read (`getComparisonWindow` → `resolveComparisonWindow`),
      // but those queries otherwise refetch only on the 5-min sync cadence — so without this line
      // Save would look inert for minutes and the reader would press it again.
      // It does NOT sweep the period keys: the mode re-frames a COMPARISON WINDOW, while the
      // period grid is the CADENCE's. Regridding on a mode change would move stored reports into
      // the archive for a setting that did not touch a boundary.
      if (patch.sprint || patch.comparisonMode != null) {
        void qc.invalidateQueries({ queryKey: ['workspace-insights'] });
        void qc.invalidateQueries({ queryKey: ['workspace-metrics-detail'] });
      }
      // Jira/Linear ticket links are computed on read into the PR-detail payload. PR/thread detail
      // is IndexedDB-persisted with staleTime:Infinity, so a provider / base-URL / key-list /
      // match-scope change would NOT appear on already-viewed PRs without an explicit
      // invalidation. (It moved here with the setting, from the retired account-patch hook.)
      if (patch.issue) {
        void qc.invalidateQueries({ queryKey: ['pr'] });
        void qc.invalidateQueries({ queryKey: ['thread'] });
      }
    },
  });
}
