import { useFilters } from '../../store/filters.js';
import { DetectedReviewersTable } from '../settings/DetectedReviewersTable.js';

// The Bots rail's "Settings" sub-tab — **who counts as a review bot in this Workspace, who each
// bot IS, and what it costs here**.
//
// ── A BOT IS A PER-WORKSPACE OBJECT ─────────────────────────────────────────────────────────
// One `workspace_reviewers` row per (account, workspace, actor) carries ALL of it: the judgement
// (automated / review vs quality_check), the identity (vendor kind + display label) and the price.
// A vendor running in six of the workspace's repos is therefore ONE row, merged by GitHub handle —
// not six. The old per-REPO grain (and before it a per-TEAM key with an inheritance chain) is gone,
// and with it the whole "which of these six rows is the real answer" question.
//
// Two provenance flags survive INSIDE that one row and are honoured independently: `source` owns
// the judgement, `identitySource` owns the identity. That separation is what still stops a "not a
// bot" click from blanking CodeRabbit's brand colour — there is no longer a table boundary to
// catch it, so each card offers TWO reset controls rather than one. See DetectedReviewersTable,
// which owns the copy at the point of edit.
//
// ── SCOPE AND BLAST RADIUS ──────────────────────────────────────────────────────────────────
// `repoId` (the per-repo Bots tab) narrows only the DISPLAY: the table fetches the whole
// workspace's listing and filters client-side to the bots with a footprint in that repo. It is
// deliberately NOT a server-side narrowing — every edit made here lands workspace-wide because it
// is literally the same row, and a card can only show that blast radius if it still carries its
// full per-repo footprint list.
//
// THE BLAST RADIUS IS STATED THREE PLACES, AND ONLY ONE OF THEM IS HERE. The subtitle below says
// it in a clause; DetectedReviewersTable owns the full disclosure (a workspace-scope banner, a
// per-repo note, and the repo chips on each card) because that is the point of edit. Do not add a
// fourth banner to this panel — a stack of three amber boxes repeating one sentence reads as
// chrome and gets ignored, which is the failure this copy exists to prevent.
export function BotSettingsPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);

  return (
    <div className="space-y-3" data-testid="bot-settings-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Who counts as a review bot in this Workspace
        </h3>
        <span className="text-[11px] text-gray-400">
          {repoId != null
            ? 'This Workspace’s bots, filtered to the ones active in this repo — edits still apply Workspace-wide.'
            : 'One card per bot — its verdict, its name and its price in this Workspace.'}
        </span>
      </div>

      {/* `repoId` is a DISPLAY filter only — the table fetches the whole Workspace's listing and
          narrows client-side, so every card keeps its full per-repo footprint (the blast radius
          the note above promises). */}
      <DetectedReviewersTable workspaceId={workspaceId} repoId={repoId} />

      {/* ⚠ THIS USED TO POINT AT "Settings → Review bots (account-wide)", WHICH NO LONGER EXISTS.
          Its three referents each ended somewhere different: detection takes no configuration at
          all (the toggles had zero production consumers and were removed), the Limn marker is
          stamped unconditionally because it is the only producer of the 'pierre' reviewer kind,
          and the Slack bot block became a field on the DELIVERY row (plugin migration 0033) — a
          checkbox inside the per-workspace Slack section. A pointer to a deleted screen is worse
          than no pointer: it sends a reader looking for a control that was never coming back. */}
      <p className="border-t border-gray-200 pt-2.5 text-[11px] text-gray-400 dark:border-gray-800">
        Bot <span className="font-medium">detection</span> needs no configuration, and Limn stamps
        its own review marker unconditionally. To put a review-bot summary into a Slack digest,
        turn it on for that workspace&apos;s delivery in{' '}
        <span className="font-medium">Settings → Workspace → Slack digest</span>.
      </p>
    </div>
  );
}
