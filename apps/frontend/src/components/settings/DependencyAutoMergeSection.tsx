import {
  useDependencyAutoMergeSetting,
  useSetDependencyAutoMerge,
} from '../../hooks/useDependencyMergeAll.js';
import { SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// "Merge dependency updates automatically" for THIS workspace (CORE, free, both modes; migration
// 0093 / pg 0080). OFF by default. One switch, saved on change — the server's sweep
// (merge/dependency-policy.ts) does the rest. Read from the workspace row, so it sits above the
// pro-settings gate with the other free sections.
export function DependencyAutoMergeSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const setting = useDependencyAutoMergeSetting(workspaceId);
  const save = useSetDependencyAutoMerge(workspaceId);

  // `?.` on the field too: an unexpected body must render the pending shell, never throw (the SPA
  // has no error boundary).
  const stored = setting.data?.dependencyAutoMerge?.enabled;
  if (workspaceId == null || stored == null) {
    return <ScopePendingSection title="Dependency updates" failed={setting.isError} />;
  }
  const on = save.isPending ? save.variables === true : stored;

  return (
    <SectionShell title="Dependency updates">
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
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
      {save.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">Couldn’t save this setting.</p>
      )}
    </SectionShell>
  );
}
