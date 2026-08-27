import { useEffect } from 'react';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { useProSettings, useUpdateProSettings } from '../../hooks/useProSettings.js';
import type { ProSettingsUpdate } from '@pierre-review/shared';
import { SprintSection } from './SprintSection.js';
import { SlackSection } from './SlackSection.js';
import { IssueLinksSection } from './IssueLinksSection.js';
import { BotSection } from './BotSection.js';
import { AnthropicKeySection } from './AnthropicKeySection.js';
import { BenchmarkConsentSection } from './BenchmarkConsentSection.js';
import { GithubAppInstallSection } from './GithubAppInstallSection.js';
import { YourDataSection } from './YourDataSection.js';
import { CloseIcon } from '../Icons.js';

// User configuration modal, opened from the header avatar menu. Mirrors HelpModal's shell
// (fixed overlay + role=dialog card + capture-phase Escape so a dismiss doesn't reach the global
// keyboard hook). All sections are Pro; each renders only when its capability is on. Every
// section reads/writes the per-account pro_settings via /api/pro/settings.
export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const caps = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';
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
            <CloseIcon size={14} />
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
          {/* GitHub App install — CORE/free, cloud-only. Signing in via the App does NOT install
              it, and the install link otherwise lives only on the signed-out SignInGate, so a
              signed-in user has no other route to it. Self-gates on the App provider being
              configured; independent of pro_settings, so it sits above the loading gate. */}
          {isCloud && <GithubAppInstallSection />}
          {/* Cross-org benchmark consent — CORE/free, cloud-only, independent of pro_settings
              (a plain /api/me flag), so it renders above the pro-settings loading gate. */}
          {isCloud && <BenchmarkConsentSection />}
          {/* Data-subject rights (export / delete / cookie choice) — CORE/free, cloud-only. This
              is the self-service machinery the privacy policy at /privacy §9 points at; a local
              install has no hosted account to erase (the data is the user's own SQLite file), so
              the backend refuses it there and the section is hidden rather than 400-ing. */}
          {isCloud && <YourDataSection />}
          {query.isLoading || settings == null ? (
            <p className="py-6 text-center text-xs text-gray-400">
              {query.isError ? 'Settings unavailable.' : 'Loading…'}
            </p>
          ) : (
            <>
              {caps.workspaceInsights && (
                <SprintSection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {/* Review bots (ACCOUNT-WIDE) — now just the Slack bot-digest toggle, which
                  additionally self-gates on caps.slackDigest. pro_settings-backed, hence the
                  caps.botTriage gate: botTriage is FREE (true whenever the plugin is loaded, even
                  with the paid PRO_* flags off), but with no plugin there are no pro_settings to
                  edit.
                  Configuring an INDIVIDUAL BOT — is it automated, is it reviewing or
                  quality-checking, who is it, what does it cost — is deliberately NOT here: it is a
                  per-WORKSPACE fact and lives on the CORE Bots rail tab, which needs no plugin.
                  That also closed a real gap: an `npx pierre-review` (OSS, plugin-absent) user could
                  not classify a reviewer at all while this gate was the only way in.
                  The two account-wide sections that used to sit here — "Detection" (in-house
                  detection toggles + login allowlist) and "Limn attribution" (hidden marker +
                  visible footer) — were REMOVED. Detection had zero production consumers (no
                  `classifyReviewer` call site ever read the allowlist or the tie-break flag, and
                  core structurally cannot read plugin tables), and the marker is now stamped
                  unconditionally in `review/post-seam.ts` because the Bot-ROI "Limn · Claude" row
                  depends on it — a toggle that silently disabled a whole analytics lane. */}
              {caps.botTriage && (
                <BotSection settings={settings} save={save} saving={mutation.isPending} />
              )}
              {caps.slackDigest && (
                <SlackSection settings={settings} save={save} saving={mutation.isPending} />
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
