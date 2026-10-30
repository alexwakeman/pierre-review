import type { ThreadDetail, User } from '@pierre-review/shared';
import { ChevronIcon } from '../Icons.js';
import { ThreadCard } from '../ThreadView/index.js';
import { ThreadStatePill } from '../ThreadView/ClaudeThreadBadge.js';
import { ThreadCountChips, rollupCounts } from './ThreadCountChips.js';
import {
  effectiveResolved,
  forcedOpen,
  threadIsOpen,
  type ThreadCollapseState,
} from '../../lib/threadCollapse.js';

// Newest thread first (by createdAt).
function sortThreads(threads: ThreadDetail[]): ThreadDetail[] {
  return [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// The first words of the root comment, on one line — a recogniser, not a render. Bot comments
// open with a metadata line (`_Minor_ | _Quick win_`) and put the real headline in bold, so the
// first **bold** span near the top wins; otherwise HTML tags and markdown punctuation are stripped.
function snippet(thread: ThreadDetail): string {
  // Collapsible `<details>` blocks (analysis chains, prompts for agents) are never the headline.
  const body = (thread.comments[0]?.body ?? '').replace(/<details>[\s\S]*?<\/details>/gi, ' ');
  const bold = /\*\*([^*\n]{8,}?)\*\*/.exec(body.slice(0, 2000))?.[1];
  const flat = (bold ?? body)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * One file's threads. The header is a GROUPING LABEL only — files never collapse as a whole.
 * Collapse is per THREAD: a resolved thread shows as one line until clicked; every other state
 * stays open. The open/closed set is owned by ThreadList (local to this PR view, keyed by thread
 * id) and a selected thread is open, resolved or not, until a resolve collapses it
 * (lib/threadCollapse.ts).
 */
export function FileGroup({
  path,
  threads,
  usersById,
  prUrl,
  repoId,
  selectedThreadId,
  viewedSince,
  registerRef,
  openInChangesFor,
  collapse,
  onToggleResolved,
}: {
  path: string;
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selectedThreadId: number | null;
  viewedSince?: string | null;
  registerRef: (threadId: number, el: HTMLDivElement | null) => void;
  /** Per-thread "show it in the Changes tab"; null when its file has left the diff. */
  openInChangesFor?: (
    thread: ThreadDetail,
  ) => { run: () => void; approximate: boolean; line: number | null } | null;
  /** Which resolved threads are open, and local resolve verdicts awaiting the refetch. */
  collapse: ThreadCollapseState;
  onToggleResolved: (threadId: number) => void;
}): JSX.Element {
  const counts = rollupCounts(threads);
  const segments = path.split('/');
  const fileName = segments.at(-1);
  const dir = segments.slice(0, -1).join('/');

  return (
    <div className="border-b border-gray-100 dark:border-gray-800">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-meta" title={path}>
          {dir && <span className="text-gray-400">{dir}/</span>}
          <span className="font-semibold">{fileName}</span>
        </code>
        <ThreadCountChips counts={counts} />
      </div>

      <div className="space-y-2 px-3 pb-3">
        {sortThreads(threads).map((t) => {
          const selected = t.id === selectedThreadId;
          const resolved = effectiveResolved(t.derivedState === 'resolved', t.id, collapse.overrides);
          const forced = forcedOpen(selected, t.id, collapse.released);
          const open = threadIsOpen({ resolved, selected, threadId: t.id, state: collapse });
          const lineLabel = t.line != null ? `Line ${t.line}` : 'File';
          if (!open) {
            const authorId = t.comments[0]?.authorId ?? null;
            const author = authorId != null ? usersById.get(authorId) : undefined;
            return (
              <div key={t.id} ref={(el) => registerRef(t.id, el)}>
                <button
                  type="button"
                  onClick={() => onToggleResolved(t.id)}
                  aria-expanded={false}
                  className="hit flex w-full min-w-0 items-center gap-2 rounded-ui border border-ui-line px-2.5 py-1.5 text-left text-meta text-ui-mute hover:bg-ui-hover"
                >
                  <ChevronIcon dir="right" className="shrink-0 text-ui-faint" />
                  <span className="shrink-0 tabular-nums">{lineLabel}</span>
                  {author && (
                    <span className="shrink-0 font-medium text-ui-mute">
                      @{author.githubLogin}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{snippet(t)}</span>
                  {/* Claude's outcome when there is one ("Reply accepted · Resolved"), else the plain
                      state. No ⓘ: this row is itself a button. */}
                  <span className="flex shrink-0 items-center gap-1">
                    <ThreadStatePill thread={t} noInfo />
                  </span>
                </button>
              </div>
            );
          }
          return (
            <div key={t.id} ref={(el) => registerRef(t.id, el)}>
              {/* An opened resolved thread keeps a way back to one line. Not offered while
                  selection forces it open, where the control would do nothing. */}
              {resolved && !forced && (
                <button
                  type="button"
                  onClick={() => onToggleResolved(t.id)}
                  aria-expanded
                  className="hit mb-1 flex items-center gap-1 rounded-ui px-1 text-meta text-ui-mute hover:text-ui-ink"
                >
                  <ChevronIcon dir="down" className="shrink-0" />
                  Collapse
                </button>
              )}
              <ThreadCard
                thread={t}
                usersById={usersById}
                prUrl={prUrl}
                repoId={repoId}
                selected={selected}
                viewedSince={viewedSince}
                openInChanges={openInChangesFor?.(t) ?? null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
