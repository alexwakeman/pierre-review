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
import { JiraAcFieldSettings } from './JiraAcFieldSettings.js';
import { LinearApiAccess } from './LinearApiAccess.js';
import { NotionTrackerSetup } from './NotionTrackerSetup.js';
import { TrackerCopyFrom } from './TrackerCopyFrom.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { Select, type SelectOption } from '../ui/index.js';

const MATCH_SCOPE_OPTIONS: readonly SelectOption<IssueMatchScope>[] = [
  { value: 'title', label: 'PR title only' },
  { value: 'title_branch', label: 'PR title and branch name (default)' },
];

const PLACEHOLDER: Record<TrackerProvider, string> = {
  jira: 'https://your-org.atlassian.net',
  linear: 'https://linear.app/your-workspace',
  github: 'https://github.com/your-org/your-repo',
  notion: 'https://www.notion.so/your-team/Tasks-1a2b3c…',
};
const LABEL: Record<TrackerProvider, string> = { jira: 'Jira', linear: 'Linear', github: 'GitHub Issues', notion: 'Notion' };

/**
 * The issue tracker (provider + base URL) for the CURRENTLY-SELECTED workspace. When set, PR detail
 * shows deep links for any ticket key (e.g. PROJ-123) found in the PR title or head branch — and
 * flags when none is found. CORE and FREE on every tier and in both modes since apiVersion 23
 * (`GET`/`PUT /api/workspaces/:id/tracker`, docs/TRACKERS.md); the provider list is the shared
 * `TRACKER_PROVIDERS_AVAILABLE` — only providers an adapter implements are offered.
 *
 * ⚠ IT IS PER-WORKSPACE, not per-account. The enricher's input is a PR,
 * and a PR's repo belongs to exactly ONE workspace, so there was never a reason for one tracker to
 * govern every team's PRs. There is no account-level default beneath this. With NO choice saved
 * the server's automatic default applies (GitHub Issues when one of this workspace's repos uses it,
 * else none) and arrives as `issue.provider` with `providerChosen: false`; a saved None wins.
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
 * governs this workspace's repos and nobody else's — is a different claim and stays here, beside
 * the fields that write.
 *
 * NO SAVE BUTTON (./autosave.tsx). The provider and "Where to look" save when picked; project keys
 * save as you type (debounced, at once on blur / Enter). Only what changed is sent — a provider
 * change sends the provider alone. ⚠ THE BASE URL SAVES ONLY ON BLUR / ENTER, never per keystroke:
 * moving it to another site removes the saved token, so a half-typed address must never be written.
 */
/** The heading the modal lands on for `openSettings('issue-tracker')` (This Sprint's setup button). */
export const ISSUE_TRACKER_SECTION_HEADING_ID = 'settings-issue-tracker-heading';

export function IssueLinksSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useWorkspaceTracker(workspaceId != null, workspaceId);
  const mutation = useUpdateWorkspaceTracker(workspaceId);
  const data = query.data;

  // Re-seeded on the resolved workspace / STORED VALUE: an uncontrolled seed would leave the
  // previous workspace's tracker in the inputs after a switch, and an autosave would write it here.
  //
  // ⚠ KEYED ON THE VALUES, NOT ON THE RESPONSE OBJECT — a `[data]` dependency re-seeds on every
  // background refetch (a window focus past the 60s staleTime), reverting a half-typed base URL.
  const [provider, setProvider] = useState<TrackerProvider | ''>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [projectKeys, setProjectKeys] = useState('');
  const [matchScope, setMatchScope] = useState<IssueMatchScope>('title_branch');
  // The base URL as typed has been committed (blur / Enter) — only then may it be written.
  const [urlCommitted, setUrlCommitted] = useState(false);
  // Each field re-seeds on its OWN stored value, so one write landing never wipes a half-typed other.
  const ws = workspaceId ?? 'none';
  const storedProvider = data?.issue.provider;
  const storedBaseUrl = data?.issue.baseUrl;
  const storedKeys = data?.issue.projectKeys.join(',');
  const storedScope = data?.issue.matchScope;
  useEffect(() => {
    if (storedProvider !== undefined) setProvider(storedProvider ?? '');
  }, [ws, storedProvider]);
  useEffect(() => {
    if (storedBaseUrl === undefined) return;
    setBaseUrl(storedBaseUrl ?? '');
    setUrlCommitted(false);
  }, [ws, storedBaseUrl]);
  useEffect(() => {
    if (storedKeys !== undefined) setProjectKeys(storedKeys.split(',').filter((k) => k !== '').join(', '));
  }, [ws, storedKeys]);
  useEffect(() => {
    if (storedScope !== undefined) setMatchScope(storedScope);
  }, [ws, storedScope]);

  // Project keys as a comma-separated string in the input; parsed to a list on save. The saved
  // list is normalized (uppercase), so compare against its comma-joined form.
  const parsedKeys = projectKeys
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter((k) => k !== '');

  // ONLY WHAT CHANGED is sent. GitHub Issues asks for nothing: a provider change sends ONLY the
  // provider — the stored Jira URL and token are kept for a switch back (a token is dropped only
  // when the URL itself moves).
  const saved = data?.issue;
  const fields = provider === '' ? null : TRACKER_PROVIDER_FIELDS[provider];
  const providerChanged = saved != null && (provider || null) !== saved.provider;
  const urlChanged = saved != null && fields?.baseUrl === true && baseUrl.trim() !== (saved.baseUrl ?? '');
  const keysChanged = saved != null && fields?.projectKeys === true && parsedKeys.join(',') !== saved.projectKeys.join(',');
  const scopeChanged = saved != null && fields?.matchScope === true && matchScope !== saved.matchScope;
  const urlInvalid = urlChanged && baseUrl.trim() !== '' && !/^https?:\/\/[^\s/]+/i.test(baseUrl.trim());
  const patch: NonNullable<WorkspaceTrackerUpdate['issue']> = {
    ...(providerChanged ? { provider: provider === '' ? null : provider } : {}),
    ...(urlChanged && urlCommitted && !urlInvalid ? { baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim() } : {}),
    ...(keysChanged ? { projectKeys: parsedKeys } : {}),
    ...(scopeChanged ? { matchScope } : {}),
  };
  const dirty = providerChanged || urlChanged || keysChanged || scopeChanged;
  const autosave = useAutoSave({
    key: `${ws}:${JSON.stringify(patch)}`,
    ready: workspaceId != null && Object.keys(patch).length > 0,
    busy: mutation.isPending,
    run: () => mutation.mutate({ issue: patch }),
  });
  const commitUrl = (): void => {
    autosave.now();
    setUrlCommitted(true);
  };

  // ⚠ NOTHING RENDERS — AND NOTHING SAVES — AGAINST AN UNRESOLVED SCOPE. A PUT with no
  // `?workspace=` is answered by the account's DEFAULT workspace.
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Issue tracker" failed={query.isError} />;
  }

  const issue = data.issue;
  // The workspace's repos that use GitHub Issues, and whether the provider was picked for it.
  const detected = data.githubIssuesRepos;
  const autoPicked = !data.providerChosen && issue.provider === 'github';
  const autoReason =
    detected.length === 1
      ? `Picked automatically: ${detected[0]} uses GitHub Issues.`
      : `Picked automatically: ${detected[0]} and ${detected.length - 1} more ${detected.length === 2 ? 'repo use' : 'repos use'} GitHub Issues.`;
  const hasKeys = parsedKeys.length > 0;

  return (
    <SectionShell
      title="Issue tracker"
      headingId={ISSUE_TRACKER_SECTION_HEADING_ID}
      desc="Links each PR to its tickets. This workspace only: each workspace has its own tracker, or none."
      info={
        <InfoButton title="Issue tracker">
          <p>
            <strong>GitHub Issues:</strong> a PR’s tickets are the issues it closes (“Fixes #12”,
            “Closes owner/repo#12”) or an issue linked in the PR’s Development panel. Ensemble reads
            them with your GitHub sign-in.
          </p>
          <p>
            <strong>Jira:</strong> a ticket key such as ENG-123 is found in the PR title, and in
            the branch name if you choose to look there. Project keys stop false matches like
            GPT-4 or node-18. Without them the branch is never read, because a lowercase eng-123
            looks the same as node-18 or release-2.
          </p>
          <p>
            <strong>Linear:</strong> issues that Linear’s GitHub integration attached to the PR are
            always found. Beyond those, a key in the PR title or branch counts only if its team is
            on your list.
          </p>
          <p>
            <strong>Notion:</strong> tickets are the pages of one database, found by their Unique ID (such as
            ENG-123) in the PR title or branch.
          </p>
          <p>Commit messages are never read.</p>
        </InfoButton>
      }
    >
      {/* Offered only when another workspace has a tracker set up (renders nothing otherwise). */}
      <TrackerCopyFrom
        workspaceId={workspaceId}
        hasTracker={issue.provider != null && (!TRACKER_PROVIDER_FIELDS[issue.provider].baseUrl || (issue.baseUrl ?? '') !== '')}
      />
      <Field group label="Provider">
        <Select
          label="Provider"
          className="w-full sm:w-auto"
          value={provider}
          onChange={(v) => {
            autosave.now();
            setProvider(v);
          }}
          options={[
            { value: '' as TrackerProvider | '', label: 'None' },
            ...TRACKER_PROVIDERS_AVAILABLE.map((p) => ({
              value: p as TrackerProvider | '',
              label: p === 'github' && detected.length > 0 ? `${LABEL[p]} (detected)` : LABEL[p],
            })),
          ]}
        />
      </Field>
      {provider === 'github' && (
        <p className="text-meta text-ui-mute">
          Uses the issues each PR closes or links. Nothing to set up.
        </p>
      )}
      {/* ⚠ THE AUTOMATIC DEFAULT NAMES ITS REASON. With no choice saved the server picks GitHub
          Issues when a repo here uses it (docs/TRACKERS.md § Automatic default); choosing None and
          stores None, which then wins. */}
      {autoPicked && provider === 'github' && (
        <p className="text-meta text-ui-mute">{autoReason}</p>
      )}
      {fields?.baseUrl === true && (
        <>
          <Field
            label={provider === 'linear' ? 'Workspace URL' : provider === 'notion' ? 'Database URL' : 'Base URL'}
            hint={
              provider === 'jira'
                ? `Tickets link to {base}/browse/KEY-123. Saved when you press Enter or leave the field.${data.jira.hasToken ? ' Moving to a different Jira site removes the saved API token.' : ''}`
                : provider === 'notion'
                  ? 'Copy the link of the database that holds your tickets. Saved when you press Enter or leave the field. Moving to another database clears its mapping.'
                  : `Your Linear workspace’s address. Tickets link to {base}/issue/KEY-123. Saved when you press Enter or leave the field.${data.jira.hasToken ? ' Moving to a different Linear workspace removes the saved API key.' : ''}`
            }
          >
            <input
              type="url"
              className={inputCls}
              placeholder={PLACEHOLDER[provider as TrackerProvider]}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setUrlCommitted(false);
              }}
              onBlur={commitUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitUrl();
              }}
            />
          </Field>
          {fields.projectKeys && (
          <Field
            label={provider === 'linear' ? 'Team keys' : 'Project keys'}
            hint={
              provider === 'linear'
                ? 'Optional, comma-separated (e.g. ENG, OPS). Leave blank to look for keys in the PR title only.'
                : 'Optional, comma-separated (e.g. ENG, PROJ). Only keys with these prefixes count. Leave blank to look for keys in the PR title only.'
            }
          >
            <input
              type="text"
              className={inputCls}
              placeholder="ENG, PROJ"
              value={projectKeys}
              onChange={(e) => setProjectKeys(e.target.value)}
              onBlur={autosave.flush}
              onKeyDown={(e) => {
                if (e.key === 'Enter') autosave.flush();
              }}
            />
          </Field>
          )}
          {/* ⚠ DISABLED WITHOUT KEYS, RATHER THAN PRESENT AND INERT. With no allowlist the branch
              is never scanned at all — a lowercase `eng-123` is structurally indistinguishable
              from `node-18` or `release-2` — so this control would be one that does nothing, and
              the reader would blame the setting when detection missed a ticket. */}
          <Field
            group
            label="Where to look"
            hint={
              hasKeys || provider === 'notion'
                ? undefined
                : `Set ${provider === 'linear' ? 'team' : 'project'} keys above first. Without them only the PR title is searched for keys.`
            }
          >
            <Select
              label="Where to look"
              className="w-full sm:w-auto"
              value={matchScope}
              disabled={!hasKeys && provider !== 'notion'}
              onChange={(v) => {
                autosave.now();
                setMatchScope(v);
              }}
              options={MATCH_SCOPE_OPTIONS}
            />
          </Field>
        </>
      )}
      <SaveState
        section="Issue tracker"
        mutation={mutation}
        dirty={dirty}
        invalid={urlInvalid && urlCommitted ? 'enter the full address, starting with https://' : null}
      />
      {/* Offered once Jira is the SAVED tracker with a base URL — the field list and the ticket
          reads call the saved site, so an unsaved URL in the box above would be the wrong one.
          ⚠ NO LONGER BEHIND `me.ai.enabled`: the token feeds the stored tickets every free surface
          reads (the Open PRs ticket row and stacks, the ticket modal), in both modes, not only
          Claude Review. */}
      {issue.provider === 'jira' &&
        provider === 'jira' &&
        (issue.baseUrl ?? '') !== '' && <JiraApiAccess workspaceId={workspaceId} jira={data.jira} />}
      {/* The criteria field per issue type, once a token lets Limn read tickets. */}
      {issue.provider === 'jira' && provider === 'jira' && data.jira.hasToken && (
        <JiraAcFieldSettings workspaceId={workspaceId} />
      )}
      {/* The same rule for Linear: the key belongs to the SAVED workspace URL. */}
      {issue.provider === 'linear' && provider === 'linear' && (issue.baseUrl ?? '') !== '' && (
        <LinearApiAccess workspaceId={workspaceId} jira={data.jira} baseUrl={issue.baseUrl ?? ''} />
      )}
      {/* Notion: the token and the property mapping belong to the SAVED database URL. */}
      {issue.provider === 'notion' && provider === 'notion' && (issue.baseUrl ?? '') !== '' && (
        <NotionTrackerSetup workspaceId={workspaceId} jira={data.jira} saved={data.notion ?? null} />
      )}
    </SectionShell>
  );
}
