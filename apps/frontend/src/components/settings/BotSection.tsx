import { useState } from 'react';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { SaveButton, SectionShell, type SectionProps } from './ui.js';

// A checkbox row matching the modal's compact type scale.
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-gray-700 dark:text-gray-200">{label}</span>
        {hint != null && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </span>
    </label>
  );
}

// The ACCOUNT-WIDE "Review bots" settings surface (data-testid="bot-settings-section"). What is
// left is ONE knob — the Slack bot digest — plus the explainer that points at where a bot is
// actually configured. The shell stays even when that toggle is gated off, because
// `scripts/capture-shots.mjs` targets the test id.
//
// EVERYTHING ABOUT AN INDIVIDUAL BOT lives in the Bots rail's "Settings" tab (Activity → Bots →
// Settings), where one card per bot carries its whole configuration:
//   • whether it counts as an automated reviewer at all, and whether it is REVIEWING or
//     QUALITY-CHECKING — Workspaces define bots differently (one Workspace's `githubactions[bot]`
//     funnels an AI reviewer, another's is plain CI);
//   • WHO it is (vendor kind + display label);
//   • WHAT IT COSTS.
// All three are columns on one CORE `workspace_reviewers` row keyed (account, WORKSPACE, actor),
// so all three are free/OSS and all three are edited in one place.
//
// ── TWO SECTIONS WERE REMOVED FROM HERE, AND NEITHER SHOULD COME BACK AS A TOGGLE ─────────────
// "Detection (account-wide)" (in-house detection / auto-tag / deep detect / AI tie-break + a login
// allowlist) had ZERO production consumers: not one `classifyReviewer` call site ever passed
// `allowlist` or `enableAiTiebreak`, and CORE structurally cannot read the plugin's `pro_settings`
// table — so every one of those switches was decorative. The dead classifier branches went with it.
//
// "Limn attribution (account-wide)" gated the hidden `<!-- pierre:claude-review v=1 -->` marker,
// which is the ONLY producer of the 'pierre' AutomatedReviewerKind (Bot-ROI's "Limn · Claude" row,
// verbatim-vs-curated provenance, the bot_only_review risk flag). Turning it off silently deleted
// an analytics lane, so the marker is now stamped unconditionally in `review/post-seam.ts`. The
// visible "🤖 Reviewed with Limn + Claude" footer matched no detector at all and is simply gone.
//
// The standalone cost editor that used to sit here — with its own add-a-login dropdown — is also
// gone; `ProSettingsUpdate.bots.cost` no longer exists, so there is no write path to the legacy
// blob. `ProSettings.bots.cost` survives only as a deprecated READ that BotRoiPanel uses to fill in
// a login no migration could attach to a reviewer row. Retire both one release on.
export function BotSection({ settings, save, saving }: SectionProps): JSX.Element {
  const caps = useProCapabilities();
  const b = settings.bots;

  // Slack bot digest (only meaningful when the account has a Slack digest configured).
  const [slackDigest, setSlackDigest] = useState<boolean>(b.slackDigest);
  const slackDirty = slackDigest !== b.slackDigest;

  return (
    <div data-testid="bot-settings-section" className="space-y-4">
      <p className="rounded border border-gray-200 bg-gray-50 px-2.5 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400">
        Deciding <span className="font-medium">who counts as a review bot</span> — which reviewers
        are quality checks rather than reviewers, who each bot is, and{' '}
        <span className="font-medium">what each bot costs</span> — is per{' '}
        <span className="font-medium">Workspace</span>, and lives in{' '}
        <span className="font-medium">Activity → Bots → Settings</span>. Detection itself needs no
        configuration.
      </p>

      {caps.slackDigest && (
        <SectionShell title="Slack bot digest" desc="Include a review-bot summary block in the Slack digest.">
          <Toggle
            label="Send the review-bot block"
            hint="Adds a deterministic bots section (volume · acted-on · untouched) to the scheduled Slack digest."
            checked={slackDigest}
            onChange={setSlackDigest}
          />
          <SaveButton dirty={slackDirty} saving={saving} onClick={() => save({ bots: { slackDigest } })} />
        </SectionShell>
      )}
    </div>
  );
}
