import { TEAM_POLICY_PATH, type RepoTeamPolicy } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useLicenceAction, useLicenceStatus } from '../../hooks/useLicence.js';
import { useSetTeamPolicyClash, useTeamPolicy } from '../../hooks/useTeamPolicy.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/index.js';
import { RadioInput, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// SETTINGS → TEAM POLICY (docs/TEAM-POLICY.md): the rules a team commits to each repository, as this
// copy read them, and whether this copy applies them. Read-only: the file lives in the repository, so
// changing a rule is a pull request, reviewed like any other change.
//
// ⚠ An organisation feature: applied only with a valid licence key or during the 30-day evaluation.
// Without one, the page SAYS the rules are not applied (never a silent no-op).

const EXAMPLE = `{
  "version": 1,
  "automation": {
    "auto_push": false,
    "dependencies": false
  },
  "ai": { "approve": false },
  "note": "Agreed by the platform team, March 2027."
}`;

const RULES: [string, string][] = [
  ['automation.auto_review', 'false: Ensemble never starts a review by itself.'],
  ['automation.auto_post', 'false: AI reviews are never posted automatically.'],
  ['automation.auto_fix', 'false: no automatic AI Fix.'],
  ['automation.auto_push', 'false: nothing is pushed without a press of Push.'],
  ['automation.auto_resolve', 'false: Ensemble never resolves threads by itself.'],
  ['automation.dependencies', 'false: no dependency automation.'],
  ['ai.approve', 'false: an AI review never approves; it comments instead.'],
  ['dependencies.trusted_bots', 'a list of logins: only these bots’ PRs get dependency automation.'],
  ['note', 'text shown here, for the reason behind the rules.'],
];

function Info(): JSX.Element {
  return (
    <InfoButton title="Team policy">
      <p>
        Commit a file named <code>{TEAM_POLICY_PATH}</code> to a repository’s default branch. Every copy of Ensemble that syncs the
        repository reads it and applies it to that repository’s pull requests.
      </p>
      <p className="mt-2">A policy only switches things off. A missing rule leaves each person’s own setting.</p>
      <pre className="mt-2 overflow-x-auto rounded-ui bg-ui-raise p-2 font-mono text-meta">{EXAMPLE}</pre>
      <ul className="mt-2 space-y-1">
        {RULES.map(([k, v]) => (
          <li key={k}>
            <code>{k}</code>: {v}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        Each pull request follows its own repository’s policy. Work that touches several repositories at once, such
        as Implement story’s push, needs one: when the repositories agree it is theirs; when they differ it is the
        one you choose under “When repositories’ rules differ”, which overrides the others there, or by default the
        strictest rule from each.
      </p>
      <p className="mt-2">
        A file with a mistake is not applied at all, and this page lists the problems. Team policies need a licence key or the 30-day
        evaluation on each copy of Ensemble.
      </p>
    </InfoButton>
  );
}

function RepoPolicy({ r }: { r: RepoTeamPolicy }): JSX.Element {
  return (
    <li className="rounded-ui p-2 ring-1 ring-inset ring-ui-line" data-testid="team-policy-repo">
      <p className="text-body font-semibold text-ui-ink">{r.repo}</p>
      {r.state === 'ok' ? (
        <>
          {r.rules.length === 0 ? (
            <p className="text-body text-ui-mute">No rules: everything is left to each person’s settings.</p>
          ) : (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-ui-ink">
              {r.rules.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {r.policy?.note != null && r.policy.note.trim() !== '' && <p className="mt-1 text-body text-ui-mute">{r.policy.note}</p>}
        </>
      ) : (
        <>
          <p className="text-body text-ui-danger">Not applied: the file has problems.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-ui-danger">
            {r.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
      {r.commitOid != null && <p className="mt-1 text-meta text-ui-mute">Read at commit {r.commitOid.slice(0, 7)}.</p>}
    </li>
  );
}

/**
 * WHEN REPOSITORIES' RULES DIFFER: the workspace (a team) picks the policy for work that spans
 * repositories — Implement story's push today. It overrides the repositories' own files in a clash; the
 * default is the strictest rule from each. Shown once two or more repositories have a valid policy.
 */
function ClashChoice({
  workspaceId,
  repos,
  clash,
}: {
  workspaceId: number;
  repos: RepoTeamPolicy[];
  clash: { repoId: number | null; repo: string | null; usable: boolean };
}): JSX.Element {
  const save = useSetTeamPolicyClash(workspaceId);
  const options: { repoId: number | null; label: string }[] = [
    { repoId: null, label: 'The strictest rule from each repository' },
    ...repos.map((r) => ({ repoId: r.repoId, label: `${r.repo}’s policy` })),
  ];
  return (
    <fieldset className="space-y-1.5" data-testid="team-policy-clash">
      <legend className="mb-1 text-body font-semibold text-ui-ink">When repositories’ rules differ</legend>
      <p className="text-meta text-ui-mute">For work that touches several repositories at once. This choice wins there.</p>
      {options.map((o) => (
        <label key={o.repoId ?? 'strictest'} className="flex items-center gap-2 text-body">
          <RadioInput
            name={`policy-clash-${workspaceId}`}
            checked={clash.repoId === o.repoId}
            disabled={save.isPending}
            onChange={() => save.mutate(o.repoId)}
          />
          {o.label}
        </label>
      ))}
      {!clash.usable && clash.repoId != null && (
        <p className="text-body text-ui-danger">
          {clash.repo ?? 'The chosen repository'} has no valid policy now, so the strictest rule applies.
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-body text-ui-danger">
          Ensemble could not save the choice. Try again.
        </p>
      )}
    </fieldset>
  );
}

export function TeamPolicySection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useTeamPolicy(workspaceId);
  const licence = useLicenceStatus();
  const evaluate = useLicenceAction((_: void) => api.startLicenceEvaluation());
  const openSettings = useSettingsModal((s) => s.openSettings);

  if (workspaceId == null || q.data == null) return <ScopePendingSection title="Team policy" failed={q.isError} />;
  const data = q.data;
  const withFile = data.repos.filter((r) => r.state !== 'none');
  const without = data.repos.length - withFile.length;
  const canEvaluate = licence.data?.reminder.canEvaluate === true;

  return (
    <SectionShell
      title="Team policy"
      desc="Rules your team commits to a repository. They apply to its pull requests on every copy of Ensemble, and only switch things off."
      info={<Info />}
    >
      {!data.applied && (
        <div className="rounded-ui p-2 ring-1 ring-inset ring-ui-line" data-testid="team-policy-not-applied">
          <p className="text-body text-ui-ink">This copy does not apply team policies: it needs a licence key.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => openSettings('licence')}>Enter a key</Button>
            {canEvaluate && (
              <Button disabled={evaluate.isPending} onClick={() => evaluate.mutate(undefined)}>
                Start the 30-day evaluation
              </Button>
            )}
          </div>
        </div>
      )}
      {withFile.length === 0 ? (
        <p className="text-body text-ui-mute">No repository in this workspace has a policy file.</p>
      ) : (
        <ul className="space-y-2">
          {withFile.map((r) => (
            <RepoPolicy key={r.repoId} r={r} />
          ))}
        </ul>
      )}
      {withFile.filter((r) => r.state === 'ok').length >= 2 && (
        <ClashChoice workspaceId={workspaceId} repos={withFile.filter((r) => r.state === 'ok')} clash={data.clash} />
      )}
      {withFile.length > 0 && without > 0 && (
        <p className="text-meta text-ui-mute">
          {without === 1 ? '1 other repository has' : `${without} other repositories have`} no policy file.
        </p>
      )}
    </SectionShell>
  );
}

/**
 * One line under a workspace switch that a team policy may override: which repositories' policies
 * switch something off, while this copy applies them. Nothing when no policy applies.
 */
export function TeamPolicyNote({ workspaceId }: { workspaceId: number }): JSX.Element | null {
  const q = useTeamPolicy(workspaceId);
  const data = q.data;
  if (data == null || !data.applied) return null;
  const repos = data.repos.filter((r) => r.state === 'ok' && r.rules.length > 0).map((r) => r.repo);
  if (repos.length === 0) return null;
  const openSettings = useSettingsModal.getState().openSettings;
  const named = repos.length <= 2 ? repos.join(' and ') : `${repos.slice(0, 2).join(', ')} and ${repos.length - 2} more`;
  return (
    <p className="text-meta text-ui-mute" data-testid="team-policy-note">
      The team policy in {named} switches some of these off for its pull requests.{' '}
      <button type="button" className="hit text-ui-ink underline" onClick={() => openSettings('team-policy')}>
        See Team policy
      </button>
      .
    </p>
  );
}
