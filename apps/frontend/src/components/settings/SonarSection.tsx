import { useEffect, useId, useRef, useState } from 'react';
import type { WorkspaceSonarSettings, WorkspaceSonarUpdate } from '@pierre-review/shared';
import { useCheckWorkspaceSonar, useUpdateWorkspaceSonar, useWorkspaceSonar } from '../../hooks/useSonar.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * "SonarCloud" for THIS workspace (CORE, free, both modes; docs/SONARCLOUD.md). The organization, a
 * WRITE-ONLY token and each repo's project key (SonarCloud's `<owner>_<repo>` default unless typed).
 *
 * No Save button (./autosave.tsx): the organization and the project keys save as you type
 * (debounced, at once on blur / Enter). The token is written ONLY on blur or Enter of a non-empty
 * value, never per keystroke; Remove writes at once.
 * ⚠ THE TOKEN IS NEVER SHOWN: the server answers `hasToken` only, so the input starts empty and a
 * saved token reads "Saved" with Replace / Remove.
 * ⚠ "Test connection" is CLICK-GATED (it calls SonarCloud with the SAVED token) and waits while a
 * change is still being written.
 */
export function SonarSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWorkspaceSonar(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="SonarCloud" failed={q.isError} />;
  }
  return <SonarForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

function SonarForm({ workspaceId, saved }: { workspaceId: number; saved: WorkspaceSonarSettings }): JSX.Element {
  const save = useUpdateWorkspaceSonar(workspaceId);
  // The token's own write (commit on blur / Enter, Remove), apart from the fields' autosave.
  const tokenSave = useUpdateWorkspaceSonar(workspaceId);
  const check = useCheckWorkspaceSonar(workspaceId);
  const ids = { org: useId(), token: useId() };

  const savedKeys = (): Record<number, string> =>
    Object.fromEntries(saved.repos.map((r) => [r.repoId, r.overridden ? r.projectKey : '']));

  const [org, setOrg] = useState(saved.organization ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [keys, setKeys] = useState<Record<number, string>>(savedKeys);

  // Re-seed on the STORED values (first load, after a write), never the response object — and each
  // field on its OWN stored value, so one write landing never wipes a half-typed other field.
  useEffect(() => setOrg(saved.organization ?? ''), [saved.organization]);
  useEffect(() => {
    setToken('');
    setReplacing(false);
  }, [saved.hasToken]);
  const keysSignature = saved.repos.map((r) => `${r.repoId}:${r.overridden ? r.projectKey : ''}`).join(',');
  const prevKeys = useRef<Record<number, string>>(savedKeys());
  useEffect(() => {
    const now = savedKeys();
    const prev = prevKeys.current;
    prevKeys.current = now;
    // Only a repo whose STORED key moved is re-seeded; a draft on another repo is kept.
    setKeys((k) => {
      const next = { ...k };
      for (const r of saved.repos) if (prev[r.repoId] !== now[r.repoId] || !(r.repoId in k)) next[r.repoId] = now[r.repoId] ?? '';
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature]);

  const typedToken = token.trim();
  const before = savedKeys();
  const changedKeys = saved.repos.filter((r) => (keys[r.repoId] ?? '').trim() !== (before[r.repoId] ?? ''));
  const orgChanged = org.trim() !== (saved.organization ?? '');
  const dirty = orgChanged || changedKeys.length > 0;
  const showTokenInput = !saved.hasToken || replacing;

  const autosave = useAutoSave({
    key: JSON.stringify([org.trim(), changedKeys.map((r) => [r.repoId, (keys[r.repoId] ?? '').trim()])]),
    ready: dirty,
    busy: save.isPending,
    run: () => {
      const patch: WorkspaceSonarUpdate = {};
      if (orgChanged) patch.organization = org.trim() === '' ? null : org.trim();
      if (changedKeys.length > 0) {
        patch.projectKeys = Object.fromEntries(changedKeys.map((r) => [String(r.repoId), (keys[r.repoId] ?? '').trim() || null]));
      }
      save.mutate(patch);
    },
  });
  const flushOnEnter = (e: { key: string }): void => {
    if (e.key === 'Enter') autosave.flush();
  };
  // A committed secret leaves the field at once and is never echoed (Replace closes too).
  const clearToken = (): void => {
    setToken('');
    setReplacing(false);
  };
  const commitToken = (): void => {
    if (typedToken === '' || tokenSave.isPending) return;
    tokenSave.mutate({ token: typedToken }, { onSuccess: clearToken });
  };

  const result = check.data?.workspaceId === workspaceId ? check.data : null;
  const found = new Map(result?.projects.map((p) => [p.repoId, p.found]) ?? []);

  return (
    <SectionShell
      title="SonarCloud"
      desc="Feed SonarCloud’s findings into AI Review and AI Fix."
      info={
        <InfoButton title="SonarCloud">
          <div className="space-y-2">
            <p>
              Create a token in SonarCloud under My Account → Security. Ensemble uses it to read each PR’s
              issues, security hotspots, quality gate and rule advice. It only reads.
            </p>
            <p>The token is stored sealed and is never shown again.</p>
            <p>
              Each repo’s project key defaults to SonarCloud’s own (owner_repo). Type one only if yours
              differs.
            </p>
          </div>
        </InfoButton>
      }
    >
      <Field label="Organization key" htmlFor={ids.org}>
        <input
          id={ids.org}
          className={inputCls}
          autoComplete="off"
          placeholder="my-org"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          onBlur={autosave.flush}
          onKeyDown={flushOnEnter}
        />
      </Field>

      {showTokenInput ? (
        <Field
          label="Token"
          htmlFor={ids.token}
          hint={saved.hasToken ? 'Saved when you press Enter or leave the field. It replaces the saved one.' : 'Saved when you press Enter or leave the field.'}
        >
          <input
            id={ids.token}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={commitToken}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitToken();
              }
            }}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-body">
          <span className="font-medium text-ui-mute">Token</span>
          <div className="flex items-center gap-2">
            <span className="text-ui-ink">
              {saved.tokenUnreadable ? 'Saved, but unreadable here. Replace it.' : 'Saved'}
            </span>
            <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              type="button"
              className={SECONDARY_BTN}
              disabled={tokenSave.isPending}
              onClick={() => tokenSave.mutate({ clearToken: true })}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      <SaveState section="SonarCloud token" mutation={tokenSave} dirty={false} />

      {saved.repos.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-meta font-medium text-ui-mute">Project keys</span>
          <ul className="space-y-1">
            {saved.repos.map((r) => {
              const f = found.get(r.repoId);
              return (
                <li key={r.repoId} className="grid grid-cols-1 items-center gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:gap-2">
                  <span className="break-all text-body text-ui-ink">{r.fullName}</span>
                  <input
                    aria-label={`SonarCloud project key for ${r.fullName}`}
                    className={inputCls}
                    autoComplete="off"
                    placeholder={r.defaultKey}
                    value={keys[r.repoId] ?? ''}
                    onChange={(e) => setKeys((k) => ({ ...k, [r.repoId]: e.target.value }))}
                    onBlur={autosave.flush}
                    onKeyDown={flushOnEnter}
                  />
                  <span className="text-meta text-ui-mute">
                    {f === true ? 'Found' : f === false ? 'Not found' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BTN}
          disabled={dirty || !saved.hasToken || saved.organization == null || check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Testing…' : 'Test connection'}
        </button>
        {!dirty && (!saved.hasToken || saved.organization == null) && (
          <span className="text-meta text-ui-mute">Add an organization and a token first.</span>
        )}
        {result != null && (
          <span
            className={`text-meta ${result.ok ? 'text-ui-success' : 'text-ui-danger'}`}
          >
            {result.message}
          </span>
        )}
      </div>
      {check.isError && <p className="text-body text-ui-danger">{check.error.message}</p>}

      <SaveState section="SonarCloud" mutation={save} dirty={dirty} />
      <p className="text-meta text-ui-faint">Applies to this workspace only.</p>
    </SectionShell>
  );
}
