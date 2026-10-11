import { useState } from 'react';
import {
  SPRINT_REPO_REASON_LABEL,
  SPRINT_REPOS_PER_TICKET_MAX,
  STORY_ISSUE_BY_ID,
  STORY_SPEC_GAP_TYPE_LABEL,
  sprintAssessmentBodyOf,
  sprintBullets,
  sprintCurrentAssessmentBodyOf,
  sprintSpecGapLines,
  isRealStoryBlocker,
  storyBlockerPhrase,
  storyUnclearCriteriaShown,
  storyIssueChipText,
  type SprintBullet,
  type SprintChecks,
  type SprintRepoRef,
  type SprintSpecGapLine,
  type SprintTicketRow,
  type StoryBlocker,
  type StoryIssue,
} from '@pierre-review/shared';
import { useSprintReposSaving, useSprintSetRepos } from '../../hooks/useSprintStories.js';
import { sprintBulletMarkdown, sprintSpecGapLineMarkdown, ticketCopyAllMarkdown } from '../../lib/copy.js';
import { useOpenTicketTab } from '../../lib/ticketTab.js';
import { relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { ChevronIcon, CloseIcon, PlusIcon, PullRequestIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintAssessment } from './SprintAssessment.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { SprintUpdatePanel } from './SprintUpdatePanel.js';

// One ticket on Reports → This sprint. Collapsed: key + title, status, assignee (display only), at
// most two issue chips (Unclear when done, Blocked), PRs (each opens on GitHub; "Ticket PRs" opens the
// ticket tab). Expanded, in this order and nothing else: the detail per issue (each copyable as its
// one-line bullet; Claude's sentence replaces the template once the ticket was checked against code),
// the Spec gaps section (not-started tickets only: the first gap with its type, copyable; never a chip),
// the candidate repos, the
// "Check against code" button and the update panel. "Copy all" copies the header, the summary, the
// bullets and the spec gaps.
//
// ⚠ THE DETAIL IS THE SPECIFIC ONE: which criterion and why, what the ticket waits on (a linked key
// opens in the tracker), who owns it and its state, which details the spec leaves out. Only the first
// two flagged criteria are listed ("and N more"); only REAL blockers are listed (`isRealStoryBlocker`).

const MUTED = 'text-gray-500 dark:text-gray-400';

function ClaudeMark(): JSX.Element {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[11px] text-ai-ink">
      <SparkleIcon size={10} className="text-ai-signal" />
      Claude
    </span>
  );
}

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
            <div className="flex flex-wrap gap-1 pt-0.5">
              {t.issues.map((i) => (
                <span
                  key={i.id}
                  className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {storyIssueChipText(i)}
                </span>
              ))}
            </div>
          )}
          {t.labels === 'pending' && aiEnabled && <p className={`text-xs ${MUTED}`}>Criteria not read yet.</p>}
        </div>
        <SprintCopyButton markdown={ticketCopyAllMarkdown(t, checks)} label="Copy all" what={`everything for ${t.key}`} />
      </div>

      {open && (
        <div className="mt-3 space-y-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <IssuesBlock ticket={t} checks={checks} />
          <ReposBlock ticket={t} workspaceId={workspaceId} repos={repos} />
          {(aiEnabled || t.assessment != null) && (
            <SprintAssessment ticket={t} workspaceId={workspaceId} aiEnabled={aiEnabled} />
          )}
          {/* Nothing to propose and nothing written yet → no editor at all. */}
          {(sprintBullets(t, checks).length > 0 ||
            sprintSpecGapLines(t, checks).length > 0 ||
            sprintCurrentAssessmentBodyOf(t) != null ||
            t.lastWrite != null) && (
            <SprintUpdatePanel ticket={t} workspaceId={workspaceId} checks={checks} />
          )}
        </div>
      )}
    </article>
  );
}

function IssuesBlock({ ticket: t, checks }: { ticket: SprintTicketRow; checks: SprintChecks }): JSX.Element {
  const record = t.assessment?.record ?? null;
  const body = sprintAssessmentBodyOf(t);
  const stale = body != null && t.assessment?.currency === 'stale';
  const bullets = sprintBullets(t, checks);
  const gaps = sprintSpecGapLines(t, checks);
  return (
    <section className="space-y-2" data-testid="sprint-issues">
      {record?.outdated === true && <p className={`text-xs ${MUTED}`}>Out of date — check against code again.</p>}
      {body != null && body.summary.trim() !== '' && (
        <p className="text-xs text-gray-800 dark:text-gray-100">
          {body.summary}
          <ClaudeMark />
          {record?.completedAt != null && <span className={`ml-1 text-[11px] ${MUTED}`}>· {relativeTime(record.completedAt)}</span>}
          {stale && (
            <span className="ml-1 rounded bg-gray-100 px-1 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-200">Out of date</span>
          )}
        </p>
      )}
      {bullets.length === 0 ? (
        gaps.length === 0 && <p className={`text-xs ${MUTED}`}>Nothing flagged.</p>
      ) : (
        <ul className="space-y-1.5">
          {bullets.map((b) => {
            const label = STORY_ISSUE_BY_ID[b.id].label;
            const issue = t.issues.find((x) => x.id === b.id);
            return (
              <li key={b.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1 text-xs text-gray-800 dark:text-gray-100">
                  {b.source === 'code' && issue != null ? (
                    <IssueDetail issue={issue} criteria={t.criteria.items} text={b.text} />
                  ) : (
                    <ClaudeBullet bullet={b} label={label} />
                  )}
                </div>
                <SprintCopyButton markdown={sprintBulletMarkdown(b)} what={`the ${label} line`} />
              </li>
            );
          })}
        </ul>
      )}
      <SpecGapsBlock gaps={gaps} />
    </section>
  );
}

/** The Spec gaps section: each gap with its type (Claude's sentence marked), each copyable. Nothing when
 *  there are none or the "Spec gaps" check is off. */
function SpecGapsBlock({ gaps }: { gaps: SprintSpecGapLine[] }): JSX.Element | null {
  if (gaps.length === 0) return null;
  return (
    <div data-testid="sprint-spec-gaps">
      <h5 className="text-xs font-semibold text-gray-800 dark:text-gray-100">Spec gaps</h5>
      <ul className="mt-0.5 space-y-1">
        {gaps.map((g, i) => (
          <li key={i} className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-xs text-gray-800 dark:text-gray-100">
              {g.text}
              {g.type != null && <span className={MUTED}> · {STORY_SPEC_GAP_TYPE_LABEL[g.type]}</span>}
              {g.ref != null && (
                <span className={MUTED}>
                  {' '}
                  <code className="font-mono text-[11px]">{g.ref.path}</code> in {g.ref.repo}
                </span>
              )}
              {g.source === 'claude' && <ClaudeMark />}
            </p>
            <SprintCopyButton markdown={sprintSpecGapLineMarkdown(g)} what="this spec gap" />
          </li>
        ))}
      </ul>
    </div>
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
          <p>The repos this ticket&rsquo;s work lands in. Only the repos you add are read when you check the ticket against code.</p>
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

function ClaudeBullet({ bullet: b, label }: { bullet: SprintBullet; label: string }): JSX.Element {
  return (
    <p>
      <strong className="font-semibold">{label}</strong> · {b.text}
      {b.ref != null && (
        <span className={MUTED}>
          {' '}
          <code className="font-mono text-[11px]">{b.ref.path}</code> in {b.ref.repo}
        </span>
      )}
      {b.source === 'claude' && <ClaudeMark />}
    </p>
  );
}

/** One issue's specific detail (code's): the first flagged criteria with their reasons (then "and N
 *  more"), every real blocker with its owner and state (a linked key opens the tracker). */
function IssueDetail({ issue, criteria, text }: { issue: StoryIssue; criteria: string[]; text: string }): JSX.Element {
  const label = STORY_ISSUE_BY_ID[issue.id].label;
  if (issue.id === 'unclear_done' && issue.criteria.length > 0) {
    const { shown, more } = storyUnclearCriteriaShown(issue);
    return (
      <div>
        <strong className="font-semibold">{label}</strong>
        <ul className="mt-0.5 space-y-0.5">
          {shown.map((c) => (
            <li key={c.n}>
              Criterion {c.n}: {c.reason ?? 'can’t be checked'}
              {criteria[c.n - 1] != null && <span className={`block ${MUTED}`}>&ldquo;{criteria[c.n - 1]}&rdquo;</span>}
            </li>
          ))}
          {more > 0 && <li className={MUTED}>and {more} more</li>}
        </ul>
      </div>
    );
  }
  if (issue.id === 'blocked') {
    // The fold keeps REAL blockers only (`isRealStoryBlocker`): unfinished tickets and open decisions.
    const open = issue.blockers.filter(isRealStoryBlocker);
    return (
      <div>
        <strong className="font-semibold">{label}</strong> · Waits on
        <ul className="mt-0.5 space-y-0.5">
          {open.map((b, i) => (
            <li key={i}>
              <BlockerText blocker={b} />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <p>
      <strong className="font-semibold">{label}</strong> · {text}
    </p>
  );
}

/** A blocker phrase with its ticket key as a tracker link when the URL is safe. */
function BlockerText({ blocker: b }: { blocker: StoryBlocker }): JSX.Element {
  const phrase = storyBlockerPhrase(b);
  const href = safeExternalUrl(b.url);
  if (b.ticketKey == null || href == null || !phrase.startsWith(b.ticketKey)) return <>{phrase}</>;
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer" className="font-mono text-sky-700 hover:underline dark:text-sky-300">
        {b.ticketKey}
      </a>
      {phrase.slice(b.ticketKey.length)}
    </>
  );
}
