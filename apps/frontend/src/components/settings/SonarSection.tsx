import { useEffect, useId, useState } from 'react';
import type { WorkspaceSonarSettings, WorkspaceSonarUpdate } from '@pierre-review/shared';
import { useCheckWorkspaceSonar, useUpdateWorkspaceSonar, useWorkspaceSonar } from '../../hooks/useSonar.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "SonarCloud" for THIS workspace (CORE, free, both modes; docs/SONARCLOUD.md). The organization, a
 * WRITE-ONLY token and each repo's project key (SonarCloud's `<owner>_<repo>` default unless typed).
 *
 * ⚠ DRAFT + SAVE, like every other section here: typing writes nothing. Removing the token is a
 * draft change too, saved with the rest.
 * ⚠ THE TOKEN IS NEVER SHOWN: the server answers `hasToken` only, so the input starts empty and a
 * saved token reads "Saved" with Replace / Remove.
 * ⚠ "Test connection" is CLICK-GATED (it calls SonarCloud with the SAVED token) and asks for a save
 * first when the draft differs.
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
  const check = useCheckWorkspaceSonar(workspaceId);
  const ids = { org: useId(), token: useId() };

  const savedKeys = (): Record<number, string> =>
    Object.fromEntries(saved.repos.map((r) => [r.repoId, r.overridden ? r.projectKey : '']));

  const [org, setOrg] = useState(saved.organization ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [keys, setKeys] = useState<Record<number, string>>(savedKeys);

  // Re-seed on the STORED values (first load, after a save), never the response object.
  const signature = `${saved.organization ?? ''}|${saved.hasToken}|${saved.repos
    .map((r) => `${r.repoId}:${r.overridden ? r.projectKey : ''}`)
    .join(',')}`;
  useEffect(() => {
    setOrg(saved.organization ?? '');
    setToken('');
    setReplacing(false);
    setRemoving(false);
    setKeys(savedKeys());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const typedToken = token.trim();
  const before = savedKeys();
  const changedKeys = saved.repos.filter((r) => (keys[r.repoId] ?? '').trim() !== (before[r.repoId] ?? ''));
  const orgChanged = org.trim() !== (saved.organization ?? '');
  const dirty = orgChanged || typedToken !== '' || removing || changedKeys.length > 0;
  const showTokenInput = (!saved.hasToken || replacing) && !removing;

  const onSave = (): void => {
    const patch: WorkspaceSonarUpdate = {};
    if (orgChanged) patch.organization = org.trim() === '' ? null : org.trim();
    if (removing) patch.clearToken = true;
    else if (typedToken !== '') patch.token = typedToken;
    if (changedKeys.length > 0) {
      patch.projectKeys = Object.fromEntries(changedKeys.map((r) => [String(r.repoId), (keys[r.repoId] ?? '').trim() || null]));
    }
    save.mutate(patch);
  };

  const result = check.data?.workspaceId === workspaceId ? check.data : null;
  const found = new Map(result?.projects.map((p) => [p.repoId, p.found]) ?? []);

  return (
    <SectionShell
      title="SonarCloud"
      desc="Feed SonarCloud’s findings into Claude Review and AI Fix."
      info={
        <InfoButton title="SonarCloud">
          <div className="space-y-2">
            <p>
              Create a token in SonarCloud under My Account → Security. Limn uses it to read each PR’s
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
        />
      </Field>

      {showTokenInput ? (
        <Field
          label="Token"
          htmlFor={ids.token}
          hint={saved.hasToken ? 'Replaces the saved token when you save.' : undefined}
        >
          <input
            id={ids.token}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-300">Token</span>
          <div className="flex items-center gap-2">
            <span className="text-gray-700 dark:text-gray-200">
              {removing ? 'Removed when you save' : saved.tokenUnreadable ? 'Saved, but unreadable here. Replace it.' : 'Saved'}
            </span>
            {removing ? (
              <button type="button" className={SECONDARY_BTN} onClick={() => setRemoving(false)}>
                Keep it
              </button>
            ) : (
              <>
                <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
                  Replace
                </button>
                <button type="button" className={SECONDARY_BTN} onClick={() => setRemoving(true)}>
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {saved.repos.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Project keys</span>
          <ul className="space-y-1">
            {saved.repos.map((r) => {
              const f = found.get(r.repoId);
              return (
                <li key={r.repoId} className="grid grid-cols-1 items-center gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:gap-2">
                  <span className="break-all text-xs text-gray-700 dark:text-gray-200">{r.fullName}</span>
                  <input
                    aria-label={`SonarCloud project key for ${r.fullName}`}
                    className={inputCls}
                    autoComplete="off"
                    placeholder={r.defaultKey}
                    value={keys[r.repoId] ?? ''}
                    onChange={(e) => setKeys((k) => ({ ...k, [r.repoId]: e.target.value }))}
                  />
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
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
        {dirty && <span className="text-[11px] text-gray-500 dark:text-gray-400">Save first.</span>}
        {!dirty && (!saved.hasToken || saved.organization == null) && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">Save an organization and a token first.</span>
        )}
        {result != null && (
          <span
            className={`text-[11px] ${result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {result.message}
          </span>
        )}
      </div>
      {check.isError && <p className="text-xs text-red-600 dark:text-red-400">{check.error.message}</p>}

      <SaveButton dirty={dirty} saving={save.isPending} onClick={onSave} />
      <p className="text-[11px] text-gray-400">Applies to this workspace only.</p>
      {save.isError && (
        <div className="text-[11px] text-red-500">{save.error?.message ?? 'Couldn’t save this setting.'}</div>
      )}
    </SectionShell>
  );
}
