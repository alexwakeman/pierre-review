import { useState } from 'react';
import {
  SPRINT_CHIPS,
  SPRINT_REPO_REASON_LABEL,
  SPRINT_REPOS_PER_TICKET_MAX,
  STORY_CRITERIA_SOURCE_LABEL,
  type SprintChip,
  type SprintRepoRef,
  type SprintTicketRow,
} from '@pierre-review/shared';
import { useSprintReposSaving, useSprintSetRepos } from '../../hooks/useSprintStories.js';
import { chipFixesMarkdown, chipFixMarkdown, ticketCopyAllMarkdown } from '../../lib/copy.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ChevronIcon, CloseIcon, PlusIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintAssessment } from './SprintAssessment.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { SprintUpdatePanel } from './SprintUpdatePanel.js';
import { chipGroupSuffix, groupChips, splitChips, type ChipGroup } from './sprintModel.js';

// One ticket on Reports → This sprint. Collapsed: key + title, status, assignee (display only), chips,
// PRs. Expanded: each chip's criterion and templated fix (each copyable), candidate repos, the code
// assessment and the update panel. "Copy all" copies everything generated for the ticket.

const MUTED = 'text-gray-500 dark:text-gray-400';

function ChipPill({ group }: { group: ChipGroup }): JSX.Element {
  const meta = SPRINT_CHIPS[group.id];
  // Code chips are filled grey, label chips outlined — the ⓘ on the heading says which is which.
  const cls =
    meta.source === 'code'
      ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
      : 'border border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300';
  const suffix = chipGroupSuffix(group.criteria);
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {meta.label}
      {suffix != null && <span className="ml-1 font-normal">· {suffix}</span>}
    </span>
  );
}

export function SprintTicketCard({
  ticket: t,
  workspaceId,
  aiEnabled,
  repos,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  aiEnabled: boolean;
  repos: SprintRepoRef[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const href = safeExternalUrl(t.url);
  const { code, label } = splitChips(t.chips);

  return (
    <article className="rounded-lg border border-gray-200 p-3 dark:border-gray-800" data-testid="sprint-ticket">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${t.key}` : `Expand ${t.key}`}
          className="mt-0.5 shrink-0 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {href != null ? (
              <a href={href} target="_blank" rel="noreferrer" className="font-mono text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300">
                {t.key}
              </a>
            ) : (
              <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">{t.key}</span>
            )}
            <span className="text-sm text-gray-800 dark:text-gray-100">{t.title}</span>
          </div>
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] ${MUTED}`}>
            {t.status != null && <span>{t.status.name}</span>}
            {t.issueType != null && <span>· {t.issueType}</span>}
            {t.assignee != null && <span>· {t.assignee.name}</span>}
            {t.epic != null && <span>· {t.epic.title ?? t.epic.key}</span>}
            {t.pullRequests.length > 0 && (
              <span>
                ·{' '}
                {t.pullRequests.map((p, i) => {
                  const u = safeExternalUrl(p.githubUrl);
                  return (
                    <span key={p.prId}>
                      {i > 0 && ', '}
                      {u != null ? (
                        <a href={u} target="_blank" rel="noreferrer" className="hover:underline">
                          {p.repoFullName.split('/')[1]}#{p.number}
                        </a>
                      ) : (
                        `${p.repoFullName.split('/')[1]}#${p.number}`
                      )}
                    </span>
                  );
                })}
              </span>
            )}
          </div>
          {(code.length > 0 || label.length > 0) && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {groupChips([...code, ...label]).map((g) => (
                <ChipPill key={g.id} group={g} />
              ))}
            </div>
          )}
          {t.labels === 'pending' && aiEnabled && <p className={`text-xs ${MUTED}`}>Criteria not read yet.</p>}
        </div>
        <SprintCopyButton markdown={ticketCopyAllMarkdown(t)} label="Copy all" what={`everything for ${t.key}`} />
      </div>

      {open && (
        <div className="mt-3 space-y-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <FixesBlock ticket={t} />
          <ReposBlock ticket={t} workspaceId={workspaceId} repos={repos} />
          {(aiEnabled || t.assessment != null) && (
            <SprintAssessment ticket={t} workspaceId={workspaceId} aiEnabled={aiEnabled} />
          )}
          <SprintUpdatePanel ticket={t} workspaceId={workspaceId} />
        </div>
      )}
    </article>
  );
}

function FixesBlock({ ticket: t }: { ticket: SprintTicketRow }): JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">What to fix</h5>
        {t.criteria.items.length > 0 && (
          <span className={`text-[11px] ${MUTED}`}>
            {t.criteria.items.length} {t.criteria.items.length === 1 ? 'criterion' : 'criteria'} ·{' '}
            {STORY_CRITERIA_SOURCE_LABEL[t.criteria.source]}
          </span>
        )}
        <SprintCopyButton markdown={chipFixesMarkdown(t)} what={`the fixes for ${t.key}`} className="ml-auto" />
      </div>
      {t.chips.length === 0 ? (
        <p className={`text-xs ${MUTED}`}>Nothing flagged.</p>
      ) : (
        <ul className="space-y-2">
          {t.chips.map((c, i) => (
            <li key={`${c.id}-${c.criterion?.n ?? 's'}-${i}`} className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">
                  {SPRINT_CHIPS[c.id].label}
                  {c.criterion != null && <span className={`font-normal ${MUTED}`}> · criterion {c.criterion.n}</span>}
                </div>
                {c.criterion != null && (
                  <blockquote className="border-l-2 border-gray-200 pl-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
                    {c.criterion.text}
                  </blockquote>
                )}
                <p className="text-xs text-gray-800 dark:text-gray-100">{c.fix}</p>
              </div>
              <SprintCopyButton markdown={chipFixMarkdown(c)} what="this fix" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReposBlock({
  ticket: t,
  workspaceId,
  repos,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  repos: SprintRepoRef[];
}): JSX.Element {
  const save = useSprintSetRepos(workspaceId, t.ident);
  const saving = useSprintReposSaving(t.ident);
  const [picking, setPicking] = useState('');
  const accepted = t.repos.accepted;
  const acceptedIds = accepted.map((r) => r.repoId);
  const full = accepted.length >= SPRINT_REPOS_PER_TICKET_MAX;
  const set = (ids: number[]): void => save.mutate(ids);
  const pickable = repos.filter((r) => !acceptedIds.includes(r.repoId));

  return (
    <section className="space-y-2">
      <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Repos
        <InfoButton title="Repos">
          <p>The repos this ticket&rsquo;s work lands in. Only the repos you add are used when you assess the ticket with code.</p>
          <p>Dashed repos are suggestions. Click one to use it. Each says why it was suggested.</p>
          <p>Up to {SPRINT_REPOS_PER_TICKET_MAX} repos per ticket.</p>
        </InfoButton>
      </h5>
      <div className="flex flex-wrap items-center gap-1.5">
        {accepted.map((r) => (
          <span
            key={r.repoId}
            className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
          >
            {r.fullName}
            <button
              type="button"
              disabled={saving}
              onClick={() => set(acceptedIds.filter((id) => id !== r.repoId))}
              aria-label={`Remove ${r.fullName}`}
              className="hover:text-sky-950 disabled:opacity-50 dark:hover:text-white"
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        {!full &&
          t.repos.suggested.map((s) => (
            <button
              key={s.repoId}
              type="button"
              disabled={saving}
              onClick={() => set([...acceptedIds, s.repoId])}
              className="inline-flex items-center gap-1 rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-600 hover:border-gray-400 hover:text-gray-800 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:text-gray-100"
            >
              <PlusIcon size={10} />
              {s.fullName}
              <span className={MUTED}>
                · {s.reasons.length > 0 ? s.reasons.map((r) => SPRINT_REPO_REASON_LABEL[r]).join(' · ') : 'Suggested'}
              </span>
            </button>
          ))}
        {!full && pickable.length > 0 && (
          <select
            value={picking}
            disabled={saving}
            onChange={(e) => {
              const id = Number(e.target.value);
              setPicking('');
              if (Number.isInteger(id) && id > 0) set([...acceptedIds, id]);
            }}
            aria-label="Add a repo"
            className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            <option value="">Add a repo…</option>
            {pickable.map((r) => (
              <option key={r.repoId} value={r.repoId}>
                {r.fullName}
              </option>
            ))}
          </select>
        )}
      </div>
      {full && <p className={`text-xs ${MUTED}`}>Up to {SPRINT_REPOS_PER_TICKET_MAX} repos per ticket.</p>}
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
    </section>
  );
}
