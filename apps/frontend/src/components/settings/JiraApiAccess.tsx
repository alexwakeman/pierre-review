import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { JiraFieldListResponse, WorkspaceJiraApiSettings } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useUpdateWorkspaceTracker } from '../../hooks/useWorkspaceTracker.js';
import { Field, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * "Jira API access (optional)" for ONE workspace — mounted by IssueLinksSection only when that
 * workspace's SAVED tracker is Jira. It lets Limn read each detected ticket when its PR arrives —
 * title, status and assignee on the Open PRs cards, and the story (description + acceptance
 * criteria) the ticket review and Claude Review read. CORE and free, in both modes.
 *
 * The acceptance-criteria field is chosen PER ISSUE TYPE in its own block just below this one
 * (JiraAcFieldSettings.tsx): a site can carry several fields named "Acceptance Criteria" and the one
 * in use varies by issue type.
 *
 * ⚠ THE TOKEN IS WRITE-ONLY. The server never returns it (`hasToken` only), so the input starts
 * empty every time; a saved token shows "Saved" with Replace / Remove. There is no Save button
 * (./autosave.tsx): the email saves as you type (debounced, at once on blur / Enter); the token is
 * written ONLY on blur or Enter of a non-empty value, never per keystroke, and the field clears.
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
  // Two writes, two states: the email autosaves; the token is committed on blur / Enter.
  const emailSave = useUpdateWorkspaceTracker(workspaceId);
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
  // revert a half-typed email). The token input is cleared after every token write.
  // The email and the token re-seed apart, so a token commit never wipes a half-typed email.
  useEffect(() => setEmail(jira.email ?? ''), [workspaceId, jira.email]);
  useEffect(() => {
    setToken('');
    setReplacing(false);
  }, [workspaceId, jira.hasToken]);

  const typedToken = token.trim();
  const emailDirty = email.trim() !== (jira.email ?? '');
  const showTokenInput = !jira.hasToken || replacing;

  const autosave = useAutoSave({
    key: `${workspaceId}:${email.trim()}`,
    ready: emailDirty,
    busy: emailSave.isPending,
    run: () => emailSave.mutate({ jira: { email: email.trim() === '' ? null : email.trim() } }),
  });

  // The token: an explicit commit of a NON-EMPTY value only. The re-seed above clears the field.
  // A committed secret leaves the field at once and is never echoed (Replace closes too).
  const clearToken = (): void => {
    setToken('');
    setReplacing(false);
  };
  const commitToken = (): void => {
    if (typedToken === '' || mutation.isPending) return;
    mutation.mutate({ jira: { token: typedToken } }, { onSuccess: clearToken });
  };

  return (
    <div className="space-y-2.5 rounded-ui bg-ui-surface p-3.5">
      <div>
        <h4 className="text-body font-semibold text-ui-ink">
          Jira API access (optional)
        </h4>
        <p className="mt-0.5 text-meta text-ui-mute">
          Lets Ensemble read each ticket a PR names: its title, status and assignee, its description
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
          onBlur={autosave.flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') autosave.flush();
          }}
        />
      </Field>
      <SaveState section="Jira email" mutation={emailSave} dirty={emailDirty} />
      {showTokenInput ? (
        <Field
          label="API token"
          htmlFor={ids.token}
          hint={
            jira.hasToken
              ? 'Saved when you press Enter or leave the field. It replaces the saved one.'
              : 'A Jira Cloud API token, or a Data Center personal access token. Saved when you press Enter or leave the field.'
          }
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
          <span className="font-medium text-ui-mute">API token</span>
          <div className="flex items-center gap-2">
            <span className="text-ui-ink">Saved</span>
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
          <span className="text-meta text-ui-mute">
            Add a token first.
          </span>
        )}
        {loaded != null && (
          <span className="text-meta text-ui-success">
            Connected. Jira accepted the saved token.
          </span>
        )}
      </div>
      {fields.isError && (
        <p className="text-body text-ui-danger">{fields.error.message}</p>
      )}
      <SaveState section="Jira API token" mutation={mutation} dirty={false} />
    </div>
  );
}
