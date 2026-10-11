import { Fragment, useState } from 'react';
import {
  SPRINT_PROVIDER_LABEL,
  SPRINT_REPOS_PER_TICKET_MAX,
  storyIssueChipText,
  type SprintChecks,
  type SprintRelatedTicket,
  type SprintRepoRef,
  type SprintTicketRow,
  isBlockingSprintRelation,
  sprintRelatedGroups,
} from '@pierre-review/shared';
import { useSprintReposSaving, useSprintSetRepos } from '../../hooks/useSprintStories.js';
import { ticketCopyAllMarkdown } from '../../lib/copy.js';
import { useOpenTicketTab } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ChevronIcon, CloseIcon, ExternalLinkIcon, PullRequestIcon } from '../Icons.js';
import { SprintAssessment } from './SprintAssessment.js';
import { SprintCodeCheck } from './SprintCodeCheck.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { SprintTicketReview } from './SprintTicketReview.js';
import { STORY_ISSUE_PILL_CLASS, relatedPillParts, repoPickerOptions } from './sprintModel.js';

// One ticket on Reports → This sprint. Collapsed: ONE button "<KEY> <title>" (a chevron inside) that
// opens the card, an icon link to the tracker beside it, then status, assignee (display only), PRs
// (each opens on GitHub; "Ticket PRs" opens the ticket tab), at most two issue chips and the tickets it
// points at (`related`: "Blocked by" pills first, then "Coordinate with", then "Related" — shared
// `sprintRelatedGroups`; each opens that ticket's tab, a done
// one muted).
// Opened: the repos (accepted chips + one "Add a repo…" picker, suggested ones tagged), "Check against
// code" (with its progress bar), the Code check's result full width (`SprintCodeCheck`: a plan or a
// per-criterion check, by the ticket's stage), and the ticket reviewed like a pull request and edited as a draft (`SprintTicketReview`: the
// rendered text with each finding highlighted, the findings as threads beside it with Replace, Edit
// per field, the proposals with "Apply to draft", and the ONE "Update in <tracker>"). "Copy all"
// copies the header, the summary, the bullets and the spec gaps.

const MUTED = 'text-gray-500 dark:text-gray-400';

export function SprintTicketCard({
  ticket: t,
  workspaceId,
  aiEnabled,
  repos,
  checks,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  aiEnabled: boolean;
  repos: SprintRepoRef[];
  checks: SprintChecks;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const href = safeExternalUrl(t.url);
  const openTicketTab = useOpenTicketTab();

  return (
    <article className="min-w-0 rounded-lg border border-gray-200 p-3 dark:border-gray-800" data-testid="sprint-ticket">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-1.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="group flex min-w-0 items-start gap-1.5 text-left"
            >
              <ChevronIcon dir={open ? 'down' : 'right'} size={12} className="mt-1 shrink-0 text-gray-500 dark:text-gray-400" />
              <span className="min-w-0 break-words text-sm text-gray-800 group-hover:underline dark:text-gray-100">
                <span className="mr-1.5 font-mono text-xs font-semibold">{t.key}</span>
                {t.title}
              </span>
            </button>
            {href != null && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${t.key} in ${SPRINT_PROVIDER_LABEL[t.provider]}`}
                title={`Open ${t.key} in ${SPRINT_PROVIDER_LABEL[t.provider]}`}
                className="mt-0.5 shrink-0 rounded p-0.5 text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950/40"
              >
                <ExternalLinkIcon size={13} />
              </a>
            )}
          </div>
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px] text-[11px] ${MUTED}`}>
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
                })}{' '}
                <button
                  type="button"
                  onClick={() => openTicketTab({ ident: t.ident, key: t.key, title: t.title })}
                  className="inline-flex items-center gap-0.5 rounded border border-gray-300 px-1 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
                >
                  <PullRequestIcon size={10} />
                  Ticket PRs
                </button>
              </span>
            )}
          </div>
          {t.issues.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-[18px] pt-0.5">
              {t.issues.map((i) => (
                <span
                  key={i.id}
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${STORY_ISSUE_PILL_CLASS[i.id]}`}
                >
                  {storyIssueChipText(i)}
                </span>
              ))}
            </div>
          )}
          <RelatedPills ticket={t} />
          {t.labels === 'pending' && aiEnabled && <p className={`pl-[18px] text-xs ${MUTED}`}>Criteria not read yet.</p>}
        </div>
        <SprintCopyButton markdown={ticketCopyAllMarkdown(t, checks)} label="Copy all" what={`everything for ${t.key}`} />
      </div>

      {open && (
        <div className="mt-3 space-y-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
            <ReposBlock ticket={t} workspaceId={workspaceId} repos={repos} />
            {(aiEnabled || t.assessment != null) && (
              <SprintAssessment ticket={t} workspaceId={workspaceId} aiEnabled={aiEnabled} />
            )}
          </div>
          <SprintCodeCheck ticket={t} />
          <SprintTicketReview ticket={t} workspaceId={workspaceId} />
        </div>
      )}
    </article>
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
  const accepted = t.repos.accepted;
  const acceptedIds = accepted.map((r) => r.repoId);
  const full = accepted.length >= SPRINT_REPOS_PER_TICKET_MAX;
  const set = (ids: number[]): void => save.mutate(ids);
  const options = repoPickerOptions(repos, accepted, t.repos.suggested);

  return (
    <section className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Repos</h5>
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
        {!full && options.length > 0 && (
          <select
            value=""
            disabled={saving}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (Number.isInteger(id) && id > 0) set([...acceptedIds, id]);
            }}
            aria-label="Add a repo"
            className="max-w-full rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            <option value="">Add a repo…</option>
            {options.map((o) => (
              <option key={o.repoId} value={o.repoId}>
                {o.text}
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

function RelatedPills({ ticket: t }: { ticket: SprintTicketRow }): JSX.Element | null {
  const openTicketTab = useOpenTicketTab();
  const [showDone, setShowDone] = useState(false);
  const related = t.related ?? [];
  if (related.length === 0) return null;
  const groups = sprintRelatedGroups(related);
  // Done related tickets fold behind "+N done" — on a long story they were most of the row.
  const relatedOpen = groups.related.filter((r) => r.done !== true);
  const relatedDone = groups.related.filter((r) => r.done === true);
  const pill = (r: SprintRelatedTicket): JSX.Element => {
    const p = relatedPillParts(r);
    const blocking = isBlockingSprintRelation(r);
    return (
      <button
        key={r.key}
        type="button"
        onClick={() => openTicketTab({ ident: r.ident, key: r.key, title: r.title })}
        aria-label={`Open ${r.key}${r.title != null ? ` ${r.title}` : ''}${r.status != null ? `, ${r.status}` : ''}`}
        className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px] hover:border-gray-400 dark:hover:border-gray-500 ${
          r.done === true
            ? 'border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400'
            : blocking
              ? 'border-rose-300 text-gray-800 dark:border-rose-800 dark:text-gray-100'
              : 'border-gray-300 text-gray-800 dark:border-gray-700 dark:text-gray-100'
        }`}
        data-testid="sprint-related-pill"
      >
        <span className={`font-mono font-semibold ${r.done === true ? 'line-through' : ''}`}>{p.key}</span>
        {p.title != null && <span className="min-w-0 truncate">{p.title}</span>}
        {p.status != null && <span className="shrink-0 text-gray-500 dark:text-gray-400">· {p.status}</span>}
      </button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1 pl-[18px] pt-0.5" data-testid="sprint-related">
      {(
        [
          ['Blocked by', groups.blockedBy],
          ['Coordinate with', groups.coordinate],
          ['Related', relatedOpen],
        ] as const
      ).map(([label, list], i) =>
        list.length === 0 && !(label === 'Related' && relatedDone.length > 0) ? null : (
          <Fragment key={label}>
            <span className={`text-[11px] text-gray-500 dark:text-gray-400 ${i > 0 ? 'ml-1' : ''}`}>{label}</span>
            {list.map(pill)}
            {label === 'Related' && relatedDone.length > 0 && (
              <>
                {showDone && relatedDone.map(pill)}
                <button
                  type="button"
                  onClick={() => setShowDone((v) => !v)}
                  aria-expanded={showDone}
                  className="rounded px-1 text-[11px] text-sky-700 hover:underline dark:text-sky-300"
                >
                  {showDone ? 'Hide done' : `+${relatedDone.length} done`}
                </button>
              </>
            )}
          </Fragment>
        ),
      )}
    </div>
  );
}
