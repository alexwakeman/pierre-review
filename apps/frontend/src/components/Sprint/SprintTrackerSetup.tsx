import { useSettingsModal } from '../../store/settingsModal.js';
import { InfoButton } from '../InfoModal.js';
import { GearIcon } from '../Icons.js';

// This Sprint with NO issue tracker on the workspace: one line, the way to set one up behind a
// button that opens Settings AT the Issue tracker section (`openSettings('issue-tracker')`), and the
// explanation behind the ⓘ. Keeps `data-testid="sprint-view"` — it IS the sprint view's state.
/** The one line a workspace with no issue tracker sees on the sprint boards, and the way to fix it. */
export function SprintTrackerSetup(): JSX.Element {
  const openSettings = useSettingsModal((s) => s.openSettings);
  return (
    <div
      data-testid="sprint-view"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"
    >
      <div className="flex items-center gap-1">
        <span>Connect Jira, Linear or GitHub Issues to see this sprint.</span>
        <InfoButton title="Setting up an issue tracker">
          <p>Each workspace has its own issue tracker, or none.</p>
          <p>Set it in Settings → Workspace → Issue tracker. Limn then reads the tracker’s current sprint and shows it here.</p>
          <p>Merged so far works without a tracker.</p>
        </InfoButton>
      </div>
      <button
        type="button"
        onClick={() => openSettings('issue-tracker')}
        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
      >
        <GearIcon size={13} />
        Set up in Settings
      </button>
    </div>
  );
}
