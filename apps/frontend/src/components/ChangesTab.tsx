import { useMemo, useState } from 'react';
import type { PrDetail, PrFileChange, PrFileDiff } from '@pierre-review/shared';
import { useAddReviewComment } from '../hooks/usePrWrites.js';
import { usePrFiles } from '../hooks/usePr.js';
import { ApiError } from '../api/client.js';
import { parsePatch, patchLineCount, type DiffRow } from '../lib/diff.js';

// ---- collapse-by-default heuristic ----
// A file starts collapsed when it has no renderable patch (binary / too large) or
// the patch is big enough that auto-expanding it would flood the pane.
const LARGE_PATCH_LINES = 250;
const LARGE_CHANGED_LINES = 400;

function startsCollapsed(file: PrFileDiff): boolean {
  if (file.patch == null) return true;
  if (patchLineCount(file.patch) > LARGE_PATCH_LINES) return true;
  if (file.additions + file.deletions > LARGE_CHANGED_LINES) return true;
  return false;
}

const STATUS_META: Record<
  PrFileDiff['status'],
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

// ---- a single diff row, optionally commentable ----

// Which side/line an inline comment on this row anchors to. Added + context rows
// comment on the RIGHT (the new file) using newLine; removed rows comment on the
// LEFT (the old file) using oldLine. Hunk headers + the "no newline" annotation
// aren't commentable.
function commentTarget(row: DiffRow): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (row.kind === 'add' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'context' && row.newLine != null) return { line: row.newLine, side: 'RIGHT' };
  if (row.kind === 'del' && row.oldLine != null) return { line: row.oldLine, side: 'LEFT' };
  return null;
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
  prId,
  open,
  onOpen,
  onClose,
}: {
  row: DiffRow;
  filePath: string;
  fileUrl: string;
  prId: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element {
  const target = commentTarget(row);
  // Strip the leading +/-/space marker from add/del/context rows for display; show
  // hunk headers verbatim.
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
            {target && !open && (
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
      {open && target && (
        <tr>
          <td colSpan={4} className="px-2 py-1.5">
            <InlineCommentBox
              prId={prId}
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

// ---- inline comment composer (feature 5) ----

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
  fileUrl: string;
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
            // Couldn't place it in the diff — leave the box open with guidance.
            setNotice({
              text: "Couldn't place this comment in the diff — open it on GitHub instead.",
              url: fileUrl,
              tone: 'warn',
            });
            return;
          }
          // Posted. Keep the box open and confirm the outcome (no global toast /
          // no auto-refresh until the next sync) so the action isn't silent and a
          // duplicate re-click is avoided. setBody('') disables Send.
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
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
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

// ---- one collapsible file block ----

function FileDiffBlock({ file, prId }: { file: PrFileDiff; prId: number }): JSX.Element {
  const [expanded, setExpanded] = useState(() => !startsCollapsed(file));
  // The row whose inline comment box is open (keyed by row index), at most one
  // per file at a time.
  const [openRow, setOpenRow] = useState<number | null>(null);
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  const meta = STATUS_META[file.status];
  const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;

  return (
    <div>
      {/* The file header is `sticky` to the Changes-tab scroll container: as you scroll
          through a file's diff, its name stays pinned to the top of the pane and is
          pushed up — and replaced — by the next file's header. Needs an opaque
          background so the diff rows scrolling underneath don't show through, and a
          z-index above the diff table. */}
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
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
          <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
        </span>
        <a
          href={file.githubUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 text-blue-500 hover:underline"
          title="View this file's diff on GitHub"
        >
          ↗
        </a>
      </div>

      {expanded && (
        <div className="border-b border-gray-100 dark:border-gray-800">
          {file.patch == null ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              Diff is too large or binary —{' '}
              <a
                href={file.githubUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-500 hover:underline"
              >
                view on GitHub ↗
              </a>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              No textual diff for this file.
            </div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
              <tbody>
                {rows.map((row, i) => (
                  <DiffLine
                    key={i}
                    row={row}
                    filePath={file.path}
                    fileUrl={file.githubUrl}
                    prId={prId}
                    open={openRow === i}
                    onOpen={() => setOpenRow(i)}
                    onClose={() => setOpenRow(null)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---- fallback metadata row (when patches aren't available) ----

function MetaFileRow({ file }: { file: PrFileChange }): JSX.Element {
  const segments = file.path.split('/');
  const fileName = segments.at(-1);
  const dir = segments.slice(0, -1).join('/');
  return (
    <a
      href={file.githubUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="group flex items-center gap-3 px-4 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
      title={`${file.path} — view this file's diff on GitHub`}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs">
        {dir && <span className="text-gray-400">{dir}/</span>}
        <span className="font-semibold">{fileName}</span>
      </code>
      <span className="shrink-0 font-mono text-xs tabular-nums">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
        <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
      </span>
      <span className="shrink-0 text-gray-300 group-hover:text-blue-500 dark:text-gray-600">
        ↗
      </span>
    </a>
  );
}

function Header({ pr, extra }: { pr: PrDetail; extra?: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-800">
      <span className="font-semibold text-gray-600 dark:text-gray-300">
        {pr.changedFilesCount} file{pr.changedFilesCount === 1 ? '' : 's'} changed
      </span>
      <span className="text-green-600 dark:text-green-400">
        +{pr.additions.toLocaleString()}
      </span>
      <span className="text-red-500 dark:text-red-400">
        −{pr.deletions.toLocaleString()}
      </span>
      {extra}
      <a
        href={`${pr.githubUrl}/files`}
        target="_blank"
        rel="noreferrer noopener"
        className="ml-auto text-blue-500 hover:underline"
      >
        Files changed ↗
      </a>
    </div>
  );
}

// The "Changes" tab: every file the PR touches with its inline diff hunks and
// per-line review-comment affordances. Patches are hydrated on demand
// (usePrFiles); on a miss we fall back to the lean metadata file list so the tab
// still shows what changed plus the per-file/whole-PR GitHub links.
export function ChangesTab({ pr }: { pr: PrDetail }): JSX.Element {
  const { data, isLoading, isError } = usePrFiles(pr.id);

  // No changes at all on this PR — same empty state as before.
  if (pr.files.length === 0 && pr.changedFilesCount === 0 && !isLoading) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500">
        No file changes on this PR.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div>
        <Header pr={pr} />
        <div className="px-3 py-6 text-center text-sm text-gray-500">
          Loading diff…
        </div>
      </div>
    );
  }

  const files = data?.files ?? [];
  const havePatches = !isError && files.length > 0;

  // Fallback: no patches came back but the PR has changed files — show the lean
  // metadata list (per-file links) + a note, keeping the GitHub deep-links.
  if (!havePatches) {
    return (
      <div>
        <Header pr={pr} />
        <div className="px-4 py-2 text-xs text-gray-400">
          {isError
            ? 'The full diff couldn’t be loaded — showing the changed-file list.'
            : 'Inline diffs aren’t available for this PR — showing the changed-file list.'}{' '}
          <a
            href={`${pr.githubUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            View on GitHub ↗
          </a>
        </div>
        {pr.files.length > 0 && (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {pr.files.map((f) => (
              <MetaFileRow key={f.path} file={f} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <Header pr={pr} />
      {/* No divide-y: each file's (sticky) header carries its own bottom border, so
          divider lines would double up — and a sticky element scrolling over a
          divide-y border looks broken. */}
      <div>
        {files.map((f) => (
          <FileDiffBlock key={f.path} file={f} prId={pr.id} />
        ))}
      </div>
      {data?.truncated && (
        <div className="px-4 py-2 text-xs text-gray-400">
          Large diff — not all files are shown.{' '}
          <a
            href={`${pr.githubUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            View all on GitHub ↗
          </a>
        </div>
      )}
    </div>
  );
}
