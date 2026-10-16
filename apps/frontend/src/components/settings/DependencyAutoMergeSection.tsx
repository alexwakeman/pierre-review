import { useEffect, useState } from 'react';
import {
  useDependencyAutoMergeSetting,
  useSetDependencyAutoMerge,
} from '../../hooks/useDependencyMergeAll.js';
import { SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// "Merge dependency updates automatically" for THIS workspace (CORE, free, both modes; migration
// 0093 / pg 0080). OFF by default. Read from the workspace row, so it sits above the pro-settings
// gate with the other free sections; the server's sweep (merge/dependency-policy.ts) does the rest.
//
// ⚠ DRAFT + SAVE, like every other section in this modal — toggling the box writes NOTHING. A
// switch that arms merges on the reader's behalf is the last one that should fire on a stray
// click, and it used to (saved on change, with no Save button anywhere in the section).
export function DependencyAutoMergeSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const setting = useDependencyAutoMergeSetting(workspaceId);
  const save = useSetDependencyAutoMerge(workspaceId);

  // `?.` on the field too: an unexpected body must render the pending shell, never throw (the SPA
  // has no error boundary).
  const stored = setting.data?.dependencyAutoMerge?.enabled;

  const [draft, setDraft] = useState(stored ?? false);
  // Re-seed on the resolved workspace and the STORED value (first load, a workspace switch, and
  // after a successful save) — keyed on the values, never the response object, whose identity
  // changes on every background refetch and would revert a half-made edit.
  useEffect(() => {
    setDraft(stored ?? false);
  }, [workspaceId, stored]);

  if (workspaceId == null || stored == null) {
    return <ScopePendingSection title="Dependency updates" failed={setting.isError} />;
  }
  const dirty = draft !== stored;

  return (
    <SectionShell title="Dependency updates">
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
        />
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">
            Merge dependency updates automatically
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            Dependency PRs in repos you can push to merge once their required checks pass.
            Drafts and conflicts are left alone, and a PR you cancel stays cancelled.
          </span>
        </span>
      </label>

      <SaveButton dirty={dirty} saving={save.isPending} onClick={() => save.mutate(draft)} />
      <p className="text-[11px] text-gray-400">Applies to this workspace only.</p>

      {save.isError && (
        <div className="text-[11px] text-red-500">
          {(save.error as Error)?.message ?? 'Couldn’t save this setting.'}
        </div>
      )}
    </SectionShell>
  );
}
