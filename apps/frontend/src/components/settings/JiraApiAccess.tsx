import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { JiraFieldListResponse, WorkspaceJiraApiSettings } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useUpdateWorkspaceTracker } from '../../hooks/useWorkspaceTracker.js';
import { Field, SaveButton, inputCls } from './ui.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "Jira API access (optional)" for ONE workspace — mounted by IssueLinksSection only when that
 * workspace's SAVED tracker is Jira. It lets Limn read each detected ticket when its PR arrives —
 * title, status and assignee on the Open PRs cards, and the story (description + acceptance
 * criteria) the ticket review and Claude Review read. CORE and free, in both modes.
 *
 * ⚠ THERE IS NO ACCEPTANCE-CRITERIA FIELD PICKER HERE ANY MORE. A site can carry several fields
 * named "Acceptance Criteria" and the one in use varies by issue type, so the field is chosen per
 * ticket in the Claude Review panel, from that ticket's own fields.
 *
 * ⚠ THE TOKEN IS WRITE-ONLY. The server never returns it (`hasToken` only), so the input starts
 * empty every time; a saved token shows "Saved" with Replace / Remove. Saving without typing a
 * token keeps the saved one.
 *
 * ⚠ THE CONNECTION CHECK IS CLICK-GATED. It calls the customer's Jira with the SAVED token (the
 * field-list route) and never fires just because Settings opened.
 */
export function JiraApiAccess({
  workspaceId,
  jira,
}: {
  workspaceId: number;
  jira: WorkspaceJiraApiSettings;
}): JSX.Element {
  const mutation = useUpdateWorkspaceTracker(workspaceId);
  const fields = useMutation<JiraFieldListResponse, Error, void>({
    mutationFn: () => api.jiraFields(workspaceId),
  });
  const loaded = fields.data?.workspaceId === workspaceId ? fields.data.fields : null;
  const ids = { email: useId(), token: useId() };

  const [email, setEmail] = useState(jira.email ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);

  // Re-seeded on the STORED values (not the response object — a background refetch must not
  // revert a half-typed email). The token input is cleared after every save.
  const signature = `${workspaceId}:${jira.email ?? ''}:${jira.hasToken}`;
  useEffect(() => {
    setEmail(jira.email ?? '');
    setToken('');
    setReplacing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const typedToken = token.trim();
  const dirty = email.trim() !== (jira.email ?? '') || typedToken !== '';
  const showTokenInput = !jira.hasToken || replacing;

  const save = (): void =>
    mutation.mutate({
      jira: {
        email: email.trim() === '' ? null : email.trim(),
        ...(typedToken !== '' ? { token: typedToken } : {}),
      },
    });

  return (
    <div className="space-y-2.5 rounded border border-gray-200 p-2.5 dark:border-gray-800">
      <div>
        <h4 className="text-xs font-semibold text-gray-800 dark:text-gray-100">
          Jira API access (optional)
        </h4>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Lets Limn read each ticket a PR names: its title, status and assignee, its description
          and acceptance criteria. A saved token is never shown again.
        </p>
      </div>
      <Field
        label="Email"
        htmlFor={ids.email}
        hint="Needed for Jira Cloud. Leave blank for a Data Center personal access token."
      >
        <input
          id={ids.email}
          type="email"
          autoComplete="off"
          className={inputCls}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      {showTokenInput ? (
        <Field
          label="API token"
          htmlFor={ids.token}
          hint={
            jira.hasToken
              ? 'The new token replaces the saved one when you save.'
              : 'A Jira Cloud API token, or a Data Center personal access token.'
          }
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
          <span className="font-medium text-gray-600 dark:text-gray-300">API token</span>
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
          disabled={!jira.hasToken || fields.isPending}
          onClick={() => fields.mutate()}
        >
          {fields.isPending ? 'Checking…' : 'Check connection'}
        </button>
        {!jira.hasToken && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            Save a token first.
          </span>
        )}
        {loaded != null && (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Connected. Jira accepted the saved token.
          </span>
        )}
      </div>
      {fields.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">{fields.error.message}</p>
      )}
      <SaveButton dirty={dirty} saving={mutation.isPending} onClick={save} />
      {mutation.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">{mutation.error.message}</p>
      )}
    </div>
  );
}
