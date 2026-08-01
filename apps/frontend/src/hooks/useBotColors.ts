import { useMemo } from 'react';
import type { AutomatedReviewerKind } from '@pierre-review/shared';
import { useDetectedReviewers } from './useBotTriage.js';
import { buildBotColorMap, resolveBotColor } from '../lib/ui.js';

// A stable, account-wide "which colour is this bot" resolver (brand-aware hybrid — see
// buildBotColorMap): known vendors + Pierre keep their brand colour; every in-house / unbranded
// bot gets a DISTINCT palette colour. Backed by the CORE detected-reviewers roster
// (`['bot-reviewers']`), so it's free wherever that query is already loaded (the feed, settings)
// and one shared cached fetch elsewhere. Because the map is built from the whole account roster
// (not the bots in one view), a given bot resolves to the SAME colour across every surface + the
// per-repo Bots tab. Degrades to brand-by-kind before the roster loads (a branded bot never
// flashes; an in-house bot shows the neutral gray until its palette hue lands).
//
// ⚠ COLOUR AND VENDOR NAME KEY ON THE ACTOR, NEVER ON A REPO ROW. `kind` is served ONCE per actor
// on `ReviewerIdentity` (from `account_reviewers`) precisely so this map has one answer per login.
// The bug that shaped this: when `kind` sat on the per-repo rows, marking CodeRabbit "not a bot"
// in ONE repo nulled that row's kind, identity resolution picked the edited row as the winner,
// this filter (`kind != null`) dropped the login, and CodeRabbit rendered as an unbranded gray
// in `api` and `infra` — repos the user never touched. So: build from `data.reviewers` (the actor
// grain). NEVER rebuild this from `data.rows`, and never scope the query to a repo — one bot must
// not be orange in one repo and blue in the next.
//
// The hook is called with NO arguments on purpose: the unscoped listing is the account-wide
// roster, and it is the same cache entry FeedView and ThreadList read.
export function useBotColors(): (bot: {
  login?: string | null;
  kind: AutomatedReviewerKind;
}) => string {
  const { data } = useDetectedReviewers();
  const colorMap = useMemo(
    () =>
      buildBotColorMap(
        (data?.reviewers ?? [])
          // An identity with a null `kind` is an actor that is automated in no repo (or whose
          // vendor nobody has named) — it has no brand to claim, and including it would let it
          // take a palette slot from a bot that does.
          .filter((r) => r.kind != null)
          .map((r) => ({ login: r.login, kind: r.kind as AutomatedReviewerKind })),
      ),
    [data?.reviewers],
  );
  return useMemo(() => (bot) => resolveBotColor(colorMap, bot), [colorMap]);
}
