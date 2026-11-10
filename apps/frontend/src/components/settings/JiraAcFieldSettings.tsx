import { useId } from 'react';
import type { JiraAcFieldTypeRow, OpenPointsFieldMode } from '@pierre-review/shared';
import { useJiraAcFieldSettings, useSetJiraAcFieldSetting, useSetJiraOpenPointsField } from '../../hooks/useJiraAcFieldSettings.js';
import { InfoButton } from '../InfoModal.js';
import { inputCls } from './ui.js';

/**
 * "Ticket fields" for ONE workspace whose saved tracker is Jira (mounted by
 * IssueLinksSection under Jira API access). One row per issue type Limn has stored tickets for: the
 * field the criteria come from, and a menu of the text fields those tickets carry. "Limn picks"
 * (null) = the field whose name best matches "Acceptance Criteria". It replaced the per-ticket
 * picker that sat inside the story view's "As written in Jira". DB only: opening Settings makes no
 * Jira call.
 *
 * Each row also chooses where the type's OPEN POINTS come from (docs/TRACKERS.md § Open points):
 * "Limn picks" ('auto': a field named like "Open points", else the description's section), a field,
 * or "Description only" ('none').
 */
export function JiraAcFieldSettings({ workspaceId }: { workspaceId: number }): JSX.Element | null {
  const { data, isLoading, isError } = useJiraAcFieldSettings(workspaceId, true);
  const setField = useSetJiraAcFieldSetting(workspaceId);
  const setOpenPoints = useSetJiraOpenPointsField(workspaceId);
  const types = data?.workspaceId === workspaceId ? data.types : null;
  const hasOpenPoints = types?.some((t) => t.openPoints != null) ?? false;
  return (
    <div className="space-y-2.5 rounded-ui bg-ui-surface p-3.5" data-testid="jira-ac-field-settings">
      <div className="flex items-center gap-1.5">
        <h4 className="text-body font-semibold text-ui-ink">Ticket fields</h4>
        <InfoButton title="Ticket fields">
          <p>
            Jira sites often have several fields called &ldquo;Acceptance Criteria&rdquo;, and each issue type
            can use a different one. Choose the field for each issue type here.
          </p>
          <p className="mt-2">
            &ldquo;Limn picks&rdquo; uses the field whose name best matches &ldquo;Acceptance Criteria&rdquo;.
            A change applies at once to every stored ticket of that type in this workspace.
          </p>
          <p className="mt-2">
            <strong>Open points</strong> are what the ticket left undecided: a decision, content or a design still
            to be confirmed. A review lists them with the code that depends on them, and they never block it.
            &ldquo;Limn picks&rdquo; uses a field named like &ldquo;Open points&rdquo;, else an &ldquo;Open
            points&rdquo; section of the description. &ldquo;Description only&rdquo; reads just that section.
          </p>
        </InfoButton>
      </div>
      {isLoading && <p className="text-meta text-ui-mute">Loading…</p>}
      {isError && <p className="text-meta text-ui-danger">Could not load the issue types.</p>}
      {types != null && types.length === 0 && (
        <p className="text-meta text-ui-mute">No Jira tickets read yet. Issue types show here once Limn has read a ticket.</p>
      )}
      {types != null && types.length > 0 && (
        // ONE grid for every row: the issue type, then a column per field. Every cell is vertically
        // centred and every menu fills its column, so the menus line up down the list.
        <div role="table" aria-label="Ticket fields by issue type" className="text-body">
          <div role="row" className={`${ROW_GRID.replace(/^grid /, 'hidden sm:grid ')} border-b border-ui-line pb-1.5`}>
            <span role="columnheader" className="text-meta font-medium text-ui-mute">Issue type</span>
            <span role="columnheader" className="text-meta font-medium text-ui-mute">Criteria</span>
            {hasOpenPoints && <span role="columnheader" className="text-meta font-medium text-ui-mute">Open points</span>}
          </div>
          {types.map((t) => (
            <TypeRow
              key={`${t.apiRoot}|${t.issueTypeId}`}
              row={t}
              disabled={setField.isPending || setOpenPoints.isPending}
              onChoose={(fieldId) => setField.mutate({ apiRoot: t.apiRoot, issueTypeId: t.issueTypeId, fieldId })}
              onChooseOpenPoints={(mode, fieldId) =>
                setOpenPoints.mutate({ apiRoot: t.apiRoot, issueTypeId: t.issueTypeId, mode, fieldId })
              }
              withOpenPoints={hasOpenPoints}
            />
          ))}
        </div>
      )}
      {setField.isError && <p className="text-meta text-ui-danger">{setField.error.message || 'Could not save the field.'}</p>}
      {setOpenPoints.isError && (
        <p className="text-meta text-ui-danger">{setOpenPoints.error.message || 'Could not save the open points field.'}</p>
      )}
    </div>
  );
}

// The rows' one grid: on a narrow modal each row stacks; from `sm` the type and the two menus sit in
// three columns: the type up to 11rem, the menus sharing the rest equally.
const ROW_GRID =
  'grid grid-cols-1 items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_minmax(0,1fr)]';

// The open-points select's value: '' = Limn picks, NONE = description only, else a field id.
const NONE = ' none';

function TypeRow({
  row,
  disabled,
  onChoose,
  onChooseOpenPoints,
  withOpenPoints,
}: {
  row: JiraAcFieldTypeRow;
  disabled: boolean;
  /** Some row has an open-points menu: keep its column (empty on a row without one). */
  withOpenPoints: boolean;
  onChoose: (fieldId: string | null) => void;
  onChooseOpenPoints: (mode: OpenPointsFieldMode, fieldId: string | null) => void;
}): JSX.Element {
  const id = useId();
  const value = row.chosen?.id ?? '';
  const op = row.openPoints;
  const opValue = op == null || op.mode === 'auto' ? '' : op.mode === 'none' ? NONE : (op.chosen?.id ?? '');
  const fieldOptions = row.fields.map((f) => (
    <option key={f.id} value={f.id}>
      {f.name} · {f.id.replace(/^customfield_/, '')}
    </option>
  ));
  return (
    <div role="row" className={`${ROW_GRID} border-b border-ui-line py-2 last:border-b-0`}>
      <span role="cell" className="min-w-0 text-ui-ink">
        {row.issueTypeName}
        <span className="ml-1.5 text-meta text-ui-mute">
          {row.ticketCount === 1 ? '1 ticket' : `${row.ticketCount} tickets`}
        </span>
      </span>
      <span role="cell" className="min-w-0">
        <select
          id={id}
          aria-label={`Criteria field for ${row.issueTypeName}`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChoose(e.target.value === '' ? null : e.target.value)}
          className={`${inputCls} truncate`}
        >
          <option value="">Limn picks{row.chosen == null && row.inUse != null ? ` (${row.inUse.name})` : ''}</option>
          {fieldOptions}
        </select>
      </span>
      {op != null ? (
        <span role="cell" className="min-w-0">
          <select
            id={`${id}-op`}
            aria-label={`Open points field for ${row.issueTypeName}`}
            value={opValue}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') onChooseOpenPoints('auto', null);
              else if (v === NONE) onChooseOpenPoints('none', null);
              else onChooseOpenPoints('field', v);
            }}
            className={`${inputCls} truncate`}
          >
            <option value="">Limn picks{op.mode === 'auto' && op.inUse != null ? ` (${op.inUse.name})` : ''}</option>
            <option value={NONE}>Description only</option>
            {fieldOptions}
          </select>
        </span>
      ) : (
        withOpenPoints && <span role="cell" aria-hidden />
      )}
    </div>
  );
}
