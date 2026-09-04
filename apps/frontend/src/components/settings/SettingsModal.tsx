import { useEffect } from 'react';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { useHasProWorkspaceSettings, useProSettings } from '../../hooks/useProSettings.js';
import { SprintSection } from './SprintSection.js';
import { SlackSection } from './SlackSection.js';
import { IssueLinksSection } from './IssueLinksSection.js';
import { BenchmarkConsentSection } from './BenchmarkConsentSection.js';
import { LargePrThresholdSection } from './LargePrThresholdSection.js';
import { PendingMuteSection } from './PendingMuteSection.js';
import { GithubAppInstallSection } from './GithubAppInstallSection.js';
import { YourDataSection } from './YourDataSection.js';
import { useSettingsWorkspace } from './workspaceScope.js';
import { CloseIcon } from '../Icons.js';

// User configuration modal, opened from the header avatar menu. Mirrors HelpModal's shell
// (fixed overlay + role=dialog card + capture-phase Escape so a dismiss doesn't reach the global
// keyboard hook).
//
// ── THE MODAL IS TWO HALVES, SPLIT BY GRAIN, AND THE SPLIT IS THE LAYOUT ──────────────────────
// GLOBAL FIRST, then ONE "Workspace" heading and everything scoped beneath it. Before this, the
// two grains were interleaved — an account key, then cloud account sections, then a per-workspace
// cadence, then an account-wide bot toggle, then two more per-workspace sections — and a reader
// had to know each section's grain to know what a Save would touch. Nothing announced it except
// each section repeating "— acme-web" in its own heading, which is the same fact three times and
// still says nothing about the ones that DON'T carry it.
//
// The heading is therefore load-bearing, not decoration: it is the ONLY thing telling the reader
// which team they are retuning (there is no workspace picker in Settings — the rail's selection is
// the scope), and by being a boundary rather than a suffix it also says which settings are NOT a
// team's. Sections below it dropped the name from their titles; they keep it only in a sentence
// that names a DIFFERENT workspace (see SlackSection's cap disclosure).
//
// ⚠ THE ORDER IS THE GRAIN, BUT THE GATES ARE UNCHANGED — a reorder that quietly widened one would
// be a much worse bug than the confusion it fixed. Global half: GitHub App / benchmark consent /
// your data stay CLOUD-ONLY; the large-PR threshold stays ungated in both modes on every tier.
// Workspace half: the Pending mute is CORE/free, then `workspaceInsights` / `slackDigest` /
// `issueLinks` exactly as before.
//
// ⚠ THE GLOBAL HALF SITS ABOVE THE pro_settings LOADING GATE AND MUST STAY THERE. Every section in
// it reads /api/me or /api/auth/providers, never `pro_settings` — which 404s with no plugin — so an
// OSS install still gets its large-PR threshold, and a cloud account still gets export/delete, when
// the Pro fetch fails outright. Anything moved above that gate must be independent of it; anything
// moved below it waits on a request it does not need.
//
// ⚠ THE WORKSPACE HALF NOW HAS A FREE SECTION IN IT, AND SPLITTING ITS GATE WAS A CORRECTNESS FIX,
// NOT A LAYOUT CHANGE. The half used to be ONE `hasWorkspaceSections` gate (three PAID caps) with
// a `proReady` wait inside it, so a free per-workspace control literally could not be mounted
// here: with no plugin the heading never rendered, and with a plugin present it would still have
// waited on `/api/pro/settings` — a request it does not read and that 404s in OSS mode. That is
// the same defect the global half was built to avoid, one grain over. So:
//   • the HEADING renders whenever the SCOPE has resolved — there is always at least one free
//     workspace section under it (the Pending mute), exactly as the large-PR threshold is what
//     keeps the global half from ever being empty;
//   • `proReady` now wraps ONLY the Pro sections, and its "unavailable" line speaks for them alone.
// `scopeReady` still holds back the WHOLE half: nothing workspace-scoped may render OR be written
// against an unresolved id.
//
// ── TWO SECTIONS WERE DELETED HERE, NEITHER SHOULD RETURN ────────────────────────────────────
// "Anthropic API key" — the BYO key stored in `~/.pierre-review/config.json` is RETIRED. Local
// Claude Review resolves an ambient Claude session first (so a subscription pays) and otherwise
// the environment's `ANTHROPIC_API_KEY`; both rungs are already reported by the review tab's own
// auth line, so a form here could only offer a third, worse one. The routes are gone too.
//
// "Review bots (account-wide)" — an explainer plus one toggle. The explainer pointed at
// Activity → Bots → Settings, which is where a bot's judgement, identity and price actually live
// (one CORE/free `workspace_reviewers` row each), and the toggle — the Slack bot digest — became a
// property of the DELIVERY in plugin migration 0033 and is now a checkbox inside the Slack section
// under the schedule it modifies. An empty section pointing elsewhere is a signpost, not a setting.
export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const caps = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';
  // ⚠ THE FETCH IS STILL HERE, AND IT IS NOW PURELY A GATE. No section reads account
  // `ProSettings` any more — the comparison-window mode was the last one and moved to the
  // workspace row in plugin migration 0032. What it still buys is the CONNECTIVITY answer the
  // Workspace half's PAID sections depend on: with no plugin (or a plugin that fails to bind) this
  // 404s, and they render one honest "unavailable" line instead of three sections each
  // discovering it separately. Keep it enabled only when there is a paid section to gate.
  //
  // ⚠ IT IS THE PRO INVENTORY ONLY, AND IT NO LONGER GATES THE HEADING. The free Pending-mute
  // section lives under the same heading and must not wait on this request — see the note above.
  const hasWorkspaceSections = useHasProWorkspaceSettings();
  const proSettings = useProSettings(hasWorkspaceSections);
  // ⚠ `workspaceId === null` MEANS "NOT RESOLVED YET", NOT "NONE". Nothing scoped may render
  // against it and nothing may be WRITTEN against it — a PUT with no `?workspace=` is answered by
  // the account's DEFAULT workspace, so a save fired during resolution lands on a team the user
  // never opened. The whole half waits here, in ONE place, rather than three sections each
  // rendering their own pending shell under a heading that cannot yet name anybody.
  const { workspaceId, name } = useSettingsWorkspace();

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

  const proReady = proSettings.data != null;
  const scopeReady = workspaceId != null;

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
          {/* ── GLOBAL. One account, every workspace. Nothing here reads pro_settings. ────── */}
          {/* GitHub App install — CORE/free, cloud-only. Signing in via the App does NOT install
              it, and the install link otherwise lives only on the signed-out SignInGate, so a
              signed-in user has no other route to it. Self-gates on the App provider being
              configured. */}
          {isCloud && <GithubAppInstallSection />}
          {/* Cross-org benchmark consent — CORE/free, cloud-only, a plain /api/me flag. */}
          {isCloud && <BenchmarkConsentSection />}
          {/* Large-PR threshold — CORE/free and in BOTH modes (no `isCloud` gate: an
              `npx pierre-review` user gets the flag, so they get its setting). ⚠ It is the reason
              this modal is never empty on any tier, which is what lets the Pro half be gated
              without gating the modal itself. */}
          <LargePrThresholdSection />
          {/* Data-subject rights (export / delete / cookie choice) — CORE/free, cloud-only. This
              is the self-service machinery the privacy policy at /privacy §9 points at; a local
              install has no hosted account to erase (the data is the user's own SQLite file), so
              the backend refuses it there and the section is hidden rather than 400-ing. */}
          {isCloud && <YourDataSection />}

          {/* ── WORKSPACE. One team — the one selected in the rail — named ONCE, here. ────── */}
          {/* The half carries no rule of its own: `SectionShell` already draws one under the last
              global section (there is always at least one — the large-PR threshold), and a second
              line 16px below it reads as a rendering glitch rather than a boundary. The heading
              and its scope sentence are what mark the half. */}
          {/* ⚠ THE HEADING IS NOT GATED ON A CAPABILITY. There is always at least one free
              workspace-scoped section beneath it (the Pending mute), so a heading over nothing is
              not reachable — the same guarantee `LargePrThresholdSection` gives the global half.
              It IS gated on the scope resolving, below. */}
          <section className="pt-1">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Workspace
                {name != null && (
                  <>
                    {' · '}
                    <span className="text-sky-600 dark:text-sky-400">{name}</span>
                  </>
                )}
              </h3>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                Everything below applies to{' '}
                <span className="font-medium">{name ?? 'the selected workspace'}</span> alone —
                every other workspace keeps its own. Switch workspace in the rail to configure a
                different one.
              </p>
            </div>

            {/* ⚠ THE SCOPE STILL HOLDS THE WHOLE HALF BACK, AS ONE. Nothing workspace-scoped
                may render against an unresolved id, and every section below would otherwise
                render its own pending shell — several "Loading this workspace's settings…"
                boxes under a heading that cannot yet name anybody reads as several broken
                sections rather than one unfinished request. */}
            {!scopeReady ? (
              <p className="py-4 text-center text-xs text-gray-400">
                Loading this workspace’s settings…
              </p>
            ) : (
              <div className="space-y-4">
                {/* Pending mute — CORE/free, both modes, every tier, and deliberately ABOVE the
                    pro-settings gate for the same reason the large-PR threshold sits above it in
                    the global half: it reads `/api/workspaces`, never `pro_settings`, so it must
                    not wait on a request that 404s with no plugin. It is also what makes this
                    heading non-empty on `npx pierre-review`. */}
                <PendingMuteSection />
                {/* ⚠ ONLY THE PAID SECTIONS WAIT ON THE PLUGIN, and this line speaks for them
                    alone — it used to speak for the whole half, which is precisely why a free
                    section could not live here. */}
                {hasWorkspaceSections && !proReady && (
                  <p className="py-2 text-center text-xs text-gray-400">
                    {proSettings.isError
                      ? 'Workspace settings unavailable.'
                      : 'Loading this workspace’s settings…'}
                  </p>
                )}
                {/* The sprint grid for THIS workspace: cadence, phase anchor, and — since
                    plugin migration 0032 — the comparison-window mode that composes with them.
                    One grain, one Save. */}
                {proReady && caps.workspaceInsights && <SprintSection />}
                {/* The Slack digest for THIS workspace (`/api/pro/slack/target?workspace=`),
                    schedule and content together: the "Review bots" block is a field on the same
                    row (plugin migration 0033). ⚠ IT USED TO EDIT THE ACCOUNT'S WHOLE SELECTION
                    — a multi-select plus an "apply this webhook to all" button — so a Save could
                    add, or by omission silently cancel, deliveries for teams the reader was not
                    looking at. One row now. The cap disclosure stayed: with no picker there is no
                    screen listing every delivery, and each one is a billed report on every
                    send. */}
                {proReady && caps.slackDigest && <SlackSection />}
                {/* The Jira/Linear tracker for THIS workspace, on the same row as the cadence.
                    It was an ACCOUNT setting until plugin migration 0031, which never matched the
                    feature: the enricher's input is a PR, and a PR's repo belongs to exactly one
                    workspace. */}
                {proReady && caps.issueLinks && <IssueLinksSection />}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
