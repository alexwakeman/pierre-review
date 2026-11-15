import { useEffect, useId, useState } from 'react';
import { normaliseReleaseSuffix, RELEASE_SUFFIX_MAX, validateReleaseSettings } from '@pierre-review/shared';
import { useReleaseSettings, useSetReleaseSettings } from '../../hooks/useReleases.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { releaseSuffixChangeWarning } from './releasesSectionModel.js';

// SETTINGS → RELEASES (docs/RELEASES.md § Terms and settings): the workspace's release suffix and
// hotfix suffix. BOTH are required before This Sprint → Releases (or the hotfix option) does
// anything, and there is NO default — the fields start empty.
//
// ⚠ ONE VALIDATOR: the shared `validateReleaseSettings`, the same function the PUT route runs, so
// the sentence under the fields is the sentence a 400 would carry.
// ⚠ A SUFFIX CHANGE AFTER RELEASES EXIST IS DISCLOSED BEFORE THE SAVE: older tags stop counting as
// releases (the next check reads them as version tags or nothing).
// ⚠ Nothing renders, and nothing is written, against an unresolved workspace.
export function ReleasesSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useReleaseSettings(workspaceId);
  const save = useSetReleaseSettings(workspaceId);
  const data = query.data;
  const releaseId = useId();
  const hotfixId = useId();

  const [release, setRelease] = useState('');
  const [hotfix, setHotfix] = useState('');
  // Re-seeded on the STORED values (and the workspace), never on the response object: a background
  // refetch must not throw away a half-typed suffix.
  const signature = `${workspaceId ?? 'none'}:${data?.releaseSuffix ?? ''}:${data?.hotfixSuffix ?? ''}`;
  useEffect(() => {
    if (data == null) return;
    setRelease(data.releaseSuffix ?? '');
    setHotfix(data.hotfixSuffix ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Release tags" failed={query.isError} />;
  }

  const next = { releaseSuffix: normaliseReleaseSuffix(release), hotfixSuffix: normaliseReleaseSuffix(hotfix) };
  const dirty = next.releaseSuffix !== data.releaseSuffix || next.hotfixSuffix !== data.hotfixSuffix;
  const problem = dirty ? validateReleaseSettings(next) : null;
  const warning = dirty && problem == null ? releaseSuffixChangeWarning(data, next) : null;

  return (
    <SectionShell
      title="Release tags"
      desc="This Sprint → Releases needs both suffixes. Applies to this workspace only."
      info={
        <InfoButton title="Release tags">
          <p>
            A version tag on the default branch, such as v2.4.0, is released by adding a tag with the release
            suffix on the same commit: v2.4.0 plus the suffix.
          </p>
          <p>A hotfix tag ends in the hotfix suffix. Your team creates those by hand on a hotfix branch.</p>
          <p>
            The two suffixes must be different, and one cannot end with the other. Each is 1 to {RELEASE_SUFFIX_MAX}{' '}
            characters that git allows in a tag name.
          </p>
        </InfoButton>
      }
    >
      <Field label="Release suffix" htmlFor={releaseId}>
        <input
          id={releaseId}
          className={`${inputCls} sm:w-60`}
          value={release}
          maxLength={RELEASE_SUFFIX_MAX + 8}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setRelease(e.target.value)}
        />
      </Field>
      <Field label="Hotfix suffix" htmlFor={hotfixId}>
        <input
          id={hotfixId}
          className={`${inputCls} sm:w-60`}
          value={hotfix}
          maxLength={RELEASE_SUFFIX_MAX + 8}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setHotfix(e.target.value)}
        />
      </Field>
      {problem != null && <p className="text-meta text-ui-danger">{problem}</p>}
      {warning != null && <p className="rounded-ui bg-ui-raise px-2 py-1.5 text-meta text-ui-warn">{warning}</p>}
      <SaveButton dirty={dirty && problem == null} saving={save.isPending} onClick={() => save.mutate(next)} />
      {save.isError && <p className="text-meta text-ui-danger">{save.error.message}</p>}
    </SectionShell>
  );
}
