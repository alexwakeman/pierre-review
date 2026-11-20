import { useEffect, useId, useRef, useState } from 'react';
import {
  RELEASE_SUFFIX_MAX,
  RELEASE_SUFFIX_PREFIX,
  suffixFromTyped,
  suffixTypedPart,
  validateReleaseSettings,
  type ReleaseSettingsResponse,
} from '@pierre-review/shared';
import { useReleaseSettings, useSetReleaseRepos, useSetReleaseSettings } from '../../hooks/useReleases.js';
import { InfoButton } from '../InfoModal.js';
import { CheckInput, Field, SectionShell, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { releaseReposDirty, releaseSuffixChangeWarning } from './releasesSectionModel.js';

// SETTINGS → RELEASES (docs/RELEASES.md § Terms and settings): the workspace's release suffix and
// hotfix suffix, and which repositories are RELEASED FROM THIS WORKSPACE. BOTH suffixes and at least one
// ticked repository are required before This Sprint → Releases (or the hotfix option) does anything;
// there is NO default — the fields start empty and no repository is ticked.
//
// ⚠ THE HYPHEN IS FIXED: the reader types `rc`, the stored suffix is `-rc`. The "-" sits BESIDE the box
// (an adornment), never in it; `suffixTypedPart` / `suffixFromTyped` convert.
// ⚠ ONE VALIDATOR: the shared `validateReleaseSettings`, the same function the PUT route runs, so
// the sentence under the fields is the sentence a 400 would carry.
// ⚠ A SUFFIX CHANGE AFTER RELEASES EXIST IS DISCLOSED BEFORE IT IS WRITTEN: older tags stop counting
// as releases (the next check reads them as version tags or nothing). Saves as you go
// (./autosave.tsx), except that while the warning shows, a suffix is written only when the reader
// leaves the field or presses Enter — never mid-word, so the warning is read first.
// The repository boxes write at once.
// ⚠ Nothing renders, and nothing is written, against an unresolved workspace.
export function ReleasesSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useReleaseSettings(workspaceId);
  const data = query.data;
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Release tags" failed={query.isError} />;
  }
  return (
    <>
      <SuffixSection workspaceId={workspaceId} data={data} />
      <ReleasableReposSection workspaceId={workspaceId} data={data} />
    </>
  );
}

function SuffixInput({
  id,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}): JSX.Element {
  return (
    <div className="flex items-stretch sm:w-60">
      <span
        aria-hidden="true"
        className="inline-flex items-center rounded-l-ui bg-ui-surface px-2.5 text-body text-ui-mute ring-1 ring-inset ring-ui-line"
      >
        {RELEASE_SUFFIX_PREFIX}
      </span>
      <input
        id={id}
        className={`${inputCls} rounded-l-none`}
        value={value}
        maxLength={RELEASE_SUFFIX_MAX + 8}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit();
        }}
      />
    </div>
  );
}

function SuffixSection({ workspaceId, data }: { workspaceId: number; data: ReleaseSettingsResponse }): JSX.Element {
  const save = useSetReleaseSettings(workspaceId);
  const releaseId = useId();
  const hotfixId = useId();
  // The TYPED parts (the fixed hyphen is beside the box).
  const [release, setRelease] = useState(() => suffixTypedPart(data.releaseSuffix));
  const [hotfix, setHotfix] = useState(() => suffixTypedPart(data.hotfixSuffix));
  // Re-seeded on the STORED values (and the workspace), never on the response object: a background
  // refetch must not throw away a half-typed suffix.
  const signature = `${workspaceId}:${data.releaseSuffix ?? ''}:${data.hotfixSuffix ?? ''}`;
  // What this section last wrote: its echo must not re-seed over typing done since.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === signature) {
      sent.current = null;
      return;
    }
    setRelease(suffixTypedPart(data.releaseSuffix));
    setHotfix(suffixTypedPart(data.hotfixSuffix));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const next = { releaseSuffix: suffixFromTyped(release), hotfixSuffix: suffixFromTyped(hotfix) };
  const dirty = next.releaseSuffix !== data.releaseSuffix || next.hotfixSuffix !== data.hotfixSuffix;
  const problem = dirty ? validateReleaseSettings(next) : null;
  const warning = dirty && problem == null ? releaseSuffixChangeWarning(data, next) : null;
  const draftSignature = `${workspaceId}:${next.releaseSuffix ?? ''}:${next.hotfixSuffix ?? ''}`;
  const autosave = useAutoSave({
    key: draftSignature,
    ready: dirty && problem == null,
    busy: save.isPending,
    run: () => {
      sent.current = draftSignature;
      save.mutate(next);
    },
    // While the warning shows, only blur / Enter commits (the timer never comes due in practice).
    delayMs: warning != null ? 2_000_000_000 : 700,
  });
  const example = (typed: string, fallback: string): string => `v2.4.0${RELEASE_SUFFIX_PREFIX}${typed.trim() === '' ? fallback : typed}`;

  return (
    <SectionShell
      title="Release tags"
      desc="This Sprint → Releases needs both suffixes. Applies to this workspace only."
      info={
        <InfoButton title="Release tags">
          <p>
            A version tag on the default branch, such as v2.4.0, is released by adding a tag with the release
            suffix on the same commit: v2.4.0-rc for the suffix rc.
          </p>
          <p>A hotfix tag ends in the hotfix suffix. Your team creates those by hand on a hotfix branch.</p>
          <p>
            The hyphen is always added. Type the rest: 1 to {RELEASE_SUFFIX_MAX} characters that git allows in a tag
            name. The two suffixes must be different, and one cannot end with the other.
          </p>
        </InfoButton>
      }
    >
      <Field label="Release suffix" htmlFor={releaseId} hint={example(release, 'rc')}>
        <SuffixInput id={releaseId} value={release} onChange={setRelease} onCommit={autosave.flush} />
      </Field>
      <Field label="Hotfix suffix" htmlFor={hotfixId} hint={example(hotfix, 'hotfix')}>
        <SuffixInput id={hotfixId} value={hotfix} onChange={setHotfix} onCommit={autosave.flush} />
      </Field>
      {warning != null && (
        <p className="rounded-ui bg-ui-raise px-2 py-1.5 text-meta text-ui-warn">
          {warning} Saved when you leave the field.
        </p>
      )}
      <SaveState section="Release tags" mutation={save} dirty={dirty} invalid={problem} />
    </SectionShell>
  );
}

function ReleasableReposSection({ workspaceId, data }: { workspaceId: number; data: ReleaseSettingsResponse }): JSX.Element {
  const save = useSetReleaseRepos(workspaceId);
  const stored = data.repos.filter((r) => r.releasable).map((r) => r.repoId);
  const [ticked, setTicked] = useState<number[]>(stored);
  const signature = `${workspaceId}:${[...stored].sort((a, b) => a - b).join(',')}`;
  // What this section last wrote: its echo must not re-seed over a click made since.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === signature) {
      sent.current = null;
      return;
    }
    setTicked(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const dirty = releaseReposDirty(stored, ticked);
  const draftSignature = `${workspaceId}:${[...ticked].sort((a, b) => a - b).join(',')}`;
  const autosave = useAutoSave({
    key: draftSignature,
    ready: dirty,
    busy: save.isPending,
    run: () => {
      sent.current = draftSignature;
      save.mutate({ repoIds: ticked });
    },
  });
  const toggle = (id: number): void => {
    autosave.now();
    setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  };

  return (
    <SectionShell
      title="Released from this workspace"
      desc="Only ticked repositories are checked, tagged and used as hotfix bases."
      info={
        <InfoButton title="Released from this workspace">
          <p>Tick the repositories your team releases. Releases ignores the others: no rows, no blocks, no warnings.</p>
          <p>In a hotfix build, a repository that is not ticked is read only.</p>
        </InfoButton>
      }
    >
      {data.repos.length === 0 ? (
        <p className="text-meta text-ui-mute">This workspace has no repositories.</p>
      ) : (
        <ul className="space-y-1.5" data-testid="release-repos">
          {data.repos.map((r) => (
            <li key={r.repoId}>
              <label className="flex items-center gap-2 text-body">
                <CheckInput checked={ticked.includes(r.repoId)} onChange={() => toggle(r.repoId)} />
                <span className="min-w-0 truncate">{r.fullName}</span>
                {r.external && <span className="text-meta text-ui-mute">External</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <SaveState section="Released from this workspace" mutation={save} dirty={dirty} />
    </SectionShell>
  );
}
