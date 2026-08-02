import { useMemo } from 'react';
import type { AutomatedReviewerKind } from '@pierre-review/shared';
import { useDetectedReviewers } from './useBotTriage.js';
import { buildBotColorMap, resolveBotColor } from '../lib/ui.js';

// A stable "which colour is this bot" resolver for ONE WORKSPACE (brand-aware hybrid — see
// buildBotColorMap): known vendors + Pierre keep their brand colour; every in-house / unbranded
// bot gets a DISTINCT palette colour. Backed by the CORE detected-reviewers listing
// (`['bot-reviewers', 'ws:<id>', 'all']`), so it's free wherever that query is already loaded (the
// feed, the Bots settings tab) and one shared cached fetch elsewhere. Degrades to brand-by-kind
// before the listing loads (a branded bot never flashes; an in-house bot shows the neutral gray
// until its palette hue lands).
//
// ⚠ THE MAP IS BUILT FROM THE ACTIVE WORKSPACE'S REVIEWERS, AND THE ARGUMENT IS REQUIRED.
// This hook used to be called with NO arguments, deliberately, because vendor identity lived in an
// account-wide table and there was exactly one answer per login. Identity is now a PER-WORKSPACE
// fact on the `workspace_reviewers` row, so an unscoped call resolves to whatever the server
// defaults to — and every bot on screen would be painted from some other workspace's identities,
// or lose its brand entirely. The old rule ("build from `reviewers`, never from `rows`") retired
// with the rows/reviewers split; the rule now is: BUILD FROM THE REVIEWERS OF THE ACTIVE
// WORKSPACE. `workspaceId` is a required (nullable) parameter so that is a compile error, not
// something a grep has to catch.
//
// It deliberately does NOT narrow by repo. Within a workspace a bot must be the same colour on
// every surface — the per-repo Bots tab, a feed card's vendor tag, a thread's vendor filter — so
// the listing is fetched unnarrowed (`repoIds` omitted) and every consumer shares that one warm
// entry. Colour keys on the actor WITHIN the workspace; it never keys on a repo.
export function useBotColors(workspaceId: number | null): (bot: {
  login?: string | null;
  kind: AutomatedReviewerKind;
}) => string {
  const { data } = useDetectedReviewers(workspaceId);
  const colorMap = useMemo(
    () =>
      buildBotColorMap(
        (data?.reviewers ?? [])
          // A reviewer with a null `kind` has no vendor identity in this workspace — no brand to
          // claim, and including it would let it take a palette slot from a bot that does.
          .filter((r) => r.kind != null)
          .map((r) => ({ login: r.login, kind: r.kind as AutomatedReviewerKind })),
      ),
    [data?.reviewers],
  );
  return useMemo(() => (bot) => resolveBotColor(colorMap, bot), [colorMap]);
}
