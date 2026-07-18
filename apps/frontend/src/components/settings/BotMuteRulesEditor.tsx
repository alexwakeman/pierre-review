import { useState } from 'react';
import type { AutomatedReviewerKind, BotMuteAction } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import { useAddBotMuteRule, useBotMuteRules, useDeleteBotMuteRule } from '../../hooks/useBotTriage.js';
import {
  useProSettings,
  useHasProSettings,
  useUpdateProSettings,
} from '../../hooks/useProSettings.js';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];

const vendorLabel = (kind: AutomatedReviewerKind | null): string =>
  kind == null ? 'Any bot' : automatedReviewerMeta(kind).label;

// The master "standing auto-resolve" default lives in pro_settings (plugin-backed), so it's a
// separate inner component that only mounts once the settings have loaded — its useState can
// then initialise straight from server truth (no undefined-then-populate flicker).
function MasterAutoResolve({ settings, save, saving }: SectionProps): JSX.Element {
  const b = settings.bots;
  const [autoResolve, setAutoResolve] = useState<boolean>(b.autoResolve);
  const [autoResolveDays, setAutoResolveDays] = useState<number>(b.autoResolveDays);
  const masterDirty = autoResolve !== b.autoResolve || autoResolveDays !== b.autoResolveDays;
  return (
    // Kept on ONE baseline row (inline labels, items-center) so every control lines up and the
    // Save button sits with them.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
        <span className="font-medium text-gray-700 dark:text-gray-200">Enable standing auto-resolve</span>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
        <span>Older than</span>
        <input
          type="number"
          min={1}
          max={90}
          className={`${inputCls} w-16`}
          value={autoResolveDays}
          onChange={(e) => setAutoResolveDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
        />
        <span>days</span>
      </label>
      <SaveButton dirty={masterDirty} saving={saving} onClick={() => save({ bots: { autoResolve, autoResolveDays } })} />
    </div>
  );
}

// Mute & auto-triage rules (CORE, deterministic). A rule matches automated-bot threads by
// vendor × path glob × severity and either HIDES them from the feed or, under the master
// auto-resolve toggle, resolves `likely_addressed` threads older than N days on a cron. The
// master switch + day count live in pro_settings (bots.autoResolve/autoResolveDays); the rules
// themselves are the CORE /api/bot-mute-rules resource.
export function BotMuteRulesEditor(): JSX.Element {
  const rulesQ = useBotMuteRules();
  const addRule = useAddBotMuteRule();
  const delRule = useDeleteBotMuteRule();
  // The mute-rule CRUD below is fully CORE (works on npx/OSS). Only the master auto-resolve
  // default is pro_settings-backed, so fetch it only when the plugin is present.
  const hasPro = useHasProSettings();
  const settingsQ = useProSettings(hasPro);
  const update = useUpdateProSettings();

  const [vendorKind, setVendorKind] = useState<'any' | AutomatedReviewerKind>('any');
  const [pathGlob, setPathGlob] = useState<string>('');
  const [severity, setSeverity] = useState<string>('');
  const [action, setAction] = useState<BotMuteAction>('hide');
  const [days, setDays] = useState<number>(7);

  const submit = (): void => {
    addRule.mutate(
      {
        vendorKind: vendorKind === 'any' ? null : vendorKind,
        pathGlob: pathGlob.trim() === '' ? null : pathGlob.trim(),
        severity: severity.trim() === '' ? null : severity.trim(),
        action,
        autoResolveDays: action === 'auto_resolve' ? Math.min(90, Math.max(1, days)) : null,
      },
      {
        onSuccess: () => {
          setPathGlob('');
          setSeverity('');
        },
      },
    );
  };

  const rules = rulesQ.data?.rules ?? [];

  return (
    <SectionShell
      title="Mute & auto-triage rules"
      desc="Hide low-value bot threads, or (with auto-resolve on) let a background job resolve likely-addressed bot threads older than a threshold. Auto-resolve only ever touches likely-addressed threads and never merges."
    >
      {/* Master auto-resolve default (pro_settings-backed) — shown only when the plugin is
          loaded. Everything below is CORE and always renders. */}
      {settingsQ.data != null && (
        <MasterAutoResolve
          settings={settingsQ.data}
          save={(patch) => update.mutate(patch)}
          saving={update.isPending}
        />
      )}

      <div className="mt-1 space-y-1">
        {rulesQ.isLoading ? (
          <p className="py-2 text-center text-[11px] text-gray-400">Loading rules…</p>
        ) : rules.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-gray-400">No rules yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                <span className="font-medium text-gray-700 dark:text-gray-200">{vendorLabel(rule.vendorKind)}</span>
                <span className="text-gray-400">{rule.pathGlob ?? 'any path'}</span>
                <span className="text-gray-400">{rule.severity ?? 'any severity'}</span>
                <span
                  className={`ml-auto rounded px-1.5 py-0.5 font-medium ${
                    rule.action === 'auto_resolve'
                      ? 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300'
                  }`}
                >
                  {rule.action === 'auto_resolve' ? `Auto-resolve · ${rule.autoResolveDays ?? '?'}d` : 'Hide'}
                </span>
                <button
                  type="button"
                  disabled={delRule.isPending}
                  onClick={() => delRule.mutate(rule.id)}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-40"
                  aria-label="Delete rule"
                  title="Delete rule"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add-rule form. The fields sit in a uniform label-above grid (each control fills its
          cell, so labels + inputs line up), with the action button on its OWN right-aligned row
          — so nothing floats out of baseline regardless of how many fields wrap. */}
      <div className="space-y-2.5 rounded border border-dashed border-gray-200 p-2.5 dark:border-gray-700">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Field label="Vendor">
            <select
              className={inputCls}
              value={vendorKind}
              onChange={(e) => setVendorKind(e.target.value as 'any' | AutomatedReviewerKind)}
            >
              <option value="any">Any bot</option>
              {ALL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {automatedReviewerMeta(k).label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Path glob">
            <input className={inputCls} value={pathGlob} placeholder="e.g. tests/**" onChange={(e) => setPathGlob(e.target.value)} />
          </Field>
          <Field label="Severity">
            <input className={inputCls} value={severity} placeholder="e.g. nitpick" onChange={(e) => setSeverity(e.target.value)} />
          </Field>
          <Field label="Action">
            <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value as BotMuteAction)}>
              <option value="hide">Hide</option>
              <option value="auto_resolve">Auto-resolve</option>
            </select>
          </Field>
          {action === 'auto_resolve' && (
            <Field label="Days">
              <input
                type="number"
                min={1}
                max={90}
                className={inputCls}
                value={days}
                onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
              />
            </Field>
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={addRule.isPending}
            onClick={submit}
            className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-40"
          >
            {addRule.isPending ? 'Adding…' : 'Add rule'}
          </button>
        </div>
      </div>
      {(addRule.isError || delRule.isError) && (
        <p className="text-[11px] text-red-500">{((addRule.error ?? delRule.error) as Error)?.message}</p>
      )}
    </SectionShell>
  );
}
