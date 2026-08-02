import { useState } from 'react';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

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

// The ACCOUNT-WIDE "Review bots" settings surface (data-testid="bot-settings-section"): the
// pro_settings-backed knobs only — in-house detection toggles + login allowlist, Limn attribution,
// and the Slack bot digest. Gated in SettingsModal on caps.botTriage (true whenever the plugin is
// loaded — so this stays FREE, no paid flag); the Slack-digest toggle additionally needs
// caps.slackDigest.
//
// EVERYTHING ABOUT AN INDIVIDUAL BOT moved OUT of here to the Bots rail's "Settings" tab
// (Activity → Bots → Settings), where one card per bot carries its whole configuration:
//   • whether it counts as an automated reviewer at all, and whether it is REVIEWING or
//     QUALITY-CHECKING — Workspaces define bots differently (one Workspace's `githubactions[bot]`
//     funnels an AI reviewer, another's is plain CI);
//   • WHO it is (vendor kind + display label);
//   • WHAT IT COSTS.
// All three are columns on one CORE `workspace_reviewers` row keyed (account, WORKSPACE, actor),
// so all three are free/OSS and all three are edited in one place.
//
// The standalone cost editor that used to sit here — with its own add-a-login dropdown — is gone;
// `ProSettingsUpdate.bots.cost` no longer exists, so there is no write path to the legacy blob.
// `ProSettings.bots.cost` survives only as a deprecated READ that BotRoiPanel uses to fill in a
// login no migration could attach to a reviewer row. Retire both one release on.
//
// The split, in one sentence: "is this login a bot, who is it, and what does it cost" is per
// WORKSPACE, and "how we detect bots at all and how we attribute our own reviews" — the knobs
// below — is per account.
export function BotSection({ settings, save, saving }: SectionProps): JSX.Element {
  const caps = useProCapabilities();
  const b = settings.bots;

  // Detection group.
  const [inhouseDetect, setInhouse] = useState<boolean>(b.inhouseDetect);
  const [autoTag, setAutoTag] = useState<boolean>(b.autoTagHighConfidence);
  const [deepDetect, setDeep] = useState<boolean>(b.deepDetect);
  const [aiTiebreak, setAiTiebreak] = useState<boolean>(b.aiTiebreak);
  const [allowlist, setAllowlist] = useState<string>(b.loginAllowlist.join('\n'));
  const parsedAllowlist = allowlist
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const detectionDirty =
    inhouseDetect !== b.inhouseDetect ||
    autoTag !== b.autoTagHighConfidence ||
    deepDetect !== b.deepDetect ||
    aiTiebreak !== b.aiTiebreak ||
    parsedAllowlist.join('\n') !== b.loginAllowlist.join('\n');

  // Pierre attribution group.
  const [tagPierre, setTagPierre] = useState<boolean>(b.tagPierreReviews);
  const [pierreFooter, setPierreFooter] = useState<boolean>(b.pierreFooter);
  const pierreDirty = tagPierre !== b.tagPierreReviews || pierreFooter !== b.pierreFooter;

  // (No cost group here any more — a price is a per-WORKSPACE column on the bot's own row, edited
  // inline on its card in Activity → Bots → Settings. The old editor's unscoped
  // `useDetectedReviewers()` fetch went with it, which is just as well: there is no account-wide
  // reviewer roster to fetch any more.)

  // Slack bot digest (only meaningful when the account has a Slack digest configured).
  const [slackDigest, setSlackDigest] = useState<boolean>(b.slackDigest);
  const slackDirty = slackDigest !== b.slackDigest;

  return (
    <div data-testid="bot-settings-section" className="space-y-4">
      <p className="rounded border border-gray-200 bg-gray-50 px-2.5 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400">
        These settings are <span className="font-medium">account-wide</span>. Deciding{' '}
        <span className="font-medium">who counts as a review bot</span> — which reviewers are
        quality checks rather than reviewers, who each bot is, and{' '}
        <span className="font-medium">what each bot costs</span> — is per{' '}
        <span className="font-medium">Workspace</span>, and lives in{' '}
        <span className="font-medium">Activity → Bots → Settings</span>.
      </p>

      <SectionShell
        title="Detection (account-wide)"
        desc="How we recognise automated reviewers beyond the known vendors — your own in-house AI reviewer or CI service accounts."
      >
        <Toggle
          label="Detect in-house / service-account reviewers"
          hint="Fingerprint branded review markers and behaviour to flag your own automation."
          checked={inhouseDetect}
          onChange={setInhouse}
        />
        <Toggle
          label="Auto-tag high-confidence matches"
          hint="Badge a reviewer automatically when detection is high-confidence (medium always asks first)."
          checked={autoTag}
          onChange={setAutoTag}
        />
        <Toggle
          label="Deep detect (app attribution)"
          hint="Off by default — an extra REST lookup during sync to read GitHub App attribution."
          checked={deepDetect}
          onChange={setDeep}
        />
        <Toggle
          label="AI tie-break (opt-in)"
          hint="For medium-confidence cases only, one cheap model call per reviewer to decide. Costs a little; off by default."
          checked={aiTiebreak}
          onChange={setAiTiebreak}
        />
        <Field
          label="Login allowlist"
          hint="One login or glob per line (e.g. acme-ci, *-bot). Always treated as automated."
        >
          <textarea
            className={`${inputCls} min-h-[3rem] font-mono`}
            value={allowlist}
            placeholder={'acme-ci\n*-svc'}
            onChange={(e) => setAllowlist(e.target.value)}
          />
        </Field>
        <SaveButton
          dirty={detectionDirty}
          saving={saving}
          onClick={() =>
            save({
              bots: {
                inhouseDetect,
                autoTagHighConfidence: autoTag,
                deepDetect,
                aiTiebreak,
                loginAllowlist: parsedAllowlist,
              },
            })
          }
        />
      </SectionShell>

      <SectionShell title="Limn attribution (account-wide)" desc="How Limn's own Claude reviews are stamped when posted.">
        <Toggle
          label="Tag Limn reviews"
          hint="Append a hidden marker so Limn-posted reviews are recognised as its own (verbatim vs curated)."
          checked={tagPierre}
          onChange={setTagPierre}
        />
        <Toggle
          label="Visible footer"
          hint={'Also append a visible "Reviewed with Limn + Claude" footer to posted reviews.'}
          checked={pierreFooter}
          onChange={setPierreFooter}
        />
        <SaveButton
          dirty={pierreDirty}
          saving={saving}
          onClick={() => save({ bots: { tagPierreReviews: tagPierre, pierreFooter } })}
        />
      </SectionShell>

      {/* The "Per-bot cost (account-wide)" section that used to sit here — a list of
          login+dollars rows with its own add-a-login dropdown, saved via the now-removed
          `ProSettingsUpdate.bots.cost` — is GONE. Cost is per WORKSPACE and edited inline on each
          bot's card in Activity → Bots → Settings, on the same row that already answers "is this a
          bot here, and who is it". Do not reinstate an account-wide editor beside it: two live
          writers to one price is how the two silently disagree, which is why the update field was
          retired rather than mirrored — and an account-wide one could no longer even name the row
          it would be writing. */}

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
