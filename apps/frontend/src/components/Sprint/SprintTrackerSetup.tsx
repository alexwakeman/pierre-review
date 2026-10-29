import { useSettingsModal } from '../../store/settingsModal.js';
import { InfoButton } from '../InfoModal.js';
import { GearIcon } from '../Icons.js';
import { FOCUS_RING } from '../ui/cx.js';

// This Sprint with NO issue tracker on the workspace: one line, the way to set one up behind a
// button that opens Settings AT the Issue tracker section (`openSettings('issue-tracker')`), and the
// explanation behind the ⓘ. Keeps `data-testid="sprint-view"` — it IS the sprint view's state.
/** The one line a workspace with no issue tracker sees on the sprint boards, and the way to fix it. */
export function SprintTrackerSetup(): JSX.Element {
  const openSettings = useSettingsModal((s) => s.openSettings);
  return (
    <div
      data-testid="sprint-view"
      className="flex flex-col items-center gap-3 rounded-ui bg-ui-surface px-6 py-10 text-center text-body text-ui-mute"
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
        className={`inline-flex h-8 items-center gap-1.5 rounded-ui bg-ui-raise px-3 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-11 ${FOCUS_RING}`}
      >
        <GearIcon size={13} />
        Set up in Settings
      </button>
    </div>
  );
}
