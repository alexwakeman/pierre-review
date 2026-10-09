import { useFilters } from '../../store/filters.js';
import { DetectedReviewersTable } from '../settings/DetectedReviewersTable.js';

// The Feed rail's "Bot classification" sub-tab — **who counts as a bot in this Workspace, what
// kind of bot it is, and who it is** (plus, with `botDepth`, what it costs here). FREE on every
// tier, both modes: classification is what the Feed's and Timeline's bot hiding reads, so an
// `npx` install must be able to correct it. It used to be Bots Monitoring → Settings; it moved
// here when Bots Monitoring went Pro as a whole (a legacy `?botsTab=settings` lands here).
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
      <p className="border-t border-gray-200 pt-2.5 text-[12px] text-gray-500 dark:text-gray-400 dark:border-gray-800">
        To add a review-bot summary to a Slack digest, turn it on in{' '}
        <span className="font-medium">Settings → Workspace → Slack digest</span>.
      </p>
    </div>
  );
}
