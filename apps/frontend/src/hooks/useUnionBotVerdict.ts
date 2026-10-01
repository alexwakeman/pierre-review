import { useMemo } from 'react';
import type { User } from '@pierre-review/shared';
import { makeUnionBotVerdict, type UnionBotVerdict } from '../lib/unionBot.js';
import { useDetectedReviewers } from './useBotTriage.js';

// The union bot verdict (lib/unionBot.ts) for ONE workspace — pass the PR's OWN workspace
// (`Repo.workspaceId` of its repo), never the selected one.
//
// It reads the workspace's reviewer listing through the SHARED, un-narrowed
// `useDetectedReviewers(workspaceId, null)` key (FeedView / useBotColors keep it warm), so it
// usually costs no request. `enabled: false` issues none at all — the Timeline passes it on the
// shared board, which has the server's own union filter and must not pay for this one.
//
// While the listing is loading (or disabled) the verdict is the wire `User.isBot` alone, which is
// the server's workspace-free half of the same union.
export function useUnionBotVerdict(
  workspaceId: number | null,
  usersById: ReadonlyMap<number, User>,
  enabled: boolean,
): UnionBotVerdict {
  const { data } = useDetectedReviewers(workspaceId, null, enabled && workspaceId != null);
  const reviewers = enabled ? data?.reviewers : undefined;
  return useMemo(() => makeUnionBotVerdict(reviewers, usersById), [reviewers, usersById]);
}
