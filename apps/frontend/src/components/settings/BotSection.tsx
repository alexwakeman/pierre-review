import { useState } from 'react';
import { NO_TEAM_KEY } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useDetectedReviewers } from '../../hooks/useBotTriage.js';
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
// per-bot cost, and the Slack bot digest. Gated in SettingsModal on caps.botTriage (true whenever
// the plugin is loaded — so this stays FREE, no paid flag); the Slack-digest toggle additionally
// needs caps.slackDigest.
//
// The per-reviewer CLASSIFICATION table moved OUT of here to the Bots rail's per-TEAM "Settings"
// tab (Activity → Bots → Settings), because teams define bots differently — one org's
// `githubactions[bot]` funnels an AI reviewer, another's is plain CI. What stayed is everything
// that is genuinely account-level: a bot costs the same whichever team's repos it reviews (and
// cost is keyed by LOGIN, so the ROI cost overlay still works per team), detection heuristics are
// global policy, and Limn attribution is about Limn's own posted reviews.
//
// The split, in one sentence: "who is a bot HERE" is per team; "what it costs, how we detect it,
// how we attribute it" is per account.
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

  // Per-BOT cost group (keyed by reviewer login, so in-house bots are costed individually).
  const [cost, setCost] = useState<{ login: string; monthlyUsd: number }[]>(b.cost);
  const costDirty = JSON.stringify(cost) !== JSON.stringify(b.cost);
  // The detected automated reviewers drive the per-bot picker (login → display label). PINNED to
  // NO_TEAM_KEY explicitly: cost is account-level, so its options must be the account default, not
  // whichever team's tab happened to be viewed last (which is what an implicit key would give).
  const { data: detected } = useDetectedReviewers(NO_TEAM_KEY);
  const bots = (detected?.reviewers ?? []).filter((r) => r.classification.automated);
  const botLabel = (login: string): string => {
    const r = bots.find((x) => x.login === login);
    return r ? r.classification.label?.trim() || r.displayName?.trim() || r.login : login;
  };
  const firstUnusedLogin = (): string =>
    bots.find((r) => !cost.some((c) => c.login === r.login))?.login ?? '';

  // Slack bot digest (only meaningful when the account has a Slack digest configured).
  const [slackDigest, setSlackDigest] = useState<boolean>(b.slackDigest);
  const slackDirty = slackDigest !== b.slackDigest;

  return (
    <div data-testid="bot-settings-section" className="space-y-4">
      <p className="rounded border border-gray-200 bg-gray-50 px-2.5 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400">
        These settings are <span className="font-medium">account-wide</span>. Deciding{' '}
        <span className="font-medium">who counts as a review bot</span> — and which reviewers are
        quality checks rather than reviewers — is per <span className="font-medium">team</span>,
        and lives in <span className="font-medium">Activity → Bots → Settings</span>.
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

      <SectionShell
        title="Per-bot cost (account-wide)"
        desc="Optional monthly spend per bot (each in-house bot separately), used to show cost-per-acted-on in the Bot ROI panel. Keyed by login, so one bot has one cost even if teams classify it differently. Stays on your account."
      >
        {cost.length === 0 ? (
          <p className="text-[11px] text-gray-400">No costs entered.</p>
        ) : (
          <ul className="space-y-1.5">
            {cost.map((c, i) => {
              // Options: every detected bot, plus this row's own login if it's no longer detected
              // (so an existing entry never silently loses its selection).
              const options: { login: string }[] = bots.some((r) => r.login === c.login)
                ? bots
                : [{ login: c.login }, ...bots];
              return (
                <li key={i} className="flex items-center gap-2">
                  <select
                    className={`${inputCls} w-auto`}
                    value={c.login}
                    onChange={(e) =>
                      setCost((prev) =>
                        prev.map((row, j) => (j === i ? { ...row, login: e.target.value } : row)),
                      )
                    }
                    aria-label="Bot"
                  >
                    {options.map((r) => (
                      <option key={r.login} value={r.login}>
                        {botLabel(r.login)}
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
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={firstUnusedLogin() === ''}
            onClick={() => {
              const login = firstUnusedLogin();
              if (login !== '') setCost((prev) => [...prev, { login, monthlyUsd: 0 }]);
            }}
            className="rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            title={firstUnusedLogin() === '' ? 'No more detected bots to add' : 'Add a per-bot cost'}
          >
            Add bot cost
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
