import type { ReactNode } from 'react';

// Shared layout for one My Turn entry (active or completed): a prominent action
// button on the LEFT (Done / Seen / To do), the content to its right with the main
// text emphasised over repo/file metadata, and the relative time beneath it.
export function MyTurnRow({
  onOpen,
  onAction,
  actionLabel,
  actionTitle,
  actionPending = false,
  time,
  title,
  meta,
  sub,
}: {
  onOpen: () => void;
  onAction: () => void;
  actionLabel: string;
  actionTitle?: string;
  actionPending?: boolean;
  // Relative time string, shown under the content.
  time: string;
  // Prominent main content (PR title / thread excerpt).
  title: ReactNode;
  // Dim metadata under the title (repo #num · file).
  meta?: ReactNode;
  // Optional extra line (e.g. the new-activity summary), styled by the caller.
  sub?: ReactNode;
}): JSX.Element {
  return (
    <li className="flex items-start gap-2 rounded px-1.5 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-900/40">
      <button
        type="button"
        onClick={onAction}
        disabled={actionPending}
        title={actionTitle}
        className="shrink-0 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:border-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        {actionLabel}
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className="block w-full min-w-0 text-left"
        >
          <div className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
            {title}
          </div>
          {meta != null && (
            <div className="mt-0.5 truncate text-xs text-gray-400">{meta}</div>
          )}
          {sub != null && <div className="mt-0.5 truncate text-[11px]">{sub}</div>}
        </button>
        <div className="mt-0.5 text-[11px] text-gray-400">{time}</div>
      </div>
    </li>
  );
}
