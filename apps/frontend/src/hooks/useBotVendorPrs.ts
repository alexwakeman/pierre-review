import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  BotVendorCommentsResponse,
  BotVendorPrsResponse,
  BotWindowKind,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// ── THE TWO HOOKS HERE GATE ON DIFFERENT FLAGS, AND THE ASYMMETRY IS THE ROUTES' ────────────────
// `useBotVendorPrs` → `…/vendor/:key/prs`, which 402s without `botDepth`: its only opener is the
// paid ROI table's PR drill-down.
// `useBotVendorComments` → `…/vendor/:key/comments`, which 402s without `botDepth || periodReports`:
// it has TWO paid owners, the ROI comments drill-down and the People report's per-bot evidence
// cards, so gating the hook on `botDepth` alone would blank evidence a Reports customer bought.
// Each hook's `enabled` mirrors its own route's predicate exactly; if one moves, move both.
//
// Gated INSIDE the hooks, not at the call sites, so a mount that outlives a live entitlement flip
// (a plan downgrade, /api/me refetching after `PRO_DIGEST_ENABLED` changes) goes quiet instead of
// polling a 402 every five minutes. Precedent: `useBotBehaviour`, useBotTriage.ts.
//
// The per-REVIEWER PR drill-down behind a Bot-ROI row (deterministic — no AI): the PRs
// one automated reviewer touched in the window (threads/comments/acted-on/untouched/bot-only),
// most-recent-bot-activity first. A heavier read than the always-loaded Bot-ROI panel, so it's
// fetched lazily — `enabled` is gated on the drill-down tab being open AND a row being selected.
// `key` is the analytics row identity (`u<userId>` | 'pierre').
//
// ⚠ IT MUST BE OPENED AT THE SAME SCOPE AS THE ROW IT CAME FROM. This list reproduces one row of
// the ROI panel, so the header label and the per-PR `botOnly` badge take the identical
// `workspaceId` + `repoIds` — one screen cannot show two contradictory bot-only answers. That is
// also why the key carries both in their own slots: the same reviewer, same window, under a
// different workspace, is a different answer.
export function useBotVendorPrs(
  workspaceId: number | null,
  key: string | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  const { botDepth } = useProCapabilities();
  const repoSlot =
    repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : 'all';
  return useQuery<BotVendorPrsResponse>({
    queryKey: ['bot-vendor-prs', key, window, workspaceKey(workspaceId), repoSlot],
    // Idle until BOTH the row identity and the workspace are in hand. `skipToken` narrows them
    // together, so neither `key as string` nor an unscoped (Default-workspace) request is writable.
    queryFn:
      key == null || workspaceId == null
        ? skipToken
        : () => api.botVendorPrs(key, window, workspaceId, repoIds),
    enabled: enabled && botDepth,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

// The COMMENTS twin of the drill-down above — same row identity, same scope contract, fetched
// lazily only while the Comments sub-view is open (`enabled`). Each row's ML label ships INLINE
// in the response, so this list never touches the per-PR label index (the rule that keeps a
// cross-PR list from becoming one request per card). Key mirrors bot-vendor-prs — ws:<id> and
// the repo slot each get their own segment — and it is a member of RECLASSIFY_INVALIDATE_KEYS:
// reclassifying a login changes both who counts and whose labels count.
export function useBotVendorComments(
  workspaceId: number | null,
  key: string | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  const { botDepth, periodReports } = useProCapabilities();
  const repoSlot =
    repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : 'all';
  return useQuery<BotVendorCommentsResponse>({
    queryKey: ['bot-vendor-comments', key, window, workspaceKey(workspaceId), repoSlot],
    queryFn:
      key == null || workspaceId == null
        ? skipToken
        : () => api.botVendorComments(key, window, workspaceId, repoIds),
    // The UNION, matching the route's own predicate — see the header. Not `botDepth` alone.
    enabled: enabled && (botDepth || periodReports),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
