import type { MlEnrichmentStatus, Repo, SyncStatus } from '@pierre-review/shared';
import { SyncProgressPanel } from './SyncProgressPanel.js';

// A dismissible, determinate progress modal shown while a user-initiated sync is in flight
// and the WorkspaceManager is NOT open (the FirstRunOnboarding add path — when the manager
// IS open the same content renders as its embedded right-hand column instead). The sync
// continues server-side even if dismissed — closing just hides this overlay.
//
// Thin overlay chrome only: all content (per-repo rows, the ML scoring row, the footer
// actions) lives in SyncProgressPanel, shared with the manager's embedded column.
export function SyncProgressModal({
  repos,
  statuses,
  ml,
  cancelling,
  onCancel,
  onDismiss,
}: {
  repos: Repo[];
  statuses: SyncStatus[] | undefined;
  /** Live scoring state, or undefined/disabled where no severity-api is configured. */
  ml: MlEnrichmentStatus | undefined;
  cancelling: boolean;
  onCancel: () => void;
  /** Close the overlay and leave both halves running server-side. */
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="presentation"
    >
      <div
        className="w-[28rem] max-w-[90vw] rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
        aria-modal="true"
        aria-label="Sync progress"
      >
        {/* No dismiss affordance (no ✕, no outside-click): the sync can only be
            left by letting it finish — it auto-closes — or by the footer button. */}
        <SyncProgressPanel
          repos={repos}
          statuses={statuses}
          ml={ml}
          cancelling={cancelling}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </div>
    </div>
  );
}
