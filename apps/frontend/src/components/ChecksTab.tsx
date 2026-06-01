import type { PrDetail as PrDetailT, ReviewState, User } from '@gh-team-monitor/shared';
import {
  CHECK_STATE_META,
  CI_META,
  mergeWarning,
  relativeTime,
} from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { UserName } from './UserName.js';

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-1.5 text-sm">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ChecksTab({
  pr,
  usersById,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
}): JSX.Element {
  const ci = CI_META[pr.ciStatus];
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  const checks = pr.checkRuns;
  const counts = checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});

  // A reviewer's standing decision is their LATEST decisive review: an approval
  // is superseded once they later request changes or it gets dismissed.
  // 'commented'/'pending' reviews don't change a standing decision, so we skip
  // them. pr.reviews is chronological (submittedAt asc), so a later decisive
  // review overwrites — approvers are authors whose latest decision is 'approved'.
  const latestDecision = new Map<number, ReviewState>();
  for (const r of pr.reviews) {
    if (
      r.authorId == null ||
      (r.state !== 'approved' && r.state !== 'changes_requested' && r.state !== 'dismissed')
    ) {
      continue;
    }
    latestDecision.set(r.authorId, r.state);
  }
  const approverIds = [...latestDecision]
    .filter(([, state]) => state === 'approved')
    .map(([id]) => id);

  return (
    <div className="divide-y divide-gray-100 py-1 dark:divide-gray-800">
      <Row label="CI">
        {ci ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: ci.color }}
            />
            {ci.label}
            {checks.length > 0 && (
              <span className="text-xs text-gray-400">
                ·{' '}
                {[
                  counts.success ? `${counts.success} passed` : null,
                  counts.failure ? `${counts.failure} failed` : null,
                  counts.pending ? `${counts.pending} running` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">no checks reported</span>
        )}
      </Row>

      <Row label="Mergeable">
        {warn ? (
          <span className="font-medium text-orange-500">⚠ {warn}</span>
        ) : pr.mergeable === 'mergeable' ? (
          <span className="text-green-500">clean</span>
        ) : (
          <span className="text-gray-400">{pr.mergeStateStatus}</span>
        )}
      </Row>

      {pr.mergedById != null && (
        <Row label="Merged by">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Avatar user={usersById.get(pr.mergedById)} size={14} />
            <UserName
              user={usersById.get(pr.mergedById)}
              fallbackId={pr.mergedById}
              repoId={pr.repoId}
            />
          </span>
        </Row>
      )}

      {checks.length > 0 && (
        <Row label="Checks">
          <ul className="space-y-1">
            {checks.map((c, i) => {
              const m = CHECK_STATE_META[c.state];
              const inner = (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: m.color }}
                    title={m.label}
                  >
                    {m.icon}
                  </span>
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-gray-400">
                    {m.label}
                  </span>
                </span>
              );
              return (
                <li key={`${c.name}-${i}`} className="text-xs">
                  {c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div className="px-1 py-0.5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Row>
      )}

      {pr.labels.length > 0 && (
        <Row label="Labels">
          <div className="flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <span
                key={l.name}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                style={{ borderColor: `#${l.color}` }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: `#${l.color}` }}
                />
                {l.name}
              </span>
            ))}
          </div>
        </Row>
      )}

      {approverIds.length > 0 && (
        <Row label="Approvers">
          <div className="flex flex-wrap gap-2 text-xs">
            {approverIds.map((uid) => {
              const u = usersById.get(uid);
              return (
                <span
                  key={uid}
                  className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-green-700 dark:text-green-400"
                  title="Approved this PR"
                >
                  <span className="text-green-600 dark:text-green-500">✓</span>
                  <Avatar user={u} size={14} />
                  <UserName user={u} fallbackId={uid} repoId={pr.repoId} />
                </span>
              );
            })}
          </div>
        </Row>
      )}

      {pr.requestedReviewers.length > 0 && (
        <Row label="Reviewers">
          <div className="flex flex-wrap gap-2 text-xs">
            {pr.requestedReviewers.map((r, i) => (
              <span key={i} className="rounded bg-gray-500/10 px-1.5 py-0.5">
                {r.teamName ? (
                  `@${r.teamName}`
                ) : (
                  <UserName
                    user={r.userId != null ? usersById.get(r.userId) : undefined}
                    fallbackId={r.userId}
                    repoId={pr.repoId}
                  />
                )}
              </span>
            ))}
          </div>
        </Row>
      )}

      <Row label="Meta">
        <div className="space-y-0.5 text-xs text-gray-500">
          <div>{pr.repoFullName}</div>
          <div>opened {relativeTime(pr.openedAt)}</div>
          <div>updated {relativeTime(pr.updatedAt)}</div>
        </div>
      </Row>
    </div>
  );
}
