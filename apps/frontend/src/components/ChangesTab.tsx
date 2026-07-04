import type { PrDetail, PrFileChange } from '@pierre-review/shared';
import { usePrFiles } from '../hooks/usePr.js';
import { FileDiffView } from './diff/FileDiffView.js';

// The "Changes" tab: every file the PR touches with its inline diff hunks and per-line
// review-comment affordances. The per-file rendering lives in the shared FileDiffView
// (also used, read-only, by the AI Fix tab); this file owns the data plumbing, the
// summary header, and the lean metadata fallback. Patches are hydrated on demand
// (usePrFiles); on a miss we fall back to the metadata file list with GitHub links.

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
      {/* No divide-y: each file's (sticky) header carries its own bottom border. */}
      <FileDiffView files={files} commenting={{ prId: pr.id }} />
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
