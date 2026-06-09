import type { PrDetail, PrFileChange } from '@pierre-review/shared';

// A GitHub-style 5-block proportion bar (green = additions, red = deletions,
// grey = remainder). Any non-zero side claims at least one block so a tiny change
// is still visible.
function DiffBar({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}): JSX.Element {
  const total = additions + deletions;
  let green = 0;
  let red = 0;
  if (total > 0) {
    green = Math.max(additions > 0 ? 1 : 0, Math.round((additions / total) * 5));
    red = Math.max(deletions > 0 ? 1 : 0, Math.round((deletions / total) * 5));
    while (green + red > 5) green >= red ? green-- : red--;
  }
  const neutral = 5 - green - red;
  const blocks = [
    ...Array<string>(green).fill('bg-green-500'),
    ...Array<string>(red).fill('bg-red-500'),
    ...Array<string>(neutral).fill('bg-gray-200 dark:bg-gray-700'),
  ];
  return (
    <span className="flex shrink-0 gap-px" aria-hidden="true">
      {blocks.map((cls, i) => (
        <span key={i} className={`h-2.5 w-2.5 rounded-[1px] ${cls}`} />
      ))}
    </span>
  );
}

function FileRow({ file }: { file: PrFileChange }): JSX.Element {
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
      <DiffBar additions={file.additions} deletions={file.deletions} />
      <span className="shrink-0 text-gray-300 group-hover:text-blue-500 dark:text-gray-600">
        ↗
      </span>
    </a>
  );
}

// The "Changes" tab: every file the PR touches, each linking to its diff in the
// PR's "Files changed" view, with per-file added/removed line counts. Data comes
// from the lean PR detail (synced from GitHub's pullRequest.files connection).
export function ChangesTab({ pr }: { pr: PrDetail }): JSX.Element {
  if (pr.files.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500">
        {pr.changedFilesCount > 0 ? (
          <>
            File details aren&rsquo;t available yet — they fill in on the next sync.{' '}
            <a
              href={`${pr.githubUrl}/files`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-500 hover:underline"
            >
              View on GitHub ↗
            </a>
          </>
        ) : (
          'No file changes on this PR.'
        )}
      </div>
    );
  }

  const truncated = pr.files.length < pr.changedFilesCount;

  return (
    <div>
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
        <a
          href={`${pr.githubUrl}/files`}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto text-blue-500 hover:underline"
        >
          Files changed ↗
        </a>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {pr.files.map((f) => (
          <FileRow key={f.path} file={f} />
        ))}
      </div>
      {truncated && (
        <div className="px-4 py-2 text-xs text-gray-400">
          Showing {pr.files.length} of {pr.changedFilesCount} files (large diffs are
          capped).{' '}
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
