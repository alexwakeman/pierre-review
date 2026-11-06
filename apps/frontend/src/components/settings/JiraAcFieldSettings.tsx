import { useId } from 'react';
import type { JiraAcFieldTypeRow } from '@pierre-review/shared';
import { useJiraAcFieldSettings, useSetJiraAcFieldSetting } from '../../hooks/useJiraAcFieldSettings.js';
import { InfoButton } from '../InfoModal.js';
import { inputCls } from './ui.js';

/**
 * "Acceptance criteria field" for ONE workspace whose saved tracker is Jira (mounted by
 * IssueLinksSection under Jira API access). One row per issue type Limn has stored tickets for: the
 * field the criteria come from, and a menu of the text fields those tickets carry. "Limn picks"
 * (null) = the field whose name best matches "Acceptance Criteria". It replaced the per-ticket
 * picker that sat inside the story view's "As written in Jira". DB only: opening Settings makes no
 * Jira call.
 */
export function JiraAcFieldSettings({ workspaceId }: { workspaceId: number }): JSX.Element | null {
  const { data, isLoading, isError } = useJiraAcFieldSettings(workspaceId, true);
  const setField = useSetJiraAcFieldSetting(workspaceId);
  const types = data?.workspaceId === workspaceId ? data.types : null;
  return (
    <div className="space-y-2.5 rounded-ui bg-ui-surface p-3.5" data-testid="jira-ac-field-settings">
      <div className="flex items-center gap-1.5">
        <h4 className="text-body font-semibold text-ui-ink">Acceptance criteria field</h4>
        <InfoButton title="Acceptance criteria field">
          <p>
            Jira sites often have several fields called &ldquo;Acceptance Criteria&rdquo;, and each issue type
            can use a different one. Choose the field for each issue type here.
          </p>
          <p className="mt-2">
            &ldquo;Limn picks&rdquo; uses the field whose name best matches &ldquo;Acceptance Criteria&rdquo;.
            A change applies at once to every stored ticket of that type in this workspace.
          </p>
        </InfoButton>
      </div>
      {isLoading && <p className="text-meta text-ui-mute">Loading…</p>}
      {isError && <p className="text-meta text-ui-danger">Could not load the issue types.</p>}
      {types != null && types.length === 0 && (
        <p className="text-meta text-ui-mute">No Jira tickets read yet. Issue types show here once Limn has read a ticket.</p>
      )}
      {types != null && types.length > 0 && (
        <ul className="divide-y divide-ui-line">
          {types.map((t) => (
            <TypeRow
              key={`${t.apiRoot}|${t.issueTypeId}`}
              row={t}
              disabled={setField.isPending}
              onChoose={(fieldId) => setField.mutate({ apiRoot: t.apiRoot, issueTypeId: t.issueTypeId, fieldId })}
            />
          ))}
        </ul>
      )}
      {setField.isError && <p className="text-meta text-ui-danger">{setField.error.message || 'Could not save the field.'}</p>}
    </div>
  );
}

function TypeRow({
  row,
  disabled,
  onChoose,
}: {
  row: JiraAcFieldTypeRow;
  disabled: boolean;
  onChoose: (fieldId: string | null) => void;
}): JSX.Element {
  const id = useId();
  const value = row.chosen?.id ?? '';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <label htmlFor={id} className="min-w-[8rem] flex-1 text-body text-ui-ink">
        {row.issueTypeName}
        <span className="ml-1.5 text-meta text-ui-mute">
          {row.ticketCount === 1 ? '1 ticket' : `${row.ticketCount} tickets`}
        </span>
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChoose(e.target.value === '' ? null : e.target.value)}
        className={`${inputCls} w-auto max-w-[18rem]`}
      >
        <option value="">Limn picks{row.chosen == null && row.inUse != null ? ` (${row.inUse.name})` : ''}</option>
        {row.fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · {f.id.replace(/^customfield_/, '')}
          </option>
        ))}
      </select>
    </li>
  );
}
