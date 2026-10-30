import { useId, useState } from 'react';
import type { DependencyAutomationLogItem } from '@pierre-review/shared';
import { useDependencyAutomationLog } from '../../hooks/useDependencyMergeAll.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { relativeTime } from '../../lib/ui.js';
import { ChevronIcon } from '../Icons.js';

// ── PENDING → DEPENDENCIES: "WHAT AUTOMATION DID" ───────────────────────────────────────────────
//
// The dependency automation's own record (Settings → Dependencies; merge/dependency-automation.ts):
// every approval, rebase request and AI conflict run it TOOK in this workspace in the last two
// weeks, newest first, failures with GitHub's words. A disclosure: ⚠ it fetches only once OPENED —
// nothing on the Pending board may fetch on mount. Merges it armed show on the cards themselves
// ("Armed automatically").

const VERB: Record<DependencyAutomationLogItem['action'], { done: string; failed: string; running: string }> = {
  approve: { done: 'Approved', failed: 'Couldn’t approve', running: 'Approving' },
  rebase_request: { done: 'Asked to rebase', failed: 'Couldn’t ask to rebase', running: 'Asking to rebase' },
  ai_resolve: { done: 'Resolved conflicts', failed: 'Couldn’t resolve conflicts', running: 'Resolving conflicts' },
};

export function DependencyAutomationLog({ workspaceId }: { workspaceId: number | null }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const log = useDependencyAutomationLog(workspaceId, open);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  if (workspaceId == null) return null;
  // `?? []` also covers a body with no `items` — the SPA has no error boundary.
  const items = log.data?.items ?? [];

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded-ui px-2 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
      >
        <ChevronIcon size={12} dir={open ? 'down' : 'right'} />
        What automation did
      </button>
      {open && (
        <div id={panelId} className="mt-1 rounded-ui bg-ui-surface px-3 py-2">
          {log.isLoading ? (
            <p className="text-meta text-ui-mute">Loading…</p>
          ) : log.isError ? (
            <p className="text-meta text-ui-danger">Couldn’t load what automation did.</p>
          ) : items.length === 0 ? (
            <p className="text-meta text-ui-mute">
              Nothing in the last two weeks. Turn it on in Settings → Dependencies.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((i) => (
                <li key={i.id} className="flex items-baseline gap-2 text-body">
                  <span className={i.state === 'failed' ? 'shrink-0 text-ui-danger' : 'shrink-0 text-ui-ink'}>
                    {VERB[i.action]?.[i.state] ?? i.action}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      openPrDetailTab(
                        {
                          id: i.prId,
                          number: i.prNumber,
                          title: i.prTitle,
                          repoFullName: i.repoFullName,
                          authorLogin: null,
                          authorDisplayName: null,
                          authorAvatarUrl: null,
                        },
                        { fromActivity: true },
                      )
                    }
                    className="min-w-0 truncate text-left text-ui-ink hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  >
                    {i.repoFullName} #{i.prNumber} {i.prTitle}
                  </button>
                  {i.detail && <span className="min-w-0 truncate text-meta text-ui-mute">{i.detail}</span>}
                  <span className="ml-auto shrink-0 text-meta text-ui-faint">{relativeTime(i.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
