import { useFilters } from '../../store/filters.js';
import { DetectedReviewersTable } from '../settings/DetectedReviewersTable.js';

// Bots Monitoring's "Classification" tab — **who counts as a bot in this Workspace, what
// kind of bot it is, who it is, and what it costs here**. Classification is what the Feed's and
// Timeline's bot hiding reads. It was Bots Monitoring → Settings, then the Feed's "Bot
// classification" sub-tab (a legacy `?botsTab=settings` or `?feedTab=classification` lands here).
//
// ── A BOT IS A PER-WORKSPACE OBJECT ─────────────────────────────────────────────────────────
// One `workspace_reviewers` row per (account, workspace, actor) carries ALL of it: the judgement
// (automated + role), the identity (vendor kind + display label) and the price. A vendor running
// in six of the workspace's repos is therefore ONE card, merged by GitHub handle — not six.
//
// Two provenance flags survive INSIDE that one row and are honoured independently: `source` owns
// the judgement, `identitySource` owns the identity. That separation is what still stops a "not a
// bot" click from blanking CodeRabbit's brand colour, so each card offers TWO reset controls rather
// than one. See DetectedReviewersTable, which owns the copy at the point of edit (and the
// workspace-wide blast-radius disclosure — do not add a second banner here).
export function BotSettingsPanel(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);

  return (
    <div className="space-y-3" data-testid="bot-settings-panel">
      <DetectedReviewersTable workspaceId={workspaceId} />

      {/* ⚠ THIS USED TO POINT AT "Settings → Review bots (account-wide)", WHICH NO LONGER EXISTS.
          Its three referents each ended somewhere different: detection takes no configuration at
          all (the toggles had zero production consumers and were removed), the Limn marker is
          stamped unconditionally because it is the only producer of the 'pierre' reviewer kind,
          and the Slack bot block became a field on the DELIVERY row (plugin migration 0033) — a
          checkbox inside the per-workspace Slack section. A pointer to a deleted screen is worse
          than no pointer: it sends a reader looking for a control that was never coming back. */}
      <p className="pt-2.5 text-meta text-ui-mute">
        To add a review-bot summary to a Slack digest, turn it on in{' '}
        <span className="font-medium">Settings → Workspace → Slack digest</span>.
      </p>
    </div>
  );
}
