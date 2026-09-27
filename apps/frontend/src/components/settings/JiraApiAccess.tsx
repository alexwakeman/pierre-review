import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { JiraFieldListResponse, WorkspaceJiraApiSettings } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useUpdateWorkspaceProSettings } from '../../hooks/useWorkspaceProSettings.js';
import { acFieldName, acFieldOptions } from '../../lib/jiraTicket.js';
import { Field, SaveButton, inputCls } from './ui.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "Jira API access (optional)" for ONE workspace — mounted by IssueLinksSection only when that
 * workspace's SAVED tracker is Jira. It lets Claude Review fill a detected ticket's title,
 * description and acceptance criteria.
 *
 * ⚠ THE TOKEN IS WRITE-ONLY. The server never returns it (`hasToken` only), so the input starts
 * empty every time; a saved token shows "Saved" with Replace / Remove. Saving without typing a
 * token keeps the saved one.
 *
 * ⚠ THE FIELD LIST IS CLICK-GATED. Loading it calls the customer's Jira with the SAVED token, so it
 * is also the connection test — and it never fires just because Settings opened.
 */
export function JiraApiAccess({
  workspaceId,
  jira,
}: {
  workspaceId: number;
  jira: WorkspaceJiraApiSettings;
}): JSX.Element {
  const mutation = useUpdateWorkspaceProSettings(workspaceId);
  const fields = useMutation<JiraFieldListResponse, Error, void>({
    mutationFn: () => api.jiraFields(workspaceId),
  });
  const loaded = fields.data?.workspaceId === workspaceId ? fields.data.fields : null;
  const ids = { email: useId(), token: useId(), field: useId() };

  const savedFieldId = jira.acceptanceCriteriaField?.id ?? '';
  const [email, setEmail] = useState(jira.email ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [fieldId, setFieldId] = useState(savedFieldId);

  // Re-seeded on the STORED values (not the response object — a background refetch must not
  // revert a half-typed email). The token input is cleared after every save.
  const signature = `${workspaceId}:${jira.email ?? ''}:${jira.hasToken}:${savedFieldId}`;
  useEffect(() => {
    setEmail(jira.email ?? '');
    setToken('');
    setReplacing(false);
    setFieldId(savedFieldId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Once the list arrives with nothing chosen yet, pre-select the field named "acceptance criteria".
  const suggested = fields.data?.suggestedFieldId ?? null;
  useEffect(() => {
    if (suggested != null && fieldId === '' && savedFieldId === '') setFieldId(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);

  const typedToken = token.trim();
  const dirty =
    email.trim() !== (jira.email ?? '') || typedToken !== '' || fieldId !== savedFieldId;
  const showTokenInput = !jira.hasToken || replacing;
  const options = acFieldOptions(jira.acceptanceCriteriaField, loaded);

  const save = (): void =>
    mutation.mutate({
      jira: {
        email: email.trim() === '' ? null : email.trim(),
        ...(typedToken !== '' ? { token: typedToken } : {}),
        acceptanceCriteriaFieldId: fieldId === '' ? null : fieldId,
        acceptanceCriteriaFieldName: acFieldName(fieldId, jira.acceptanceCriteriaField, loaded),
      },
    });

  return (
    <div className="space-y-2.5 rounded border border-gray-200 p-2.5 dark:border-gray-800">
      <div>
        <h4 className="text-xs font-semibold text-gray-800 dark:text-gray-100">
          Jira API access (optional)
        </h4>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Lets Claude Review fill in a detected ticket’s title, description and acceptance
          criteria. A saved token is never shown again.
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
      <Field
        label="Acceptance criteria field"
        htmlFor={ids.field}
        hint="Jira has no standard field for acceptance criteria, so pick the one your site uses."
      >
        <select
          id={ids.field}
          className={inputCls}
          value={fieldId}
          onChange={(e) => setFieldId(e.target.value)}
        >
          <option value="">None — criteria are in the description</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BTN}
          disabled={!jira.hasToken || fields.isPending}
          onClick={() => fields.mutate()}
        >
          {fields.isPending ? 'Checking…' : 'Check connection and load fields'}
        </button>
        {!jira.hasToken && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            Save a token first.
          </span>
        )}
        {loaded != null && (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Connected. {loaded.length} custom {loaded.length === 1 ? 'field' : 'fields'} loaded.
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
