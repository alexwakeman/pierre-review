import { useState } from 'react';
import { parsePostedLimnFinding, type PrDetail as PrDetailT, type ThreadDetail, type User } from '@pierre-review/shared';
import { dateTime, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { cx, FOCUS_RING } from '../ui/index.js';
import { ChevronIcon, ExternalLinkIcon } from '../Icons.js';

/**
 * A RESOLVED THREAD on the Activity tab (docs/FRONTEND.md § PrDetail tabs): the thread COLLAPSED to one
 * heading — where it is, its first line, how many replies — styled like the tab's comment card. It is
 * deliberately light: collapsed it renders plain text only (no Markdown, no reactions, no diff), and the
 * comments' Markdown mounts only when the reader opens it, so a PR with many resolved threads stays cheap.
 * The full thread (code, replies, actions) is one click away on the Threads tab.
 */

/** The thread's heading: a Limn finding's title, else the first line of its first comment, as plain text. Pure. */
export function threadHeading(t: Pick<ThreadDetail, 'comments'>): string {
  const body = t.comments[0]?.body ?? '';
  // A Limn finding: its title, without the severity lead line.
  const finding = /<!-- pierre:claude-review-finding\b/.test(body) ? parsePostedLimnFinding(body) : null;
  const line =
    finding?.title ??
    (body
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !/^```/.test(l)) ??
      '');
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+|^>\s*|^[-*+]\s+/, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .trim();
}

export function ResolvedThreadCard({
  pr,
  thread,
  resolver,
  resolverLogin,
  at,
  usersById,
  flashing,
  onShowInThreads,
}: {
  pr: PrDetailT;
  thread: ThreadDetail;
  /** The resolver as a known user, when the login matches one. */
  resolver: User | undefined;
  resolverLogin: string | null;
  at: string;
  usersById: Map<number, User>;
  flashing: boolean;
  onShowInThreads?: (threadId: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const heading = threadHeading(thread) || 'Review thread';
  const where = `${thread.path}${thread.line != null ? `:${thread.line}` : ''}`;
  const replies = Math.max(0, thread.comments.length - 1);
  const href = thread.url != null ? safeExternalUrl(thread.url) : null;
  return (
    <div className={cx('rounded-ui bg-ui-surface px-3 py-2', flashing && 'activity-flash')} data-testid="activity-resolved-thread">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ui-mute">
        {resolver ? (
          <>
            <Avatar user={resolver} size={18} />
            <UserName user={resolver} fallbackId={resolver.id} repoId={pr.repoId} className="font-medium text-ui-ink" />
          </>
        ) : resolverLogin ? (
          <span className="font-medium text-ui-ink">@{resolverLogin}</span>
        ) : null}
        <span>{resolverLogin || resolver ? 'resolved a thread' : 'Thread resolved'}</span>
        <span className="whitespace-nowrap text-ui-faint" title={dateTime(at)}>
          {relativeTime(at)}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide the thread' : 'Show the thread'}
          title={open ? 'Hide the thread' : 'Show the thread'}
          className={cx('hit ml-auto inline-flex h-6 w-6 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10', FOCUS_RING)}
        >
          <ChevronIcon dir={open ? 'up' : 'down'} size={12} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cx('mt-1.5 block w-full min-w-0 rounded-ui text-left', FOCUS_RING)}
        data-testid="activity-resolved-heading"
      >
        <span className="block truncate text-body text-ui-ink" title={heading}>
          {heading}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-ui-mute">
          <code className="min-w-0 truncate font-mono" title={where}>
            {where}
          </code>
          {replies > 0 && <span className="shrink-0">· {replies === 1 ? '1 reply' : `${replies} replies`}</span>}
        </span>
      </button>
      {open && (
        <>
          <ol className="mt-2 space-y-2 border-l border-ui-line pl-3" data-testid="activity-resolved-comments">
            {thread.comments.map((c) => {
              const u = c.authorId != null ? usersById.get(c.authorId) : undefined;
              return (
                <li key={c.id}>
                  <div className="flex items-center gap-1.5 text-meta text-ui-mute">
                    <Avatar user={u} size={16} />
                    <UserName user={u} fallbackId={c.authorId} repoId={pr.repoId} className="font-medium text-ui-ink" />
                    <span className="whitespace-nowrap text-ui-faint" title={dateTime(c.createdAt)}>
                      {relativeTime(c.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-body">
                    <Markdown>{c.body}</Markdown>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta">
            {onShowInThreads && (
              <button type="button" onClick={() => onShowInThreads(thread.id)} className="text-ui-ink hover:underline touch:min-h-10">
                Show in Threads
              </button>
            )}
            {href != null && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-ui-ink hover:underline text-link-phone touch:min-h-10"
              >
                <ExternalLinkIcon size={11} />
                View on GitHub
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
