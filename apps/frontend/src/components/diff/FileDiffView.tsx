import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PrFileDiffStatus, ThreadDetail, User } from '@pierre-review/shared';
import { useAddReviewComment } from '../../hooks/usePrWrites.js';
import { ApiError } from '../../api/client.js';
import { parsePatch, patchLineCount, type DiffRow } from '../../lib/diff.js';
import { MentionTextarea } from '../MentionTextarea.js';
import { ThreadCard } from '../ThreadView/index.js';

// The shared per-file diff renderer used by BOTH the Changes tab (with inline
// commenting) and the AI Fix tab (read-only, pre-push). Per-file collapsible blocks
// with a sticky header, line-number gutters, and the >400-line auto-collapse. Inline
// commenting + the GitHub links are OPTIONAL: the AI-Fix changeset's files don't exist
// on GitHub yet, so it passes neither. The Changes tab additionally threads unresolved
// review threads (`threadCtx`) so they render inline at their diff line, like GitHub.

// One changed file with its unified-diff patch. A superset of the Changes tab's
// PrFileDiff and the AI-Fix `parseGitPatch` output (githubUrl optional).
export interface DiffFile {
  path: string;
  previousPath?: string | null;
  status: PrFileDiffStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  githubUrl?: string | null;
}

// Unresolved review threads to render inline in the diff (Changes tab only). Threads
// carry (path, line) but no side, so we anchor to the row whose new-side (else old-side)
// line matches; a thread that matches no visible line renders as "outdated" atop its
// file. `focusThreadId` scrolls to + highlights one thread (deep-link from a card).
export interface DiffThreadContext {
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
  focusThreadId?: number | null;
  onThreadShown?: () => void;
}

// ---- collapse-by-default heuristic (GitHub-style: big files start collapsed) ----
const LARGE_PATCH_LINES = 250;
const LARGE_CHANGED_LINES = 400;

function startsCollapsed(file: DiffFile): boolean {
  if (file.patch == null) return true;
  if (patchLineCount(file.patch) > LARGE_PATCH_LINES) return true;
  if (file.additions + file.deletions > LARGE_CHANGED_LINES) return true;
  return false;
}

const STATUS_META: Record<
  PrFileDiffStatus,
  { icon: string; label: string; cls: string }
> = {
  added: { icon: 'A', label: 'added', cls: 'text-green-600 dark:text-green-400' },
  removed: { icon: 'D', label: 'removed', cls: 'text-red-500 dark:text-red-400' },
  modified: { icon: 'M', label: 'modified', cls: 'text-amber-600 dark:text-amber-400' },
  renamed: { icon: 'R', label: 'renamed', cls: 'text-sky-600 dark:text-sky-400' },
  copied: { icon: 'C', label: 'copied', cls: 'text-sky-600 dark:text-sky-400' },
  changed: { icon: 'M', label: 'changed', cls: 'text-amber-600 dark:text-amber-400' },
  unchanged: { icon: '·', label: 'unchanged', cls: 'text-gray-400' },
};

// Which side/line an inline comment on this row anchors to (Changes tab only).
function commentTarget(row: DiffRow): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (row.kind === 'add' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'context' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'del' && row.oldLine != null) return { line: row.oldLine, side: 'LEFT' };
  return null;
}

// A thread carries (path, line) but no side. Anchor it to the LAST row whose target line
// matches, preferring the new (RIGHT) side — that's where GitHub pins an inline thread.
function anchorIndexFor(rows: DiffRow[], line: number | null): number | null {
  if (line == null) return null;
  let right: number | null = null;
  let left: number | null = null;
  rows.forEach((row, i) => {
    const t = commentTarget(row);
    if (!t || t.line !== line) return;
    if (t.side === 'RIGHT') right = i;
    else left = i;
  });
  return right ?? left;
}

const ROW_BG: Record<DiffRow['kind'], string> = {
  hunk: 'bg-sky-500/5 text-sky-600 dark:text-sky-400 select-none',
  add: 'bg-green-500/10',
  del: 'bg-red-500/10',
  context: '',
};

function gutterText(n: number | undefined): string {
  return n == null ? '' : String(n);
}

function DiffLine({
  row,
  filePath,
  fileUrl,
  commenting,
  open,
  onOpen,
  onClose,
}: {
  row: DiffRow;
  filePath: string;
  // When null, inline commenting is disabled (read-only AI-Fix diff).
  fileUrl: string | null;
  commenting: { prId: number } | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element {
  const target = commenting ? commentTarget(row) : null;
  const display = row.kind === 'hunk' ? row.text : row.text.slice(1) || ' ';

  return (
    <>
      <tr className={`group ${ROW_BG[row.kind]}`}>
        <td className="w-9 select-none border-r border-gray-200 px-1 text-right align-top text-gray-400 dark:border-gray-800">
          {row.kind === 'hunk' ? '' : gutterText(row.oldLine)}
        </td>
        <td className="w-9 select-none border-r border-gray-200 px-1 text-right align-top text-gray-400 dark:border-gray-800">
          {row.kind === 'hunk' ? '' : gutterText(row.newLine)}
        </td>
        <td className="select-none px-1 align-top">
          {/* Fixed-width wrapper reserves the gutter so the +-button revealing on
              hover (via opacity, which doesn't reflow) never shifts the code. */}
          <div className="flex w-4 justify-center">
            {commenting && target && !open && (
              <button
                type="button"
                onClick={onOpen}
                title="Comment on this line"
                className="rounded bg-blue-500 px-1 text-[10px] font-bold leading-tight text-white opacity-0 transition-opacity hover:bg-blue-600 group-hover:opacity-100"
              >
                +
              </button>
            )}
          </div>
        </td>
        <td className="w-full whitespace-pre px-2 align-top">
          {row.kind !== 'hunk' && (
            <span className="select-none text-gray-400">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
          )}
          {display}
        </td>
      </tr>
      {open && commenting && target && (
        <tr>
          <td colSpan={4} className="px-2 py-1.5">
            <InlineCommentBox
              prId={commenting.prId}
              filePath={filePath}
              fileUrl={fileUrl}
              line={target.line}
              side={target.side}
              onClose={onClose}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// One inline review thread rendered inside the diff table (a full-width row). Scrolls
// itself into view + shows a persistent highlight when it's the deep-link target.
function InlineThreadRow({
  thread,
  ctx,
}: {
  thread: ThreadDetail;
  ctx: DiffThreadContext;
}): JSX.Element {
  const ref = useRef<HTMLTableRowElement>(null);
  const focused = ctx.focusThreadId != null && ctx.focusThreadId === thread.id;
  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ctx.onThreadShown?.();
    }
    // Only re-run when this row becomes the focus target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);
  return (
    <tr ref={ref}>
      <td colSpan={4} className="bg-gray-50 px-2 py-2 dark:bg-gray-900/40">
        <div
          className={`rounded font-sans ${
            focused ? 'ring-2 ring-amber-400/70' : ''
          }`}
        >
          <ThreadCard
            thread={thread}
            usersById={ctx.usersById}
            prUrl={ctx.prUrl}
            selected={focused}
          />
        </div>
      </td>
    </tr>
  );
}

function InlineCommentBox({
  prId,
  filePath,
  fileUrl,
  line,
  side,
  onClose,
}: {
  prId: number;
  filePath: string;
  fileUrl: string | null;
  line: number;
  side: 'LEFT' | 'RIGHT';
  onClose: () => void;
}): JSX.Element {
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<{
    text: string;
    url: string | null;
    tone: 'ok' | 'warn';
  } | null>(null);
  const add = useAddReviewComment(prId);

  const error =
    add.error instanceof ApiError
      ? add.error.message
      : add.error
        ? 'Failed to post the comment.'
        : null;

  const send = (): void => {
    const trimmed = body.trim();
    if (!trimmed || add.isPending) return;
    setNotice(null);
    add.mutate(
      { path: filePath, line, side, body: trimmed },
      {
        onSuccess: (result) => {
          if (result.commentId === null) {
            setNotice({
              text: "Couldn't place this comment in the diff — open it on GitHub instead.",
              url: fileUrl,
              tone: 'warn',
            });
            return;
          }
          setBody('');
          if (result.anchored === false) {
            setNotice({
              text: `Posted on the nearest changed line (${
                result.side === 'LEFT' ? 'old' : 'new'
              } line ${result.line}). It’ll appear in the Threads tab after the next sync.`,
              url: result.url,
              tone: 'warn',
            });
            return;
          }
          setNotice({
            text: 'Comment posted. It’ll appear in the Threads tab after the next sync.',
            url: result.url,
            tone: 'ok',
          });
        },
      },
    );
  };

  return (
    <div className="space-y-1 rounded border border-gray-300 bg-white p-2 font-sans dark:border-gray-700 dark:bg-gray-900">
      <div className="text-[10px] text-gray-400">
        Commenting on {side === 'LEFT' ? 'old' : 'new'} line {line}
      </div>
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus
        placeholder="Add an inline review comment (markdown)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-950"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={add.isPending || body.trim().length === 0}
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {add.isPending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => {
            setBody('');
            setNotice(null);
            add.reset();
            onClose();
          }}
          disabled={add.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {notice?.tone === 'ok' ? 'Close' : 'Cancel'}
        </button>
        {error && <span className="text-[10px] text-red-500">{error}</span>}
      </div>
      {notice && (
        <div
          className={
            notice.tone === 'ok'
              ? 'text-[10px] text-green-600 dark:text-green-400'
              : 'text-[10px] text-amber-600 dark:text-amber-400'
          }
        >
          {notice.text}
          {notice.url && (
            <>
              {' '}
              <a
                href={notice.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-500 hover:underline"
              >
                Open on GitHub ↗
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FileDiffBlock({
  file,
  commenting,
  threads,
  threadCtx,
}: {
  file: DiffFile;
  commenting: { prId: number } | null;
  threads: ThreadDetail[];
  threadCtx: DiffThreadContext | null;
}): JSX.Element {
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  // Anchor each thread to a diff row; those with no matching visible line (outdated /
  // line-less) render above the diff so they're never lost.
  const { byRow, unanchored } = useMemo(() => {
    const byRow = new Map<number, ThreadDetail[]>();
    const unanchored: ThreadDetail[] = [];
    for (const t of threads) {
      const idx = anchorIndexFor(rows, t.line);
      if (idx == null) unanchored.push(t);
      else {
        const a = byRow.get(idx) ?? [];
        a.push(t);
        byRow.set(idx, a);
      }
    }
    return { byRow, unanchored };
  }, [rows, threads]);

  const hasFocus =
    threadCtx?.focusThreadId != null && threads.some((t) => t.id === threadCtx.focusThreadId);
  // Files with threads (or the deep-link target) start expanded, mirroring GitHub.
  const [expanded, setExpanded] = useState(
    () => !startsCollapsed(file) || threads.length > 0,
  );
  useEffect(() => {
    if (hasFocus) setExpanded(true);
  }, [hasFocus]);

  const [openRow, setOpenRow] = useState<number | null>(null);
  const meta = STATUS_META[file.status];
  const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const githubUrl = file.githubUrl ?? null;

  return (
    <div>
      {/* Sticky per-file header (mirrors the Changes-tab behaviour): the name stays
          pinned as you scroll and is pushed up by the next file's header. Needs an
          opaque background + a z-index above the diff table. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-100 bg-white px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? 'Collapse this file' : 'Expand this file'}
        >
          <span className="w-3 shrink-0 select-none text-gray-400">
            {expanded ? '▾' : '▸'}
          </span>
          <span
            className={`w-3 shrink-0 select-none text-center font-mono font-bold ${meta.cls}`}
            title={meta.label}
          >
            {meta.icon}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono">{path}</code>
        </button>
        {threads.length > 0 && (
          <span
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            title={`${threads.length} unresolved thread${threads.length === 1 ? '' : 's'} on this file`}
          >
            {threads.length} 💬
          </span>
        )}
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
          <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
        </span>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-blue-500 hover:underline"
            title="View this file's diff on GitHub"
          >
            ↗
          </a>
        )}
      </div>

      {expanded && (
        <div className="border-b border-gray-100 dark:border-gray-800">
          {file.patch == null ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              {githubUrl ? (
                <>
                  Diff is too large or binary —{' '}
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-blue-500 hover:underline"
                  >
                    view on GitHub ↗
                  </a>
                </>
              ) : (
                'Binary file — no textual diff.'
              )}
              {/* Even without a textual diff, surface any threads so they aren't lost. */}
              {threadCtx && threads.length > 0 && (
                <div className="mt-2 space-y-2 text-left">
                  {threads.map((t) => (
                    <div key={t.id} className="font-sans">
                      <ThreadCard
                        thread={t}
                        usersById={threadCtx.usersById}
                        prUrl={threadCtx.prUrl}
                        selected={threadCtx.focusThreadId === t.id}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              No textual diff for this file.
            </div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
              <tbody>
                {threadCtx &&
                  unanchored.map((t) => (
                    <InlineThreadRow key={`u-${t.id}`} thread={t} ctx={threadCtx} />
                  ))}
                {rows.map((row, i) => (
                  <Fragment key={i}>
                    <DiffLine
                      row={row}
                      filePath={file.path}
                      fileUrl={githubUrl}
                      commenting={commenting}
                      open={openRow === i}
                      onOpen={() => setOpenRow(i)}
                      onClose={() => setOpenRow(null)}
                    />
                    {threadCtx &&
                      byRow.get(i)?.map((t) => (
                        <InlineThreadRow key={t.id} thread={t} ctx={threadCtx} />
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Render a list of changed files. Pass `commenting:{prId}` to enable the Changes-tab
// inline-comment affordances (omit it — AI Fix — for a read-only view), and `threadCtx`
// to render unresolved review threads inline at their diff line.
export function FileDiffView({
  files,
  commenting,
  threadCtx,
}: {
  files: DiffFile[];
  commenting?: { prId: number } | null;
  threadCtx?: DiffThreadContext | null;
}): JSX.Element {
  const threadsByPath = useMemo(() => {
    const m = new Map<string, ThreadDetail[]>();
    for (const t of threadCtx?.threads ?? []) {
      const a = m.get(t.path) ?? [];
      a.push(t);
      m.set(t.path, a);
    }
    return m;
  }, [threadCtx?.threads]);

  return (
    <div>
      {files.map((f) => (
        <FileDiffBlock
          key={f.path}
          file={f}
          commenting={commenting ?? null}
          threads={threadsByPath.get(f.path) ?? []}
          threadCtx={threadCtx ?? null}
        />
      ))}
    </div>
  );
}
