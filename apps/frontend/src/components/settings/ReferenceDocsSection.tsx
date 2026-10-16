import { useEffect, useState } from 'react';
import { useReferenceDocsSettings, useSetReferenceDocsSettings } from '../../hooks/useReferenceDocs.js';
import { InfoButton } from '../InfoModal.js';
import { SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// "Use reference docs in Claude Review" for THIS workspace (CORE, free, LOCAL ONLY — mounted only on
// `me.ai.enabled`, beside Auto review; `GET`/`PUT /api/workspaces/:id/docs-settings`,
// `workspaces.docs_in_review`, migration 0116 / pg 0103). OFF by default.
//
// ⚠ DRAFT + SAVE, like every other section in this modal — ticking the box writes nothing.
export function ReferenceDocsSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const setting = useReferenceDocsSettings(workspaceId);
  const save = useSetReferenceDocsSettings(workspaceId);

  // `?.` on the field too: an unexpected body must render the pending shell, never throw.
  const stored = setting.data?.docsInReview;
  const [draft, setDraft] = useState(stored ?? false);
  // Re-seed on the resolved workspace and the STORED value (first load, a workspace switch, after a
  // save) — keyed on the values, never the response object, whose identity changes on every refetch.
  useEffect(() => {
    setDraft(stored ?? false);
  }, [workspaceId, stored]);

  if (workspaceId == null || stored == null) {
    return <ScopePendingSection title="Reference docs" failed={setting.isError} />;
  }
  const dirty = draft !== stored;

  return (
    <SectionShell
      title="Reference docs"
      info={
        <InfoButton title="Reference docs in Claude Review">
          <p>
            When this is on, Claude Review reads this workspace&rsquo;s Docs (Activity → Docs) while it checks a pull request
            and its story.
          </p>
          <p>
            It starts at the library&rsquo;s contents and reads only the sections that matter to the change, then says where
            the work or the story disagrees with them, citing each section.
          </p>
          <p>It is off by default. It runs on your machine, on your own Claude Code or Anthropic API key.</p>
        </InfoButton>
      }
    >
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        <span className="font-medium text-gray-700 dark:text-gray-200">Use reference docs in Claude Review</span>
      </label>

      <SaveButton dirty={dirty} saving={save.isPending} onClick={() => save.mutate(draft)} />
      <p className="text-[11px] text-gray-500 dark:text-gray-400">Applies to this workspace only.</p>

      {save.isError && (
        <div className="text-[11px] text-red-500">{save.error?.message ?? 'Couldn’t save this setting.'}</div>
      )}
    </SectionShell>
  );
}
