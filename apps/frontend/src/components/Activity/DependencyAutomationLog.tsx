import { useId, useState } from 'react';
import { useDependencyAutomationLog } from '../../hooks/useDependencyMergeAll.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { relativeTime } from '../../lib/ui.js';
import { ChevronIcon } from '../Icons.js';
import { automationDetail, automationVerb } from '../../lib/dependencyAutomationLog.js';

// ── PENDING → DEPENDENCIES: "WHAT AUTOMATION DID" ───────────────────────────────────────────────
//
// The dependency automation's own record (Settings → Dependencies; merge/dependency-automation.ts):
// every approval, rebase request, AI conflict run, AI CI fix and merge it armed in this workspace in
// the last two weeks, newest first, failures with GitHub's words. "Merged" appears only once the
// merge LANDED (the watcher's outcome), never on arming. A teammate's Limn holding the PR
// (`limn/deps`) is a skip, not a failure: "Robin Dunn is handling this". A disclosure: ⚠ it fetches
// only once OPENED — nothing on the Pending board may fetch on mount.

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
                  <span
                    className={
                      i.state === 'failed'
                        ? 'shrink-0 text-ui-danger'
                        : i.state === 'skipped'
                          ? 'shrink-0 text-ui-mute'
                          : 'shrink-0 text-ui-ink'
                    }
                  >
                    {automationVerb(i)}
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
                  {automationDetail(i) && (
                    <span className="min-w-0 truncate text-meta text-ui-mute">{automationDetail(i)}</span>
                  )}
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
