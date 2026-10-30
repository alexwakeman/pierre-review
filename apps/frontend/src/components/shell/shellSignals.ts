import { useAiBudget } from '../../hooks/useAiBudget.js';
import { activeWorkspaceBadge, useMyTurnByWorkspace } from '../../hooks/useMyTurnByWorkspace.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { headerUsageOf } from '../../lib/aiBudget.js';

// THE SHELL'S GLANCEABLE STATE BELOW `lg` (docs/redesign/DESIGN.md § 6).
//
// On main, five pieces of shell state were visible at every width: the Sync icon's red error dot,
// the workspace name, its My Turn badge, the "N need you elsewhere" strip and the AI usage figure.
// Below `lg` they live in the drawer, so the menu button, the phone's "More" and its Pending item
// carry a mark that says "look inside". The words stay where they were (the drawer's foot and
// "Needs you"); these are only the pointers to them.
//
// ⚠ NO NEW FETCH: every read here is a key the shell already holds — `['repos']` (SyncStatus polls
// it), the AI budget query (AiUsageMenu) and the daily brief (the Pending count).

export type ShellAlert = 'danger' | 'warn' | null;

export interface ShellSignals {
  /** The worst of: a repo whose last sync failed, the AI budget over (danger) or near (warn). */
  alert: ShellAlert;
  /** One sentence for the mark's accessible name / tooltip; null with no alert. */
  alertWords: string | null;
  /** Other workspaces have My Turn items. */
  elsewhere: number;
  /** This workspace's personal My Turn count (the Pending badge), null when none. */
  pending: { count: number; capped: boolean } | null;
  /** The active workspace's name, once known. */
  workspaceName: string | null;
}

export function useShellSignals(): ShellSignals {
  const { data: repos } = useRepos();
  const ai = useAiBudget();
  const { active, elsewhereCount } = useMyTurnByWorkspace();

  const errored = (repos ?? []).filter((r) => r.lastSyncStatus === 'error').length;
  const usage = ai.data != null ? headerUsageOf(ai.data) : null;
  const words: string[] = [];
  let alert: ShellAlert = null;
  if (errored > 0) {
    alert = 'danger';
    words.push(errored === 1 ? '1 repository failed to sync' : `${errored} repositories failed to sync`);
  }
  if (usage?.tone === 'over') {
    alert = 'danger';
    words.push('AI usage is over its limit');
  } else if (usage?.tone === 'near') {
    if (alert == null) alert = 'warn';
    words.push('AI usage is near its limit');
  }
  const badge = activeWorkspaceBadge(active);
  return {
    alert,
    alertWords: words.length > 0 ? words.join('; ') : null,
    elsewhere: elsewhereCount,
    pending: badge != null ? { count: badge.count, capped: badge.cappedTotal != null } : null,
    workspaceName: active?.name ?? null,
  };
}
