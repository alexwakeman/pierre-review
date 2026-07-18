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
export function useBotColors(): (bot: {
  login?: string | null;
  kind: AutomatedReviewerKind;
}) => string {
  const { data } = useDetectedReviewers();
  const colorMap = useMemo(
    () =>
      buildBotColorMap(
        (data?.reviewers ?? [])
          .filter((r) => r.classification.automated && r.classification.kind != null)
          .map((r) => ({ login: r.login, kind: r.classification.kind as AutomatedReviewerKind })),
      ),
    [data?.reviewers],
  );
  return useMemo(() => (bot) => resolveBotColor(colorMap, bot), [colorMap]);
}
