import { useEffect, useState } from 'react';
import {
  useUpdateWorkspaceProSettings,
  useWorkspaceProSettings,
} from '../../hooks/useWorkspaceProSettings.js';
import { dateTime } from '../../lib/ui.js';
import { SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

/**
 * AUTO CLAUDE REVIEW for the currently-selected workspace (plugin migration 0036). Mounted only
 * when the `claudeReview` capability is on — i.e. local, with the pro+ flag; the server drops the
 * switch anywhere else, so it could never be a promise the sweeper does not keep.
 *
 * The copy states the rule and stops: which PRs, how many a day, what it costs to run. Turning it
 * off and on again moves the start, and the "since" line says from when.
 */
export function AutoReviewSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const settings = useWorkspaceProSettings(workspaceId != null, workspaceId);
  const update = useUpdateWorkspaceProSettings(workspaceId);

  const stored = settings.data?.autoReview ?? null;
  const storedOn = stored?.enabled === true;
  const [on, setOn] = useState(storedOn);
  // Re-seed on the stored VALUE (not the response object — a background refetch hands back a new
  // identity and would undo a half-made edit).
  useEffect(() => {
    setOn(storedOn);
  }, [workspaceId, storedOn]);

  if (workspaceId == null || settings.data == null) {
    return <ScopePendingSection title="Auto Claude review" failed={settings.isError} />;
  }
  const cap = stored?.dailyCap ?? 20;

  return (
    <SectionShell
      title="Auto Claude review"
      desc="Claude reviews each new PR a person opens in this workspace, once, with the same model and budget as the Review button."
    >
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">
            Review new PRs automatically
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            Only PRs opened after you turn this on. Drafts wait until they are ready. Bots are
            skipped. At most {cap} a day (UTC); the rest wait for the next day. Reviews you start
            yourself always go first.
          </span>
        </span>
      </label>
      {storedOn && stored?.enabledAt != null && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          On since {dateTime(stored.enabledAt)}.
        </p>
      )}
      <SaveButton
        dirty={on !== storedOn}
        saving={update.isPending}
        onClick={() => update.mutate({ autoReview: { enabled: on } })}
      />
      {update.isError && (
        <div className="text-xs text-red-500">
          {(update.error as Error)?.message ?? 'Couldn’t save.'}
        </div>
      )}
    </SectionShell>
  );
}
