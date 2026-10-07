import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { LinearConnectionCheck, WorkspaceJiraApiSettings } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useUpdateWorkspaceTracker } from '../../hooks/useWorkspaceTracker.js';
import { Field, SaveButton, inputCls } from './ui.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "Linear API key" for ONE workspace — mounted by IssueLinksSection only when that workspace's SAVED
 * tracker is Linear with a workspace URL. It lets Limn read the Linear issues each PR is attached to
 * when the PR arrives: title, status and assignee on the Open PRs cards, and the story (description
 * + acceptance criteria) the ticket review and Claude Review read. CORE and free, in both modes.
 *
 * ⚠ THE KEY IS WRITE-ONLY. The server never returns it (`jira.hasToken` — the block is the
 * workspace's one tracker credential, named for its first provider), so the input starts empty
 * every time; a saved key shows "Saved" with Replace / Remove.
 *
 * ⚠ THE CONNECTION CHECK IS CLICK-GATED (one Linear call with the SAVED key) and says which Linear
 * workspace the key belongs to — a key for another workspace than the URL above is refused on every
 * read, so the check says so in words.
 */
export function LinearApiAccess({
  workspaceId,
  jira,
  baseUrl,
}: {
  workspaceId: number;
  jira: WorkspaceJiraApiSettings;
  baseUrl: string;
}): JSX.Element {
  const mutation = useUpdateWorkspaceTracker(workspaceId);
  const check = useMutation<LinearConnectionCheck, Error, void>({
    mutationFn: () => api.linearCheck(workspaceId),
  });
  const checked = check.data?.workspaceId === workspaceId ? check.data : null;
  const keyId = useId();

  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const signature = `${workspaceId}:${jira.hasToken}:${baseUrl}`;
  useEffect(() => {
    setToken('');
    setReplacing(false);
    check.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const typed = token.trim();
  const showInput = !jira.hasToken || replacing;

  return (
    <div className="space-y-2.5 rounded border border-gray-200 p-2.5 dark:border-gray-800">
      <div>
        <h4 className="text-xs font-semibold text-gray-800 dark:text-gray-100">Linear API key</h4>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Lets Limn read the Linear issues each PR is linked to: title, status, assignee, description
          and acceptance criteria. A saved key is never shown again.
        </p>
      </div>
      {showInput ? (
        <Field
          label="Personal API key"
          htmlFor={keyId}
          hint={
            jira.hasToken
              ? 'The new key replaces the saved one when you save.'
              : 'Create one in Linear under Settings → Security & access. It starts with lin_api_. Read access is enough.'
          }
        >
          <input
            id={keyId}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            placeholder="lin_api_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-300">Personal API key</span>
          <div className="flex items-center gap-2">
            <span className="text-gray-700 dark:text-gray-200">Saved</span>
            <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              type="button"
              className={SECONDARY_BTN}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ jira: { clearToken: true } })}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BTN}
          disabled={!jira.hasToken || check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check connection'}
        </button>
        {!jira.hasToken && <span className="text-[11px] text-gray-500 dark:text-gray-400">Save a key first.</span>}
        {checked != null && checked.matchesBaseUrl && (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Connected as {checked.viewerName} to {checked.organizationName}.
          </span>
        )}
      </div>
      {checked != null && !checked.matchesBaseUrl && (
        <p className="text-xs text-red-600 dark:text-red-400">
          This key belongs to {checked.organizationName} ({checked.organizationUrl}), not {baseUrl}. Change the
          workspace URL above, or save a key from that workspace.
        </p>
      )}
      {check.isError && <p className="text-xs text-red-600 dark:text-red-400">{check.error.message}</p>}
      <SaveButton
        dirty={typed !== ''}
        saving={mutation.isPending}
        onClick={() => mutation.mutate({ jira: { token: typed } })}
      />
      {mutation.isError && <p className="text-xs text-red-600 dark:text-red-400">{mutation.error.message}</p>}
    </div>
  );
}
