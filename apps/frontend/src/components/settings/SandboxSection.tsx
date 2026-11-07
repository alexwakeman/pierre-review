import { useEffect, useId, useMemo, useState } from 'react';
import {
  SANDBOX_RESOURCE_DEFAULTS,
  SANDBOX_RESOURCE_LIMITS,
  SANDBOX_SERVICE_STACKS_MAX,
  type SandboxFolderCheck,
  type SandboxServiceStackChoice,
  type SandboxWorkspaceSettings,
  type SandboxWorkspaceSettingsBody,
} from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useQueryClient } from '@tanstack/react-query';
import { sandboxSettingsKey, useRemoveSandboxHost, useSandboxFolderCheck, useSaveSandboxSettings, useSandboxSettings } from '../../hooks/useStoryBuild.js';
import { InfoButton } from '../InfoModal.js';
import { CloseIcon, PlusIcon } from '../Icons.js';
import { CheckInput, Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { sandboxBodyOf, sandboxDraftOf, sandboxDraftDirty, sandboxMemoryTicks, type SandboxDraft } from './sandboxSettingsForm.js';

// SETTINGS → SANDBOX (docs/SANDBOX.md § The workspace mirror, § Services; plan WP4/WP8), the workspace
// part (the computer's container runtime is SandboxRuntimeSection.tsx, above it in the same tab).
//
//   • `SandboxSection` (THIS WORKSPACE, nothing inherited): the local folder and its CHECK (click-gated:
//     a bounded walk of a local folder), the Claude notes to bring, ~/.claude/CLAUDE.md and skills, the
//     starting folder, the services (compose files Limn may run), the "Always allow" hosts, the proxy
//     variables and the resources.
//
// ⚠ DRAFT + SAVE like every section here. ⚠ The PUT REPLACES the whole setting, so the body is built
// from the WHOLE draft (`sandboxBodyOf`), never a patch of the changed fields.

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';
const SUBHEAD = 'text-meta font-semibold text-ui-ink';
/** A text field of a set width (the shared one is full width). */
const sized = (w: string): string => `${inputCls.replace('w-full ', '')} ${w}`;

export function SandboxSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useSandboxSettings(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="Sandbox" failed={q.isError} />;
  }
  return <SandboxForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

function SandboxForm({ workspaceId, saved }: { workspaceId: number; saved: SandboxWorkspaceSettings }): JSX.Element {
  const save = useSaveSandboxSettings(workspaceId);
  const ids = { folder: useId(), start: useId(), cpus: useId(), mem: useId(), disk: useId(), host: useId() };
  const [draft, setDraft] = useState<SandboxDraft>(() => sandboxDraftOf(saved));
  // Re-seed on the STORED values (first load, after a save), never the response object.
  const signature = JSON.stringify(sandboxDraftOf(saved));
  useEffect(() => {
    setDraft(sandboxDraftOf(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const set = (patch: Partial<SandboxDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  // THE CHECK is CLICK-GATED: it runs for the folder in the draft when the reader presses Check.
  const [checkFor, setCheckFor] = useState<string | null | undefined>(undefined);
  const [checked, setChecked] = useState(false);
  const check = useSandboxFolderCheck(workspaceId, checkFor, checked);
  const result: SandboxFolderCheck | null = check.data?.workspaceId === workspaceId ? check.data : null;
  const runCheck = (): void => {
    const trimmed = draft.localFolder.trim();
    const f = trimmed === '' ? null : trimmed;
    // The same folder again: look again (the key does not change, so ask for it).
    if (checked && f === checkFor) void check.refetch();
    setCheckFor(f);
    setChecked(true);
  };

  const dirty = sandboxDraftDirty(draft, saved);
  const body: SandboxWorkspaceSettingsBody = sandboxBodyOf(draft);
  const err = save.error instanceof ApiError ? save.error.message : save.error != null ? (save.error as Error).message : null;
  const ticks = useMemo(() => sandboxMemoryTicks(result?.memories ?? [], draft.memoryProjects), [result?.memories, draft.memoryProjects]);
  const repoNames = useMemo(
    () => [...(result?.matched ?? []).map((r) => r.fullName), ...(result?.notCloned ?? []).map((r) => r.fullName)].sort(),
    [result],
  );

  return (
    <SectionShell
      title="Sandbox"
      desc="What an Implement session gets: where the repositories go, your Claude notes, and the services it may start."
      info={
        <InfoButton title="Sandbox" width="lg">
          <div className="space-y-2">
            <p>
              The code always comes from Limn’s own copy of each repository, synced from GitHub. Your folder only decides where
              each repository sits inside the sandbox, so your Claude notes and the paths they name still work.
            </p>
            <p>Repositories are matched by their git remote. A clone of a repository outside this workspace is named and left out.</p>
            <p>Your notes, CLAUDE.md and skills are copied in. The originals are never changed.</p>
          </div>
        </InfoButton>
      }
    >
      <div data-testid="sandbox-settings" className="space-y-3">
        <Field label="Your local folder" htmlFor={ids.folder} hint="The folder that holds your clones. Leave empty to put each repository under /workspace.">
          <div className="flex gap-2">
            <input
              id={ids.folder}
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
              placeholder="/Users/you/Projects/my-team"
              value={draft.localFolder}
              onChange={(e) => set({ localFolder: e.target.value })}
            />
            <button type="button" data-testid="sandbox-check" className={SECONDARY_BTN} disabled={check.isFetching} onClick={runCheck}>
              {check.isFetching ? 'Checking…' : 'Check'}
            </button>
          </div>
        </Field>
        {check.isError && <p className="text-meta text-ui-danger">Could not check the folder.</p>}
        {result != null && <FolderCheckResult result={result} />}

        {result != null && result.memories.length > 0 && (
          <fieldset className="space-y-1.5">
            <legend className={SUBHEAD}>Claude notes to bring</legend>
            {ticks.map((m) => (
              <label key={m.dir} className="flex cursor-pointer items-center gap-2 text-body text-ui-ink">
                <CheckInput
                  checked={m.ticked}
                  onChange={(e) => set({ memoryProjects: m.toggle(e.target.checked) })}
                />
                <span className="min-w-0 break-all font-mono text-meta">{m.dir}</span>
                <span className="text-meta text-ui-mute">
                  {m.memoryCount} note{m.memoryCount === 1 ? '' : 's'}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-body text-ui-ink">
          <CheckInput checked={draft.userClaudeMd} onChange={(e) => set({ userClaudeMd: e.target.checked })} />
          Bring your ~/.claude/CLAUDE.md
          {result != null && !result.userClaudeMd && <span className="text-meta text-ui-mute">(none found)</span>}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-body text-ui-ink">
          <CheckInput checked={draft.userSkills} onChange={(e) => set({ userSkills: e.target.checked })} />
          Bring your Claude skills
          {result != null && (
            <span className="text-meta text-ui-mute">
              ({result.userSkills.length} found)
            </span>
          )}
        </label>

        <Field
          label="Starting folder"
          htmlFor={ids.start}
          hint={result != null ? `Empty: ${result.startDir}` : 'Empty: the project with the most notes, else your folder.'}
        >
          <input
            id={ids.start}
            className={inputCls}
            autoComplete="off"
            spellCheck={false}
            value={draft.startDir}
            onChange={(e) => set({ startDir: e.target.value })}
          />
        </Field>

        <ServicesEditor services={draft.services} repoNames={repoNames} onChange={(services) => set({ services })} />

        <AllowedHosts workspaceId={workspaceId} hosts={saved.alwaysAllowedHosts} inputId={ids.host} />

        <label className="flex cursor-pointer items-start gap-2 text-body text-ui-ink">
          <CheckInput className="mt-0.5" checked={draft.globalProxyEnv} onChange={(e) => set({ globalProxyEnv: e.target.checked })} />
          <span>
            Set HTTP_PROXY for every program
            <span className="block text-meta text-ui-mute">
              Off: only npm, pnpm, yarn, pip and git use the network filter, so the code under test still reaches local services.
            </span>
          </span>
        </label>

        <fieldset>
          <legend className={SUBHEAD}>Resources</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <ResourceInput id={ids.cpus} label="CPUs" value={draft.cpus} fallback={SANDBOX_RESOURCE_DEFAULTS.cpus} limits={SANDBOX_RESOURCE_LIMITS.cpus} onChange={(cpus) => set({ cpus })} />
            <ResourceInput id={ids.mem} label="Memory (GB)" value={draft.memoryGb} fallback={SANDBOX_RESOURCE_DEFAULTS.memoryGb} limits={SANDBOX_RESOURCE_LIMITS.memoryGb} onChange={(memoryGb) => set({ memoryGb })} />
            <ResourceInput id={ids.disk} label="Disk (GB)" value={draft.diskGb} fallback={SANDBOX_RESOURCE_DEFAULTS.diskGb} limits={SANDBOX_RESOURCE_LIMITS.diskGb} onChange={(diskGb) => set({ diskGb })} />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <SaveButton dirty={dirty} saving={save.isPending} onClick={() => save.mutate(body)} />
          {err != null && <span className="text-meta text-ui-danger">{err}</span>}
          {save.isSuccess && !dirty && <span className="text-meta text-ui-mute">Saved.</span>}
        </div>
      </div>
    </SectionShell>
  );
}

function FolderCheckResult({ result }: { result: SandboxFolderCheck }): JSX.Element {
  if (result.problem != null) {
    return (
      <p data-testid="sandbox-check-result" className="text-meta text-ui-warn">
        {result.problem}
      </p>
    );
  }
  return (
    <div data-testid="sandbox-check-result" className="space-y-2 rounded-ui bg-ui-raise p-3 text-meta">
      {result.matched.length > 0 && (
        <div>
          <p className={SUBHEAD}>Found in your folder ({result.matched.length})</p>
          <ul className="mt-1 space-y-0.5">
            {result.matched.map((r) => (
              <li key={r.repoId} className="flex flex-wrap gap-x-2">
                <span className="text-ui-ink">{r.fullName}</span>
                <span className="break-all font-mono text-ui-mute">{r.localPath}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.notCloned.length > 0 && (
        <div>
          <p className={SUBHEAD}>Not in your folder ({result.notCloned.length})</p>
          <ul className="mt-1 space-y-0.5">
            {result.notCloned.map((r) => (
              <li key={r.repoId} className="flex flex-wrap gap-x-2">
                <span className="text-ui-ink">{r.fullName}</span>
                <span className="text-ui-mute">goes to</span>
                <span className="break-all font-mono text-ui-mute">{r.sandboxPath}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.outside.length > 0 && (
        <p className="text-ui-mute">
          Left out, not in this workspace: {result.outside.map((o) => o.fullName).join(', ')}.
        </p>
      )}
      {result.truncated && <p className="text-ui-warn">The folder is large, so Limn stopped looking. Some clones may be missing.</p>}
    </div>
  );
}

function ResourceInput({
  id,
  label,
  value,
  fallback,
  limits,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  fallback: number;
  limits: { min: number; max: number };
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={limits.min}
        max={limits.max}
        className={inputCls}
        placeholder={String(fallback)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function ServicesEditor({
  services,
  repoNames,
  onChange,
}: {
  services: SandboxServiceStackChoice[];
  repoNames: string[];
  onChange: (s: SandboxServiceStackChoice[]) => void;
}): JSX.Element {
  const listId = useId();
  const [repo, setRepo] = useState('');
  const [file, setFile] = useState('compose.yml');
  const canAdd = /^[^/\s]+\/[^/\s]+$/.test(repo.trim()) && file.trim() !== '' && services.length < SANDBOX_SERVICE_STACKS_MAX;
  return (
    <fieldset data-testid="sandbox-services" className="space-y-1.5">
      <legend className="flex items-center gap-1">
        <span className={SUBHEAD}>Services</span>
        <InfoButton title="Services">
          <div className="space-y-2">
            <p>
              Compose files Limn may start for a session, for integration tests. The AI asks for them with <code>limn-svc up</code>; it
              never gets Docker itself.
            </p>
            <p>
              A file that asks for privileged mode, extra system rights, host folders or the Docker socket is refused, with the
              reason shown in the session.
            </p>
            <p>Services reach the internet only when you name them under “Online”.</p>
          </div>
        </InfoButton>
      </legend>
      {services.length === 0 && <p className="text-meta text-ui-mute">None. The AI can still run unit tests.</p>}
      <ul className="space-y-1">
        {services.map((s, i) => (
          <li key={`${s.repo}/${s.file}`} className="flex flex-wrap items-center gap-2 text-body">
            <span className="text-ui-ink">{s.repo}</span>
            <span className="font-mono text-meta text-ui-mute">{s.file}</span>
            <label className="flex items-center gap-1 text-meta text-ui-mute">
              Online:
              <input
                className={`${sized('w-40')} py-0.5`}
                placeholder="none"
                value={s.egress.join(', ')}
                onChange={(e) => {
                  const egress = e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter((x) => x !== '');
                  onChange(services.map((x, j) => (j === i ? { ...x, egress } : x)));
                }}
              />
            </label>
            <button
              type="button"
              className="hit rounded-ui p-1 text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
              aria-label={`Remove ${s.repo} ${s.file}`}
              onClick={() => onChange(services.filter((_, j) => j !== i))}
            >
              <CloseIcon size={11} />
            </button>
          </li>
        ))}
      </ul>
      {services.length < SANDBOX_SERVICE_STACKS_MAX && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Repository (owner/name)"
            className={`${sized('w-56')}`}
            placeholder="owner/repository"
            list={listId}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <datalist id={listId}>
            {repoNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <input aria-label="Compose file" className={`${sized('w-44')} font-mono`} value={file} onChange={(e) => setFile(e.target.value)} />
          <button
            type="button"
            className={SECONDARY_BTN}
            disabled={!canAdd}
            onClick={() => {
              const next = { repo: repo.trim(), file: file.trim().replace(/^\.\//, ''), egress: [] };
              if (services.some((s) => s.repo === next.repo && s.file === next.file)) return;
              onChange([...services, next]);
              setRepo('');
            }}
          >
            <PlusIcon size={11} />
            Add
          </button>
        </div>
      )}
    </fieldset>
  );
}

/** The "Always allow" hosts: saved at once (they are not part of the PUT), like the Network panel's button. */
function AllowedHosts({ workspaceId, hosts, inputId }: { workspaceId: number; hosts: string[]; inputId: string }): JSX.Element {
  const qc = useQueryClient();
  const remove = useRemoveSandboxHost(workspaceId);
  const [rule, setRule] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (): Promise<void> => {
    setAdding(true);
    setError(null);
    try {
      const saved = await api.addSandboxAllowedHost(workspaceId, rule.trim());
      qc.setQueryData(sandboxSettingsKey(workspaceId), saved);
      setRule('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that host.');
    } finally {
      setAdding(false);
    }
  };
  return (
    <div data-testid="sandbox-allowed-hosts" className="space-y-1.5">
      <p className={SUBHEAD}>Hosts always allowed</p>
      <p className="text-meta text-ui-mute">Besides the AI provider, the package registries and GitHub downloads, which are always on.</p>
      {hosts.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {hosts.map((h) => (
            <li key={h} className="inline-flex items-center gap-1 rounded-full bg-ui-raise px-2.5 py-0.5 font-mono text-meta text-ui-ink">
              {h}
              <button
                type="button"
                className="hit -mr-1 rounded-full p-0.5 text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
                aria-label={`Stop allowing ${h}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(h)}
              >
                <CloseIcon size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          aria-label="Host to allow"
          className={`${sized('w-64')} font-mono`}
          placeholder="registry.example.com"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rule.trim() !== '') void add();
          }}
        />
        <button type="button" className={SECONDARY_BTN} disabled={adding || rule.trim() === ''} onClick={() => void add()}>
          <PlusIcon size={11} />
          Allow
        </button>
      </div>
      {error != null && <p className="text-meta text-ui-danger">{error}</p>}
    </div>
  );
}
