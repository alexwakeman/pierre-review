import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  notionMappingProblem,
  type JiraStatusCategory,
  type NotionPropRef,
  type NotionPropertyInfo,
  type NotionSchemaResponse,
  type NotionSprintMapping,
  type NotionTrackerMapping,
  type WorkspaceJiraApiSettings,
} from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useUpdateWorkspaceTracker } from '../../hooks/useWorkspaceTracker.js';
import { NotionIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SaveButton, inputCls } from './ui.js';
import { Select } from '../ui/index.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

const CATEGORY_LABEL: Record<JiraStatusCategory, string> = { new: 'To do', indeterminate: 'In progress', done: 'Done' };

/**
 * NOTION — the token and the PROPERTY MAPPING for ONE workspace (docs/TRACKERS.md § Notion). Mounted by
 * IssueLinksSection only when the SAVED tracker is Notion with a database URL.
 *
 * ⚠ THE TOKEN IS WRITE-ONLY (`jira.hasToken`, the workspace's one tracker credential).
 * ⚠ THE SCHEMA READ IS CLICK-GATED ("Read database": one Notion call with the SAVED token). A database
 * with no prefixed Unique ID is refused with the server's sentence — nothing can be mapped.
 */
export function NotionTrackerSetup({
  workspaceId,
  jira,
  saved,
}: {
  workspaceId: number;
  jira: WorkspaceJiraApiSettings;
  saved: NotionTrackerMapping | null;
}): JSX.Element {
  const mutation = useUpdateWorkspaceTracker(workspaceId);
  const schema = useMutation<NotionSchemaResponse, Error, void>({ mutationFn: () => api.notionSchema(workspaceId) });
  const read = schema.data?.workspaceId === workspaceId ? schema.data : null;
  const tokenId = useId();
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState<NotionTrackerMapping | null>(null);

  useEffect(() => {
    setToken('');
    setReplacing(false);
    setDraft(null);
    schema.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, jira.hasToken]);
  useEffect(() => {
    if (read?.suggested != null) setDraft(read.suggested);
  }, [read]);

  const typed = token.trim();
  const showInput = !jira.hasToken || replacing;
  const problem = draft != null ? notionMappingProblem(draft) : null;
  const dirty = draft != null && JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <div className="space-y-2.5 rounded-ui bg-ui-surface p-3.5">
      <div className="flex items-center gap-1.5">
        <NotionIcon size={14} className="text-ui-ink" />
        <h4 className="text-body font-semibold text-ui-ink">Notion</h4>
        <InfoButton title="Notion as an issue tracker">
          <p>
            Each ticket is a page in this database. Limn finds a ticket by its Unique ID, such as ENG-123, in the PR
            title or branch, so the database needs a Unique ID property with a prefix.
          </p>
          <p>
            Create an internal integration at notion.so/my-integrations with read content, read comments and read
            user information, then share the database (and a Sprints database, if you use one) with it.
          </p>
          <p>Limn only reads Notion. It never changes a page.</p>
        </InfoButton>
      </div>

      {showInput ? (
        <Field
          label="Integration token"
          htmlFor={tokenId}
          hint={jira.hasToken ? 'The new token replaces the saved one when you save.' : 'It starts with ntn_ or secret_. A saved token is never shown again.'}
        >
          <input
            id={tokenId}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            placeholder="ntn_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : (
        <div className="flex items-center gap-2 text-body">
          <span className="font-medium text-ui-mute">Integration token</span>
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
      )}
      {typed !== '' && (
        <SaveButton dirty saving={mutation.isPending} onClick={() => mutation.mutate({ jira: { token: typed } })} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BTN}
          disabled={!jira.hasToken || schema.isPending}
          onClick={() => schema.mutate()}
          data-testid="notion-read-database"
        >
          {schema.isPending ? 'Reading…' : saved != null ? 'Change mapping' : 'Read database'}
        </button>
        {!jira.hasToken && <span className="text-meta text-ui-mute">Save a token first.</span>}
        {read == null && saved != null && (
          <span className="text-meta text-ui-mute">{mappingSummary(saved)}</span>
        )}
        {read == null && saved == null && jira.hasToken && (
          <span className="text-meta text-ui-warn">Not mapped yet. Nothing is read until it is.</span>
        )}
      </div>
      {schema.isError && <p className="text-body text-ui-danger">{schema.error.message}</p>}
      {read?.refusal != null && <p className="text-body text-ui-danger">{read.refusal}</p>}

      {read != null && read.refusal == null && draft != null && (
        <MappingForm schema={read} draft={draft} onChange={setDraft} />
      )}
      {read != null && draft != null && (
        <>
          {problem != null && <p className="text-body text-ui-danger">{problem}</p>}
          <SaveButton
            dirty={dirty && problem == null}
            saving={mutation.isPending}
            onClick={() => mutation.mutate({ notion: draft })}
          />
        </>
      )}
      {mutation.isError && <p className="text-body text-ui-danger">{mutation.error.message}</p>}
    </div>
  );
}

function mappingSummary(m: NotionTrackerMapping): string {
  const parts = [`Keys ${m.uniqueId.prefix}-123`];
  if (m.status != null) parts.push(`status from ${m.status.property.name}`);
  if (m.sprint != null) parts.push(`sprint from ${m.sprint.property.name}`);
  return `${parts.join(', ')}.`;
}

const ref = (p: NotionPropertyInfo): NotionPropRef => ({ id: p.id, name: p.name });

function PropSelect({
  label,
  props,
  value,
  onChange,
  noneLabel = 'None',
  hint,
}: {
  label: string;
  props: readonly NotionPropertyInfo[];
  value: string | null;
  onChange: (p: NotionPropertyInfo | null) => void;
  noneLabel?: string;
  hint?: string;
}): JSX.Element {
  return (
    <Field group label={label} hint={hint}>
      <Select
        label={label}
        className="w-full sm:w-auto"
        value={value ?? ''}
        onChange={(v) => onChange(props.find((p) => p.id === v) ?? null)}
        options={[{ value: '', label: noneLabel }, ...props.map((p) => ({ value: p.id, label: p.name }))]}
      />
    </Field>
  );
}

function MappingForm({
  schema,
  draft,
  onChange,
}: {
  schema: NotionSchemaResponse;
  draft: NotionTrackerMapping;
  onChange: (m: NotionTrackerMapping) => void;
}): JSX.Element {
  const props = schema.properties;
  const of = (...types: NotionPropertyInfo['type'][]): NotionPropertyInfo[] => props.filter((p) => types.includes(p.type));
  const set = (patch: Partial<NotionTrackerMapping>): void => onChange({ ...draft, ...patch });
  const statusProp = draft.status != null ? props.find((p) => p.id === draft.status!.property.id) : undefined;
  const sprintProp = draft.sprint != null ? props.find((p) => p.id === draft.sprint!.property.id) : undefined;
  const sprintChoices = props.filter(
    (p) => (p.type === 'relation' && schema.sprintDatabases[p.id] != null) || p.type === 'select' || p.type === 'date',
  );

  const pickSprint = (p: NotionPropertyInfo | null): void => {
    let sprint: NotionSprintMapping | null = null;
    if (p?.type === 'relation') {
      const db = schema.sprintDatabases[p.id];
      if (db != null && db.dateProperties[0] != null)
        sprint = { kind: 'relation', property: ref(p), sprintDatabaseId: db.databaseId, dateProperty: db.dateProperties[0] };
    } else if (p?.type === 'select') {
      sprint = { kind: 'select', property: ref(p), current: p.options?.[p.options.length - 1] ?? '' };
    } else if (p?.type === 'date') sprint = { kind: 'date', property: ref(p) };
    set({ sprint });
  };

  return (
    <div className="space-y-2" data-testid="notion-mapping-form">
      <p className="text-body text-ui-ink">
        {schema.title}: keys look like {draft.uniqueId.prefix}-123 ({draft.uniqueId.property.name}).
      </p>
      <PropSelect
        label="Status"
        props={of('status', 'select')}
        value={draft.status?.property.id ?? null}
        onChange={(p) =>
          set({
            status:
              p == null
                ? null
                : p.type === 'status'
                  ? { type: 'status', property: ref(p) }
                  : { type: 'select', property: ref(p), options: Object.fromEntries((p.options ?? []).map((o) => [o, 'new' as JiraStatusCategory])) },
          })
        }
      />
      {draft.status?.type === 'select' && statusProp != null && (
        <div className="grid grid-cols-2 gap-1.5 pl-2">
          {(statusProp.options ?? []).map((o) => (
            <Field key={o} group label={o}>
              <Select
                label={o}
                value={draft.status?.type === 'select' ? (draft.status.options[o] ?? 'new') : 'new'}
                onChange={(v) =>
                  draft.status?.type === 'select' &&
                  set({ status: { ...draft.status, options: { ...draft.status.options, [o]: v } } })
                }
                options={(Object.keys(CATEGORY_LABEL) as JiraStatusCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
              />
            </Field>
          ))}
        </div>
      )}
      <PropSelect label="Assignee" props={of('people')} value={draft.assignee?.id ?? null} onChange={(p) => set({ assignee: p != null ? ref(p) : null })} />
      <PropSelect
        label="Sprint"
        props={sprintChoices}
        value={draft.sprint?.property.id ?? null}
        onChange={pickSprint}
        hint="A relation to a Sprints database, a select, or a date range. None: This Sprint shows open tickets edited lately."
      />
      {draft.sprint?.kind === 'relation' && (
        <PropSelect
          label="Sprint dates"
          props={(schema.sprintDatabases[draft.sprint.property.id]?.dateProperties ?? []).map((d) => ({ ...d, type: 'date' as const }))}
          value={draft.sprint.dateProperty.id}
          noneLabel="Pick one"
          onChange={(p) => p != null && draft.sprint?.kind === 'relation' && set({ sprint: { ...draft.sprint, dateProperty: { id: p.id, name: p.name } } })}
          hint="The current sprint is the one whose dates include today."
        />
      )}
      {draft.sprint?.kind === 'select' && sprintProp != null && (
        <Field group label="Current sprint">
          <Select
            label="Current sprint"
            className="w-full sm:w-auto"
            value={draft.sprint.current}
            onChange={(v) => draft.sprint?.kind === 'select' && set({ sprint: { ...draft.sprint, current: v } })}
            options={(sprintProp.options ?? []).map((o) => ({ value: o, label: o }))}
          />
        </Field>
      )}
      <PropSelect label="Type" props={of('select')} value={draft.issueType?.id ?? null} onChange={(p) => set({ issueType: p != null ? ref(p) : null })} />
      <PropSelect
        label="Acceptance criteria"
        props={of('rich_text')}
        value={draft.criteria?.id ?? null}
        noneLabel="From the page"
        onChange={(p) => set({ criteria: p != null ? ref(p) : null })}
      />
      <PropSelect
        label="Blocked by"
        props={props.filter((p) => p.type === 'relation' && p.relationDatabaseId === schema.databaseId)}
        value={draft.blockedBy?.id ?? null}
        onChange={(p) => set({ blockedBy: p != null ? ref(p) : null })}
      />
    </div>
  );
}
