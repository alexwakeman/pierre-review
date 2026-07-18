import { useEffect } from 'react';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useProSettings, useUpdateProSettings } from '../../hooks/useProSettings.js';
import type { ProSettingsUpdate } from '@pierre-review/shared';
import { SprintSection } from './SprintSection.js';
import { SlackSection } from './SlackSection.js';
import { AiPolicySection } from './AiPolicySection.js';
import { IssueLinksSection } from './IssueLinksSection.js';
import { BotSection } from './BotSection.js';
import { AnthropicKeySection } from './AnthropicKeySection.js';

// User configuration modal, opened from the header avatar menu. Mirrors HelpModal's shell
// (fixed overlay + role=dialog card + capture-phase Escape so a dismiss doesn't reach the global
// keyboard hook). All sections are Pro; each renders only when its capability is on. Every
// section reads/writes the per-account pro_settings via /api/pro/settings.
export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const caps = useProCapabilities();
  const query = useProSettings(true);
  const mutation = useUpdateProSettings();
  const save = (patch: ProSettingsUpdate): void => {
    mutation.mutate(patch);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const settings = query.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-[40rem] max-w-[92vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
          {mutation.isError && (
            <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-950 dark:text-red-300">
              {(mutation.error as Error).message}
            </p>
          )}
          {/* BYO Anthropic key — advanced AI only (Claude Review + AI Fix). Independent of
              pro_settings (it's a local file store), so it renders above the loading gate. */}
          {(caps.claudeReview || caps.aiFix) && <AnthropicKeySection />}
          {query.isLoading || settings == null ? (
            <p className="py-6 text-center text-xs text-gray-400">
              {query.isError ? 'Settings unavailable.' : 'Loading…'}
            </p>
          ) : (
            <>
              {caps.teamInsights && (
                <SprintSection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {/* Review bots — FREE (botTriage is true whenever the plugin is loaded, even with
                  the paid PRO_* flags off), so the bot settings stay reachable on a flag-less run. */}
              {caps.botTriage && (
                <BotSection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {caps.slackDigest && (
                <SlackSection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {caps.activityDigest && (
                <AiPolicySection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {caps.issueLinks && (
                <IssueLinksSection settings={settings} save={save} saving={mutation.isPending} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
