import { useState } from 'react';
import type { AutomatedReviewerKind } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { DetectedReviewersTable } from './DetectedReviewersTable.js';
import { BotMuteRulesEditor } from './BotMuteRulesEditor.js';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];

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

// WS8 — the "Review bots" control surface. One logical section (data-testid="bot-settings-section")
// composed of: detected-reviewers table (two-way override), in-house detection toggles + login
// allowlist, Pierre tagging, mute/auto-triage rules, per-vendor cost, and the Slack bot digest.
// Gated in SettingsModal on caps.teamInsights; the Slack-digest toggle additionally needs
// caps.slackDigest. Detection/rules are CORE; the panel just lives behind the Pro settings gate.
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

  // Per-vendor cost group.
  const [cost, setCost] = useState<{ kind: AutomatedReviewerKind; monthlyUsd: number }[]>(b.cost);
  const costDirty = JSON.stringify(cost) !== JSON.stringify(b.cost);
  const firstUnusedKind = (): AutomatedReviewerKind =>
    ALL_KINDS.find((k) => !cost.some((c) => c.kind === k)) ?? 'in_house';

  // Slack bot digest (only meaningful when the account has a Slack digest configured).
  const [slackDigest, setSlackDigest] = useState<boolean>(b.slackDigest);
  const slackDirty = slackDigest !== b.slackDigest;

  return (
    <div data-testid="bot-settings-section" className="space-y-4">
      <DetectedReviewersTable />

      <SectionShell
        title="Detection"
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

      <SectionShell title="Pierre attribution" desc="How Pierre's own Claude reviews are stamped when posted.">
        <Toggle
          label="Tag Pierre reviews"
          hint="Append a hidden marker so Pierre-posted reviews are recognised as its own (verbatim vs curated)."
          checked={tagPierre}
          onChange={setTagPierre}
        />
        <Toggle
          label="Visible footer"
          hint={'Also append a visible "Reviewed with Pierre + Claude" footer to posted reviews.'}
          checked={pierreFooter}
          onChange={setPierreFooter}
        />
        <SaveButton
          dirty={pierreDirty}
          saving={saving}
          onClick={() => save({ bots: { tagPierreReviews: tagPierre, pierreFooter } })}
        />
      </SectionShell>

      <BotMuteRulesEditor settings={settings} save={save} saving={saving} />

      <SectionShell
        title="Per-vendor cost"
        desc="Optional monthly spend per reviewer, used to show cost-per-acted-on in the Bot ROI panel. Stays on your account."
      >
        {cost.length === 0 ? (
          <p className="text-[11px] text-gray-400">No costs entered.</p>
        ) : (
          <ul className="space-y-1.5">
            {cost.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <select
                  className={`${inputCls} w-auto`}
                  value={c.kind}
                  onChange={(e) =>
                    setCost((prev) =>
                      prev.map((row, j) => (j === i ? { ...row, kind: e.target.value as AutomatedReviewerKind } : row)),
                    )
                  }
                  aria-label="Vendor"
                >
                  {ALL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {automatedReviewerMeta(k).label}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-gray-400">$</span>
                <input
                  type="number"
                  min={0}
                  className={`${inputCls} w-24`}
                  value={c.monthlyUsd}
                  onChange={(e) =>
                    setCost((prev) =>
                      prev.map((row, j) =>
                        j === i ? { ...row, monthlyUsd: Math.max(0, Number(e.target.value) || 0) } : row,
                      ),
                    )
                  }
                  aria-label="Monthly USD"
                />
                <span className="text-[11px] text-gray-400">/mo</span>
                <button
                  type="button"
                  onClick={() => setCost((prev) => prev.filter((_, j) => j !== i))}
                  className="ml-auto text-gray-400 hover:text-red-500"
                  aria-label="Remove"
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCost((prev) => [...prev, { kind: firstUnusedKind(), monthlyUsd: 0 }])}
            className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Add vendor cost
          </button>
          <SaveButton dirty={costDirty} saving={saving} onClick={() => save({ bots: { cost } })} />
        </div>
      </SectionShell>

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
