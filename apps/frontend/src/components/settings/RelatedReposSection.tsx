import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { RELATED_REPOS_MAX_PER_REPO, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW } from '@pierre-review/shared';
import { useRepos } from '../../hooks/useTimeline.js';
import { partnerIsFull, relatedTo, useRelatedRepos, useSetRelatedRepos } from '../../hooks/useRelatedRepos.js';
import { InfoButton } from '../InfoModal.js';
import { SaveButton, SectionShell, CheckInput } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { Button, Select, cx, FOCUS_RING, nextIndex } from '../ui/index.js';
import { PHONE_QUERY, useMediaQuery } from '../ui/media.js';
import {
  sharesOneOwner,
  arrowHeadPath,
  blockReason,
  clampToBand,
  curvePath,
  defaultSelectedRepo,
  draftChanges,
  pendingLine,
  type BlockReason,
  type Pt,
} from './relatedReposGeometry.js';

// RELATED REPOS for THIS workspace (CORE, free; `GET /api/workspaces/:id/related-repos`, `PUT
// …/related-repos/:repoId`, `repo_relations`, migration 0131; docs/CLAUDE-REVIEW.md § Related repos).
// Mounted only on `me.ai.enabled`: only the AI review reads it. Off by default (no relations).
//
// A MAP, two columns: select a repo on the left, click the repos on the right it is reviewed with;
// curves with arrowheads show the selected repo's relations (geometry: `relatedReposGeometry.ts`,
// pure). A phone gets the stacked checklist instead (pick a repo, tick its partners). The relation is
// SYMMETRIC (the server stores it both ways), so each left row's count includes links made from the
// other side.
//
// ⚠ DRAFT + SAVE, like every other section in this modal: one repo's draft at a time, and Save sends
// that repo's whole list (`PUT …/related-repos/:repoId {relatedRepoIds}` REPLACES it). Selecting
// another repo drops an unsaved draft, as the old picker did.

interface Member {
  id: number;
  fullName: string;
}

type Blocked = BlockReason;

export function RelatedReposSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const repos = useRepos();
  const related = useRelatedRepos(workspaceId);
  const save = useSetRelatedRepos(workspaceId);
  const phone = useMediaQuery(PHONE_QUERY);

  // The roster comes from `Repo.workspaceId`, the client's one repo→workspace mapping.
  const members = useMemo<Member[]>(
    () =>
      (repos.data ?? [])
        .filter((r) => r.workspaceId === workspaceId)
        .slice()
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .map((r) => ({ id: r.id, fullName: r.fullName })),
    [repos.data, workspaceId],
  );
  const nameOf = useMemo(() => new Map(members.map((r) => [r.id, r.fullName])), [members]);
  const pairs = related.data?.pairs;

  const [repoId, setRepoId] = useState<number | null>(null);
  // The picked repo, else the first with a relation, else the first (re-picked on a workspace switch).
  const fallback = useMemo(
    () => (pairs ? defaultSelectedRepo(members.map((m) => m.id), pairs) : (members[0]?.id ?? null)),
    [members, pairs],
  );
  const current = repoId != null && nameOf.has(repoId) ? repoId : fallback;
  const stored = useMemo(() => (current != null && pairs ? relatedTo(pairs, current) : []), [pairs, current]);
  const storedKey = `${workspaceId}|${current}|${stored.join(',')}`;
  const [draft, setDraft] = useState<number[]>(stored);
  // Re-seed on the values (a workspace switch, another repo picked, after a save) — never the
  // response object, whose identity changes on every refetch.
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of pairs ?? []) {
      m.set(p.repoId, (m.get(p.repoId) ?? 0) + 1);
      m.set(p.relatedRepoId, (m.get(p.relatedRepoId) ?? 0) + 1);
    }
    return m;
  }, [pairs]);

  if (workspaceId == null || pairs == null) {
    return <ScopePendingSection title="Related repos" failed={related.isError} />;
  }

  const { added, removed } = draftChanges(stored, draft);
  const dirty = added.length > 0 || removed.length > 0;
  const full = draft.length >= RELATED_REPOS_MAX_PER_REPO;
  // The cap holds on both sides: 'cap' = the selected repo's draft is at the most it can take;
  // 'full' = the PARTNER already has the most (only that one is labelled "already has 8").
  const blocked = (id: number): Blocked =>
    blockReason(
      id,
      current,
      draft,
      current != null && partnerIsFull(pairs, current, id, RELATED_REPOS_MAX_PER_REPO),
      RELATED_REPOS_MAX_PER_REPO,
    );
  const toggle = (id: number): void => {
    if (blocked(id) != null) return;
    // Pin the selection, so a save that empties the default repo does not jump to another one.
    if (repoId !== current) setRepoId(current);
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const line = pendingLine(added.length, removed.length);

  return (
    <SectionShell
      title="Related repos"
      desc="Select a repo, then click the repos its reviews should also read."
      info={
        <InfoButton title="Related repos">
          <p>
            A link works both ways. When AI Review checks a pull request in one repo, it can also read the code in its
            related repos. The arrows show the links of the selected repo only.
          </p>
          <p>From each related repo it reads the first of these that exists:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>an open pull request on a branch with the same name;</li>
            <li>an open pull request that names the same ticket, such as BMD-1048;</li>
            <li>a branch with the same name, with no pull request;</li>
            <li>the default branch, for reference.</li>
          </ol>
          <p>
            Only deep reviews read them, at most {TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW} per review. Each repo can have at
            most {RELATED_REPOS_MAX_PER_REPO} links. Moving a repo to another workspace removes its links.
          </p>
        </InfoButton>
      }
    >
      {repos.isLoading ? (
        <p className="text-meta text-ui-mute">Loading this workspace’s repositories…</p>
      ) : members.length < 2 ? (
        <p className="text-meta text-ui-mute">This needs two or more repositories in the workspace.</p>
      ) : (
        <>
          {phone ? (
            <StackedChecklist
              members={members}
              current={current}
              onSelect={setRepoId}
              draft={draft}
              blocked={blocked}
              onToggle={toggle}
            />
          ) : (
            <RelationMap
              members={members}
              current={current}
              onSelect={setRepoId}
              stored={stored}
              draft={draft}
              counts={counts}
              blocked={blocked}
              onToggle={toggle}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <SaveButton
              dirty={dirty}
              saving={save.isPending}
              onClick={() => current != null && save.mutate({ repoId: current, relatedRepoIds: draft })}
            />
            {line != null && !save.isPending && (
              <>
                <span className="text-meta text-ui-mute" role="status">
                  {line}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setDraft(stored)}>
                  Discard
                </Button>
              </>
            )}
          </div>
          {full && (
            <p className="text-meta text-ui-mute">{RELATED_REPOS_MAX_PER_REPO} links is the most a repo can have.</p>
          )}
        </>
      )}

      {phone && pairs.length > 0 && (
        <ul className="space-y-0.5 text-meta text-ui-mute" aria-label="Related pairs">
          {pairs.map((p) => (
            <li key={`${p.repoId}:${p.relatedRepoId}`}>
              {nameOf.get(p.repoId) ?? `#${p.repoId}`} and {nameOf.get(p.relatedRepoId) ?? `#${p.relatedRepoId}`}
            </li>
          ))}
        </ul>
      )}
      <p className="text-meta text-ui-mute">Applies to this workspace only.</p>

      {save.isError && (
        <div className="text-meta text-ui-danger">{save.error?.message ?? 'Couldn’t save this setting.'}</div>
      )}
    </SectionShell>
  );
}

/** `owner/` muted, the name in ink; the owner is left out when every repo here shares it. */
function RepoName({ fullName, hideOwner }: { fullName: string; hideOwner: boolean }): JSX.Element {
  const slash = fullName.indexOf('/');
  return (
    <span className="min-w-0 truncate" title={fullName}>
      {slash > 0 && !hideOwner && <span className="text-ui-mute">{fullName.slice(0, slash + 1)}</span>}
      {fullName.slice(slash + 1)}
    </span>
  );
}

// ── THE MAP (md and up) ─────────────────────────────────────────────────────────────────────────

interface Curve {
  id: number;
  to: Pt;
  outside: boolean;
}

interface Geometry {
  from: Pt;
  fromOutside: boolean;
  curves: Curve[];
}

function RelationMap({
  members,
  current,
  onSelect,
  stored,
  draft,
  counts,
  blocked,
  onToggle,
}: {
  members: Member[];
  current: number | null;
  onSelect: (id: number) => void;
  stored: number[];
  draft: number[];
  counts: Map<number, number>;
  blocked: (id: number) => Blocked;
  onToggle: (id: number) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leftListRef = useRef<HTMLUListElement | null>(null);
  const rightListRef = useRef<HTMLUListElement | null>(null);
  const leftRows = useRef(new Map<number, HTMLElement>());
  const rightRows = useRef(new Map<number, HTMLElement>());
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);

  const hideOwner = useMemo(() => sharesOneOwner(members.map((m) => m.fullName)), [members]);
  // Every repo a curve is drawn to: kept, being added, being removed.
  const drawn = useMemo(() => [...new Set([...stored, ...draft])], [stored, draft]);

  const measure = useCallback((): void => {
    const box = containerRef.current;
    const left = leftListRef.current;
    const right = rightListRef.current;
    const fromRow = current != null ? leftRows.current.get(current) : undefined;
    if (box == null || left == null || right == null || fromRow == null) {
      setGeo(null);
      return;
    }
    const b = box.getBoundingClientRect();
    const l = left.getBoundingClientRect();
    const r = right.getBoundingClientRect();
    const rowMid = (el: HTMLElement): number => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2 - b.top;
    };
    const from = clampToBand(rowMid(fromRow), l.top - b.top, l.bottom - b.top);
    const curves: Curve[] = [];
    for (const id of drawn) {
      const row = rightRows.current.get(id);
      if (row == null) continue;
      const to = clampToBand(rowMid(row), r.top - b.top, r.bottom - b.top);
      curves.push({ id, to: { x: r.left - b.left, y: to.y }, outside: to.outside });
    }
    setGeo({ from: { x: l.right - b.left, y: from.y }, fromOutside: from.outside, curves });
  }, [current, drawn]);

  // On mount, scroll the LEFT list (only it, never the modal) so the selected row is in view.
  useLayoutEffect(() => {
    const list = leftListRef.current;
    const row = current != null ? leftRows.current.get(current) : undefined;
    if (list == null || row == null) return;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rows change → measure now, before paint.
  useLayoutEffect(measure, [measure, members]);

  // Resize and scroll → measure on the next frame (one per frame).
  useEffect(() => {
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const els = [containerRef.current, leftListRef.current, rightListRef.current].filter(
      (e): e is HTMLDivElement | HTMLUListElement => e != null,
    );
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    for (const el of els) ro?.observe(el);
    leftListRef.current?.addEventListener('scroll', schedule, { passive: true });
    rightListRef.current?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const left = leftListRef.current;
    const right = rightListRef.current;
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      ro?.disconnect();
      left?.removeEventListener('scroll', schedule);
      right?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [measure]);

  // Hovering a row with no curve dims nothing.
  const hoverDrawn = hovered != null && drawn.includes(hovered);
  const selectedIdx = members.findIndex((m) => m.id === current);
  const tabIdx = focusIdx != null && focusIdx < members.length ? focusIdx : selectedIdx >= 0 ? selectedIdx : 0;
  const onLeftKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    const move =
      e.key === 'ArrowDown' ? 'next' : e.key === 'ArrowUp' ? 'prev' : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : null;
    if (move == null) return;
    e.preventDefault();
    const next = nextIndex(tabIdx, members.length, move);
    if (next == null) return;
    setFocusIdx(next);
    const id = members[next]?.id;
    if (id != null) leftRows.current.get(id)?.focus();
  };

  const setRow = (map: Map<number, HTMLElement>, id: number) => (el: HTMLElement | null) => {
    if (el) map.set(id, el);
    else map.delete(id);
  };

  return (
    <div ref={containerRef} className="relative grid grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <div id="related-repos-left" className="mb-1.5 text-meta font-medium text-ui-mute">
          Repo
        </div>
        <ul
          ref={leftListRef}
          role="listbox"
          aria-labelledby="related-repos-left"
          onKeyDown={onLeftKey}
          className="max-h-72 space-y-0.5 overflow-auto rounded-ui bg-ui-surface p-1"
        >
          {members.map((m, i) => {
            const selected = m.id === current;
            const n = counts.get(m.id) ?? 0;
            return (
              <li
                key={m.id}
                ref={setRow(leftRows.current, m.id)}
                role="option"
                aria-selected={selected}
                tabIndex={i === tabIdx ? 0 : -1}
                onClick={() => {
                  setFocusIdx(i);
                  onSelect(m.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(m.id);
                  }
                }}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-ui px-2.5 py-1.5 text-body touch:py-2.5',
                  selected ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
                  FOCUS_RING,
                )}
              >
                <RepoName fullName={m.fullName} hideOwner={hideOwner} />
                {n > 0 && (
                  <span className="ml-auto shrink-0 text-meta tabular-nums text-ui-mute" aria-label={`${n} linked`}>
                    {n}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div aria-hidden="true" />

      <div className="min-w-0">
        <div id="related-repos-right" className="mb-1.5 text-meta font-medium text-ui-mute">
          Related to
        </div>
        <ul
          ref={rightListRef}
          aria-labelledby="related-repos-right"
          className="max-h-72 space-y-0.5 overflow-auto rounded-ui bg-ui-surface p-1"
          onMouseLeave={() => setHovered(null)}
        >
          {members.map((m) => {
            const on = draft.includes(m.id);
            const was = stored.includes(m.id);
            const why = blocked(m.id);
            const note =
              why === 'self'
                ? 'this repo'
                : why === 'full'
                  ? `already has ${RELATED_REPOS_MAX_PER_REPO}`
                  : on && !was
                    ? 'to add'
                    : !on && was
                      ? 'to remove'
                      : null;
            return (
              <li key={m.id} ref={setRow(rightRows.current, m.id)}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={why != null}
                  onClick={() => onToggle(m.id)}
                  onMouseEnter={() => setHovered(m.id)}
                  onFocus={() => setHovered(m.id)}
                  onBlur={() => setHovered(null)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-ui px-2.5 py-1.5 text-left text-body touch:py-2.5',
                    'motion-safe:transition-colors motion-safe:duration-ui-fast',
                    why === 'self'
                      ? 'cursor-not-allowed text-ui-mute opacity-50'
                      : why === 'full' || why === 'cap'
                        ? 'cursor-not-allowed text-ui-mute'
                        : on
                          ? cx('text-ui-ink', hovered === m.id ? 'bg-ui-hover' : 'bg-ui-raise')
                          : cx('text-ui-mute hover:bg-ui-hover hover:text-ui-ink', hovered === m.id && 'bg-ui-hover text-ui-ink'),
                    FOCUS_RING,
                  )}
                >
                  <RepoName fullName={m.fullName} hideOwner={hideOwner} />
                  {note != null && (
                    <span
                      className={cx('ml-auto shrink-0 text-meta', note === 'to add' ? 'text-ui-accent' : 'text-ui-mute')}
                    >
                      {note}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {geo != null && (
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {geo.curves.length > 0 && (
            <circle
              cx={geo.from.x}
              cy={geo.from.y}
              r={3}
              className={cx('fill-current text-ui-accent', geo.fromOutside && 'opacity-40')}
            />
          )}
          {geo.curves.map((c) => {
            const on = draft.includes(c.id);
            const was = stored.includes(c.id);
            const adding = on && !was;
            const removing = !on && was;
            const isHover = hovered === c.id;
            const dimmed = (hoverDrawn && !isHover) || c.outside || geo.fromOutside;
            const d = curvePath(geo.from, c.to);
            return (
              <g
                key={c.id}
                className={cx(
                  'motion-safe:transition-opacity motion-safe:duration-ui-fast',
                  removing ? 'text-ui-mute' : 'text-ui-accent',
                  removing ? (isHover ? 'opacity-70' : 'opacity-30') : dimmed ? 'opacity-30' : 'opacity-100',
                )}
              >
                <path
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={isHover ? 2.25 : 1.5}
                  strokeLinecap="round"
                  strokeDasharray={adding || removing ? '4 3' : undefined}
                />
                <path d={arrowHeadPath(c.to)} className="fill-current" />
                {/* A wider, invisible stroke so a curve is easy to hover. */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={10}
                  className="pointer-events-auto"
                  onMouseEnter={() => setHovered(c.id)}
                  onMouseLeave={() => setHovered(null)}
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ── THE STACKED CHECKLIST (a phone) ─────────────────────────────────────────────────────────────

function StackedChecklist({
  members,
  current,
  onSelect,
  draft,
  blocked,
  onToggle,
}: {
  members: Member[];
  current: number | null;
  onSelect: (id: number) => void;
  draft: number[];
  blocked: (id: number) => Blocked;
  onToggle: (id: number) => void;
}): JSX.Element {
  return (
    <>
      <div className="flex flex-col items-start gap-1 text-body">
        <span className="text-meta font-medium text-ui-mute">Repo</span>
        <Select
          label="Repo"
          className="w-full"
          value={current != null ? String(current) : null}
          onChange={(v) => onSelect(Number(v))}
          options={members.map((r) => ({ value: String(r.id), label: r.fullName }))}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-meta font-medium text-ui-mute">Related to</div>
        <div className="max-h-52 space-y-1 overflow-auto rounded-ui bg-ui-surface p-2.5">
          {members
            .filter((r) => r.id !== current)
            .map((r) => {
              const on = draft.includes(r.id);
              const why = blocked(r.id);
              const full = why === 'full';
              return (
                <label key={r.id} className="flex items-center gap-2 text-body touch:py-1">
                  <CheckInput checked={on} disabled={why != null} onChange={() => onToggle(r.id)} />
                  <span className="truncate text-ui-ink">{r.fullName}</span>
                  {full && (
                    <span className="shrink-0 text-meta text-ui-mute">already has {RELATED_REPOS_MAX_PER_REPO}</span>
                  )}
                </label>
              );
            })}
        </div>
      </div>
    </>
  );
}
