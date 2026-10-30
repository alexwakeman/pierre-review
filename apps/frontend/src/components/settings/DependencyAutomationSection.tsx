import { useEffect, useMemo, useState } from 'react';
import {
  DEPENDENCY_ECOSYSTEM_LABEL,
  DEPENDENCY_ECOSYSTEMS,
  type AutomatedReviewerKind,
  type DependencyAutomationPatch,
  type DependencyBot,
  type DependencyEcosystem,
  type DependencyUpdateLevel,
  type WorkspaceDependencyAutomationResponse,
} from '@pierre-review/shared';
import { useDependencyAutomation, useSetDependencyAutomation } from '../../hooks/useDependencyMergeAll.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { automatedReviewerMeta } from '../../lib/ui.js';
import { InfoButton } from '../InfoModal.js';
import { CheckInput, RadioInput, SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// SETTINGS → DEPENDENCIES (CORE, free). Everything the server does to dependency updates in THIS
// workspace, every switch OFF by default (docs/MERGE-CI-TRUNK.md § Dependency automation):
//   • merge them once their required checks pass (`dependency_auto_merge`, the older switch);
//   • approve them once CI passes — trusted bots only;
//   • resolve their conflicts — ask the bot to rebase, then (where AI runs) an AI run — trusted bots
//     only;
//   • ONE policy over all three: the largest update, security fixes only, which ecosystems;
//   • which of the workspace's dependency bots the reader TRUSTS (a mark on the bot's row).
//
// ⚠ DRAFT + SAVE, like every other section in this modal — toggling a box writes NOTHING. A switch
// that approves or merges on the reader's behalf is the last one that should fire on a stray click.
// One Save sends only what changed.

interface Draft {
  autoMerge: boolean;
  autoApprove: boolean;
  autoResolveConflicts: boolean;
  maxLevel: DependencyUpdateLevel;
  securityOnly: boolean;
  /** null = every ecosystem. */
  ecosystems: DependencyEcosystem[] | null;
  trusted: number[];
}

function draftOf(r: WorkspaceDependencyAutomationResponse): Draft {
  return {
    autoMerge: r.settings.autoMerge,
    autoApprove: r.settings.autoApprove,
    autoResolveConflicts: r.settings.autoResolveConflicts,
    maxLevel: r.settings.policy.maxLevel,
    securityOnly: r.settings.policy.securityOnly,
    ecosystems: r.settings.policy.ecosystems,
    trusted: r.bots.filter((b) => b.trusted).map((b) => b.userId).sort((a, b) => a - b),
  };
}

const sameList = <T,>(a: readonly T[] | null, b: readonly T[] | null): boolean =>
  a === b || (a != null && b != null && a.length === b.length && a.every((x, i) => x === b[i]));

/** Only what changed — the patch a Save sends. */
function patchOf(stored: Draft, d: Draft): DependencyAutomationPatch {
  const p: DependencyAutomationPatch = {};
  if (d.autoMerge !== stored.autoMerge) p.autoMerge = d.autoMerge;
  if (d.autoApprove !== stored.autoApprove) p.autoApprove = d.autoApprove;
  if (d.autoResolveConflicts !== stored.autoResolveConflicts) p.autoResolveConflicts = d.autoResolveConflicts;
  if (d.maxLevel !== stored.maxLevel) p.maxLevel = d.maxLevel;
  if (d.securityOnly !== stored.securityOnly) p.securityOnly = d.securityOnly;
  if (!sameList(d.ecosystems, stored.ecosystems)) p.ecosystems = d.ecosystems;
  if (!sameList(d.trusted, stored.trusted)) p.trustedBotIds = d.trusted;
  return p;
}

const LEVEL_ROWS: Array<{ value: DependencyUpdateLevel; label: string }> = [
  { value: 'patch', label: 'Patch updates only' },
  { value: 'minor', label: 'Patch and minor updates' },
  { value: 'major', label: 'All updates, major ones too' },
];

function botName(b: DependencyBot): string {
  if (b.label) return b.label;
  const meta = b.kind ? automatedReviewerMeta(b.kind as AutomatedReviewerKind) : undefined;
  return meta?.label ?? b.login;
}

/** One checkbox row: the words, and a one-line consequence under them. */
function SwitchRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-body">
      <CheckInput className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-ui-ink">{label}</span>
        <span className="mt-0.5 block text-meta text-ui-mute">{hint}</span>
      </span>
    </label>
  );
}

export function DependencyAutomationSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useDependencyAutomation(workspaceId);
  const save = useSetDependencyAutomation(workspaceId);
  const aiEnabled = useAiCapabilities().enabled;

  // `?.` everywhere: an unexpected body must render the pending shell, never throw (the SPA has no
  // error boundary).
  const data = query.data?.settings != null && Array.isArray(query.data.bots) ? query.data : null;
  const stored = useMemo(() => (data ? draftOf(data) : null), [data]);
  // Re-seed on the resolved workspace and the STORED values only — keyed on a stable string, never
  // the response object, whose identity changes on every background refetch and would revert a
  // half-made edit.
  const storedKey = stored ? JSON.stringify(stored) : null;
  const [draft, setDraft] = useState<Draft | null>(stored);
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, storedKey]);

  if (workspaceId == null || stored == null || draft == null || data == null) {
    return <ScopePendingSection title="Dependency updates" failed={query.isError} />;
  }
  const patch = patchOf(stored, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const toggleEco = (e: DependencyEcosystem, on: boolean) => {
    const cur = new Set(draft.ecosystems ?? []);
    if (on) cur.add(e);
    else cur.delete(e);
    set({ ecosystems: DEPENDENCY_ECOSYSTEMS.filter((x) => cur.has(x)) });
  };
  const toggleBot = (id: number, on: boolean) => {
    const cur = new Set(draft.trusted);
    if (on) cur.add(id);
    else cur.delete(id);
    set({ trusted: [...cur].sort((a, b) => a - b) });
  };
  const trustedNeeded = draft.autoApprove || draft.autoResolveConflicts;
  // "Only these" with nothing ticked would admit nothing at all — never saved that way.
  const noEcosystem = draft.ecosystems != null && draft.ecosystems.length === 0;

  return (
    <SectionShell
      title="Dependency updates"
      desc="What Limn does with Dependabot, Renovate and other dependency bots’ pull requests here."
      info={
        <InfoButton title="Dependency updates">
          <p>
            Limn checks every two minutes while it is running. It merges only once GitHub’s required checks pass, and
            approves only once all CI is green. A pull request you cancel is left alone after that.
          </p>
          <p className="mt-2">
            Approving and resolving conflicts happen under your GitHub account, and only for the bots you trust below.
            Limn approves each new commit once and never retries a failed approval.
          </p>
          <p className="mt-2">
            For a conflict, Limn first asks the bot to rebase: a comment for Dependabot, the rebase checkbox for Renovate.
            {aiEnabled
              ? ' If the branch still conflicts 30 minutes later, or the bot can’t be asked, AI resolves the conflicts and pushes a merge commit to the branch. It pushes only when it decided every conflict and was sure of each, and stops while you are over your AI spend limit. CI must pass again before Limn approves or merges.'
              : ' AI conflict resolution is off on this machine.'}
          </p>
          <p className="mt-2">
            Update size is read from the version numbers in the pull request. When Limn can’t read it, only “All updates”
            lets it through. An ecosystem list lets a pull request through only when every ecosystem it changes is ticked.
          </p>
        </InfoButton>
      }
    >
      <div className="space-y-2">
        <SwitchRow
          checked={draft.autoMerge}
          onChange={(v) => set({ autoMerge: v })}
          label="Merge them automatically"
          hint="In repositories you can push to, once their required checks pass. Drafts and conflicts are left alone."
        />
        <SwitchRow
          checked={draft.autoApprove}
          onChange={(v) => set({ autoApprove: v })}
          label="Approve them automatically"
          hint="Once CI passes, as you. Trusted bots only."
        />
        <SwitchRow
          checked={draft.autoResolveConflicts}
          onChange={(v) => set({ autoResolveConflicts: v })}
          label="Resolve their conflicts"
          hint={
            aiEnabled
              ? 'Asks the bot to rebase, then resolves them with AI if it can’t. Trusted bots only.'
              : 'Asks the bot to rebase. Trusted bots only.'
          }
        />
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-meta font-medium text-ui-mute">Which updates</legend>
        {LEVEL_ROWS.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-body">
            <RadioInput
              name={`dep-level-${workspaceId}`}
              checked={draft.maxLevel === r.value}
              onChange={() => set({ maxLevel: r.value })}
            />
            {r.label}
          </label>
        ))}
        <label className="flex items-center gap-2 pt-1 text-body">
          <CheckInput checked={draft.securityOnly} onChange={(e) => set({ securityOnly: e.target.checked })} />
          Security fixes only
        </label>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-meta font-medium text-ui-mute">Ecosystems</legend>
        <label className="flex items-center gap-2 text-body">
          <RadioInput
            name={`dep-eco-${workspaceId}`}
            checked={draft.ecosystems == null}
            onChange={() => set({ ecosystems: null })}
          />
          All ecosystems
        </label>
        <label className="flex items-center gap-2 text-body">
          <RadioInput
            name={`dep-eco-${workspaceId}`}
            checked={draft.ecosystems != null}
            onChange={() => set({ ecosystems: draft.ecosystems ?? [] })}
          />
          Only these
        </label>
        {draft.ecosystems != null && (
          <div className="grid grid-cols-1 gap-1 pl-6 sm:grid-cols-2">
            {DEPENDENCY_ECOSYSTEMS.map((e) => (
              <label key={e} className="flex items-center gap-2 text-body">
                <CheckInput
                  checked={draft.ecosystems!.includes(e)}
                  onChange={(ev) => toggleEco(e, ev.target.checked)}
                />
                {DEPENDENCY_ECOSYSTEM_LABEL[e]}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-meta font-medium text-ui-mute">Trusted bots</legend>
        {data.bots.length === 0 ? (
          <p className="text-meta text-ui-mute">No dependency bots have opened pull requests here yet.</p>
        ) : (
          data.bots.map((b) => (
            <label key={b.userId} className="flex items-start gap-2 text-body">
              <CheckInput
                className="mt-0.5"
                checked={draft.trusted.includes(b.userId)}
                onChange={(e) => toggleBot(b.userId, e.target.checked)}
              />
              <span>
                <span className="font-medium text-ui-ink">{botName(b)}</span>
                <span className="ml-1.5 text-meta text-ui-faint">{b.login}</span>
                {!b.canRebase && (
                  <span className="mt-0.5 block text-meta text-ui-mute">Can’t be asked to rebase.</span>
                )}
              </span>
            </label>
          ))
        )}
        {trustedNeeded && draft.trusted.length === 0 && data.bots.length > 0 && (
          <p className="text-meta text-ui-mute">Approving and resolving conflicts do nothing until you trust a bot.</p>
        )}
      </fieldset>

      {noEcosystem && <p className="text-meta text-ui-mute">Tick at least one ecosystem, or pick All ecosystems.</p>}
      <SaveButton dirty={dirty && !noEcosystem} saving={save.isPending} onClick={() => save.mutate(patch)} />
      <p className="text-meta text-ui-faint">Applies to this workspace only.</p>

      {save.isError && (
        <div className="text-meta text-ui-danger">
          {(save.error as Error)?.message ?? 'Couldn’t save these settings.'}
        </div>
      )}
    </SectionShell>
  );
}
