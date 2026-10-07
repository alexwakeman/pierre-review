import { useEffect, useState } from 'react';
import {
  TRACKER_PROVIDERS_AVAILABLE,
  TRACKER_PROVIDER_FIELDS,
  type IssueMatchScope,
  type TrackerProvider,
  type WorkspaceTrackerUpdate,
} from '@pierre-review/shared';
import { useUpdateWorkspaceTracker, useWorkspaceTracker } from '../../hooks/useWorkspaceTracker.js';
import { JiraApiAccess } from './JiraApiAccess.js';
import { LinearApiAccess } from './LinearApiAccess.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const PLACEHOLDER: Record<TrackerProvider, string> = {
  jira: 'https://your-org.atlassian.net',
  linear: 'https://linear.app/your-workspace',
  github: 'https://github.com/your-org/your-repo',
};
const LABEL: Record<TrackerProvider, string> = { jira: 'Jira', linear: 'Linear', github: 'GitHub Issues' };

/**
 * The issue tracker (provider + base URL) for the CURRENTLY-SELECTED workspace. When set, PR detail
 * shows deep links for any ticket key (e.g. PROJ-123) found in the PR title or head branch — and
 * flags when none is found. CORE and FREE on every tier and in both modes since apiVersion 23
 * (`GET`/`PUT /api/workspaces/:id/tracker`, docs/TRACKERS.md); the provider list is the shared
 * `TRACKER_PROVIDERS_AVAILABLE` — only providers an adapter implements are offered.
 *
 * ⚠ IT IS PER-WORKSPACE, not per-account. The enricher's input is a PR,
 * and a PR's repo belongs to exactly ONE workspace, so there was never a reason for one tracker to
 * govern every team's PRs. There is no account-level default beneath this: two states, no chain.
 *
 * ⚠ THE HINT MUST NOT SAY "in the title AND branch". It used to, and it read as "the key must
 * appear in BOTH" when it meant "in either place we look" — a hint that describes a stricter rule
 * than the code enforces teaches the reader to configure around a problem they do not have.
 *
 * ⚠ NOTHING HAS EVER SCANNED COMMIT MESSAGES, in any scope, so the scope control says so.
 * `extractTicketKeys` takes a title and a head-ref name and nothing else — and on the lean-storage
 * path commit messages are not even persisted.
 *
 * ⚠ THE WORKSPACE IS NAMED ONCE, IN THE MODAL'S "Workspace" HEADING, NOT IN THIS TITLE. The name
 * is still load-bearing (there is no picker in Settings), but three sections each appending
 * "— acme-web" to their heading was one fact three times. The BLAST RADIUS claim — this tracker
 * governs this workspace's repos and nobody else's — is a different claim and stays here, where
 * the Save button is.
 */
export function IssueLinksSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useWorkspaceTracker(workspaceId != null, workspaceId);
  const mutation = useUpdateWorkspaceTracker(workspaceId);
  const data = query.data;

  // Re-seeded on the resolved workspace / STORED VALUE: an uncontrolled seed would leave the
  // previous workspace's tracker in the inputs after a switch, and Save would write it here.
  //
  // ⚠ KEYED ON THE VALUES, NOT ON THE RESPONSE OBJECT — a `[data]` dependency re-seeds on every
  // background refetch (a window focus past the 60s staleTime), reverting a half-typed base URL.
  const [provider, setProvider] = useState<TrackerProvider | ''>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [projectKeys, setProjectKeys] = useState('');
  const [matchScope, setMatchScope] = useState<IssueMatchScope>('title_branch');
  const signature = data
    ? `${workspaceId ?? 'none'}:${data.issue.provider ?? 'none'}:${data.issue.baseUrl ?? 'none'}:${data.issue.projectKeys.join(',')}:${data.issue.matchScope}`
    : `${workspaceId ?? 'none'}:pending`;
  useEffect(() => {
    if (data == null) return;
    setProvider(data.issue.provider ?? '');
    setBaseUrl(data.issue.baseUrl ?? '');
    setProjectKeys(data.issue.projectKeys.join(', '));
    setMatchScope(data.issue.matchScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // ⚠ NOTHING RENDERS — AND NOTHING SAVES — AGAINST AN UNRESOLVED SCOPE. A PUT with no
  // `?workspace=` is answered by the account's DEFAULT workspace.
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Issue tracker" failed={query.isError} />;
  }

  const saved = data.issue;
  // Project keys as a comma-separated string in the input; parsed to a list on save. The saved
  // list is normalized (uppercase), so compare against its comma-joined form.
  const parsedKeys = projectKeys
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter((k) => k !== '');
  const hasKeys = parsedKeys.length > 0;

  // What this provider asks for. GitHub Issues asks for nothing: only a change of provider is a
  // change, and its Save sends ONLY the provider — the stored Jira URL and token are kept for a
  // switch back (a token is dropped only when the URL itself moves).
  const fields = provider === '' ? null : TRACKER_PROVIDER_FIELDS[provider];
  const dirty =
    (provider || null) !== saved.provider ||
    (fields?.baseUrl === true && baseUrl.trim() !== (saved.baseUrl ?? '')) ||
    (fields?.projectKeys === true && parsedKeys.join(',') !== saved.projectKeys.join(',')) ||
    (fields?.matchScope === true && matchScope !== saved.matchScope);
  const patch: WorkspaceTrackerUpdate['issue'] =
    provider === ''
      ? { provider: null }
      : {
          provider,
          ...(fields?.baseUrl ? { baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim() } : {}),
          ...(fields?.projectKeys ? { projectKeys: parsedKeys } : {}),
          ...(fields?.matchScope ? { matchScope } : {}),
        };

  return (
    <SectionShell
      title="Issue tracker"
      desc="Link each PR to its tickets, for this workspace’s repos only. Other workspaces are unaffected — each one points at its own tracker, or none."
    >
      <Field label="Provider">
        <select
          className={inputCls}
          value={provider}
          onChange={(e) => setProvider(e.target.value as TrackerProvider | '')}
        >
          <option value="">None</option>
          {TRACKER_PROVIDERS_AVAILABLE.map((p) => (
            <option key={p} value={p}>
              {LABEL[p]}
            </option>
          ))}
        </select>
      </Field>
      {provider === 'github' && (
        <p className="text-xs text-gray-600 dark:text-gray-300">
          A PR’s tickets are the issues it closes — “Fixes #12”, “Closes owner/repo#12”, or an issue
          linked in the PR’s Development panel. Limn reads them with your GitHub sign-in. Nothing to
          set up.
        </p>
      )}
      {fields?.baseUrl === true && (
        <>
          <Field
            label={provider === 'linear' ? 'Workspace URL' : 'Base URL'}
            hint={
              provider === 'jira'
                ? `Tickets link to {base}/browse/KEY-123.${data.jira.hasToken ? ' Moving to a different Jira site removes the saved API token.' : ''}`
                : `Your Linear workspace’s address. Tickets link to {base}/issue/KEY-123.${data.jira.hasToken ? ' Moving to a different Linear workspace removes the saved API key.' : ''}`
            }
          >
            <input
              type="url"
              className={inputCls}
              placeholder={PLACEHOLDER[provider as TrackerProvider]}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
          <Field
            label={provider === 'linear' ? 'Team keys' : 'Project keys'}
            hint={
              provider === 'linear'
                ? 'Optional, comma-separated (e.g. ENG, OPS). Issues Linear’s GitHub integration linked to a PR are always found. Beyond those, a key in the PR title or branch counts only if its team is on this list. Leave blank to look for uppercase keys in the PR title only.'
                : 'Optional, comma-separated (e.g. ENG, PROJ). When set, a ticket is only detected if its prefix is on this list — the most reliable way to avoid false matches like GPT-4 or node-18. Leave blank to fall back to detecting uppercase keys in the PR title.'
            }
          >
            <input
              type="text"
              className={inputCls}
              placeholder="ENG, PROJ"
              value={projectKeys}
              onChange={(e) => setProjectKeys(e.target.value)}
            />
          </Field>
          {/* ⚠ DISABLED WITHOUT KEYS, RATHER THAN PRESENT AND INERT. With no allowlist the branch
              is never scanned at all — a lowercase `eng-123` is structurally indistinguishable
              from `node-18` or `release-2` — so this control would be one that does nothing, and
              the reader would blame the setting when detection missed a ticket. */}
          <Field
            label="Where to look"
            hint={
              hasKeys
                ? 'Detection never reads commit messages — only the PR title and, in the second mode, the head branch name.'
                : 'Only has an effect when project keys are set above: without them the branch is never scanned, because a lowercase eng-123 is indistinguishable from node-18 or release-2. Detection never reads commit messages.'
            }
          >
            <select
              className={inputCls}
              value={matchScope}
              disabled={!hasKeys}
              onChange={(e) => setMatchScope(e.target.value as IssueMatchScope)}
            >
              <option value="title">PR title only</option>
              <option value="title_branch">PR title and branch name (default)</option>
            </select>
          </Field>
        </>
      )}
      <SaveButton
        dirty={dirty}
        saving={mutation.isPending}
        onClick={() => mutation.mutate({ issue: patch })}
      />
      {mutation.isError && (
        <p className="text-[11px] text-red-500">{(mutation.error as Error).message}</p>
      )}
      {/* Offered once Jira is the SAVED tracker with a base URL — the field list and the ticket
          reads call the saved site, so an unsaved URL in the box above would be the wrong one.
          ⚠ NO LONGER BEHIND `me.ai.enabled`: the token feeds the stored tickets every free surface
          reads (the Open PRs ticket row and stacks, the ticket modal), in both modes, not only
          Claude Review. */}
      {saved.provider === 'jira' &&
        provider === 'jira' &&
        (saved.baseUrl ?? '') !== '' && <JiraApiAccess workspaceId={workspaceId} jira={data.jira} />}
      {/* The same rule for Linear: the key belongs to the SAVED workspace URL. */}
      {saved.provider === 'linear' && provider === 'linear' && (saved.baseUrl ?? '') !== '' && (
        <LinearApiAccess workspaceId={workspaceId} jira={data.jira} baseUrl={saved.baseUrl ?? ''} />
      )}
    </SectionShell>
  );
}
