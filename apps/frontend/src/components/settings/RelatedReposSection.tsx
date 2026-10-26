import { useEffect, useMemo, useState } from 'react';
import { RELATED_REPOS_MAX_PER_REPO, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW } from '@pierre-review/shared';
import { useRepos } from '../../hooks/useTimeline.js';
import { relatedTo, useRelatedRepos, useSetRelatedRepos } from '../../hooks/useRelatedRepos.js';
import { InfoButton } from '../InfoModal.js';
import { inputCls, SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

// RELATED REPOS for THIS workspace (CORE, free; `GET /api/workspaces/:id/related-repos`, `PUT
// …/related-repos/:repoId`, `repo_relations`, migration 0131; docs/CLAUDE-REVIEW.md § Related repos).
// Mounted only on `me.ai.enabled`: only the AI review reads it. Off by default (no relations).
//
// One repository at a time: pick it, tick the repos that go with it, Save. The relation is SYMMETRIC
// (the server stores it both ways), so the list below shows each pair once.
//
// ⚠ DRAFT + SAVE, like every other section in this modal.
export function RelatedReposSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const repos = useRepos();
  const related = useRelatedRepos(workspaceId);
  const save = useSetRelatedRepos(workspaceId);

  // The roster comes from `Repo.workspaceId`, the client's one repo→workspace mapping.
  const members = useMemo(
    () =>
      (repos.data ?? [])
        .filter((r) => r.workspaceId === workspaceId)
        .slice()
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [repos.data, workspaceId],
  );
  const nameOf = useMemo(() => new Map(members.map((r) => [r.id, r.fullName])), [members]);
  const pairs = related.data?.pairs;

  const [repoId, setRepoId] = useState<number | null>(null);
  // The picked repo, else the first member (re-picked when the workspace changes).
  const current = repoId != null && nameOf.has(repoId) ? repoId : (members[0]?.id ?? null);
  const stored = useMemo(() => (current != null && pairs ? relatedTo(pairs, current) : []), [pairs, current]);
  const storedKey = `${workspaceId}|${current}|${stored.join(',')}`;
  const [draft, setDraft] = useState<number[]>(stored);
  // Re-seed on the values (a workspace switch, another repo picked, after a save) — never the
  // response object, whose identity changes on every refetch.
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  if (workspaceId == null || pairs == null) {
    return <ScopePendingSection title="Related repos" failed={related.isError} />;
  }

  const dirty = draft.length !== stored.length || draft.some((id) => !stored.includes(id));
  const full = draft.length >= RELATED_REPOS_MAX_PER_REPO;
  const toggle = (id: number): void =>
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : full ? prev : [...prev, id]));

  return (
    <SectionShell
      title="Related repos"
      desc="A review of a pull request in one repository also reads the matching change in its related repositories."
      info={
        <InfoButton title="Related repos">
          <p>
            Use this for repositories that change together, such as a frontend and its backend. When AI Review checks a
            pull request, it also reads each related repository, read-only, to find problems between them.
          </p>
          <p>From each related repository it reads the first of these that exists:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>an open pull request on a branch with the same name;</li>
            <li>an open pull request that names the same ticket, such as BMD-1048;</li>
            <li>a branch with the same name, with no pull request;</li>
            <li>the default branch, for reference.</li>
          </ol>
          <p>
            Only deep reviews read them, at most {TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW} per review together with other
            pull requests on the same ticket. The review says what it read.
          </p>
          <p>A relation works both ways. Moving a repository to another workspace removes its relations.</p>
        </InfoButton>
      }
    >
      {repos.isLoading ? (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">Loading this workspace’s repositories…</p>
      ) : members.length < 2 ? (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">This needs two or more repositories in the workspace.</p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-gray-600 dark:text-gray-300">Repository</span>
            <select
              className={inputCls}
              value={current ?? ''}
              onChange={(e) => setRepoId(Number(e.target.value))}
              aria-label="Repository"
            >
              {members.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-gray-600 dark:text-gray-300">Reviewed together with</div>
            <div className="max-h-44 space-y-1 overflow-auto rounded border border-gray-200 p-2 dark:border-gray-700">
              {members
                .filter((r) => r.id !== current)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.includes(r.id)}
                      disabled={full && !draft.includes(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                    <span className="truncate text-gray-700 dark:text-gray-200">{r.fullName}</span>
                  </label>
                ))}
            </div>
          </div>
          <SaveButton
            dirty={dirty}
            saving={save.isPending}
            onClick={() => current != null && save.mutate({ repoId: current, relatedRepoIds: draft })}
          />
        </>
      )}

      {pairs.length > 0 && (
        <ul className="space-y-0.5 text-xs text-gray-600 dark:text-gray-300" aria-label="Related pairs">
          {pairs.map((p) => (
            <li key={`${p.repoId}:${p.relatedRepoId}`}>
              {nameOf.get(p.repoId) ?? `#${p.repoId}`} and {nameOf.get(p.relatedRepoId) ?? `#${p.relatedRepoId}`}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-gray-500 dark:text-gray-400">Applies to this workspace only.</p>

      {save.isError && (
        <div className="text-[11px] text-red-500">{save.error?.message ?? 'Couldn’t save this setting.'}</div>
      )}
    </SectionShell>
  );
}
