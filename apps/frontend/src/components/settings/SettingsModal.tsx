import { useEffect } from 'react';
import { useMe } from '../../hooks/useTriage.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { SprintSection } from './SprintSection.js';
import { SlackSection } from './SlackSection.js';
import { IssueLinksSection, ISSUE_TRACKER_SECTION_HEADING_ID } from './IssueLinksSection.js';
import { AutoReviewSection } from './AutoReviewSection.js';
import { LargePrThresholdSection } from './LargePrThresholdSection.js';
import { BlastRadiusSection } from './BlastRadiusSection.js';
import { MyTurnSection, MY_TURN_SECTION_HEADING_ID } from './MyTurnSection.js';
import { BotScoringSection } from './BotScoringSection.js';
import { ClaudeSpendSection, CLAUDE_SPEND_SECTION_HEADING_ID } from './ClaudeSpendSection.js';
import { PendingMuteSection } from './PendingMuteSection.js';
import { DependencyAutoMergeSection } from './DependencyAutoMergeSection.js';
import { SonarSection } from './SonarSection.js';
import { ReferenceDocsSection } from './ReferenceDocsSection.js';
import { FlowSettingsSection } from './FlowSettingsSection.js';
import { useSettingsWorkspace } from './workspaceScope.js';
import { CloseIcon } from '../Icons.js';
import { escapeOwnedByControl } from '../../lib/escapeOwner.js';
import { closeActivePopover } from '../../lib/activePopover.js';
import { focusReturner } from '../../lib/focusReturn.js';
import type { SettingsFocus } from '../../store/settingsModal.js';

// User configuration modal, opened from the header avatar menu. Mirrors HelpModal's shell
// (fixed overlay + role=dialog card + capture-phase Escape so a dismiss doesn't reach the global
// keyboard hook).
//
// ── THE MODAL IS TWO HALVES, SPLIT BY GRAIN, AND THE SPLIT IS THE LAYOUT ──────────────────────
// GLOBAL FIRST, then ONE "Workspace" heading and everything scoped beneath it. Before this, the
// two grains were interleaved — an account key, then account sections, then a per-workspace
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
// ⚠ THE ORDER IS THE GRAIN. Global half first. Workspace half: every section reads its own
// workspace row, so none of them waits on another's request.
//
// `scopeReady` holds back the WHOLE workspace half: nothing workspace-scoped may render OR be
// written against an unresolved id.
//
// ── TWO SECTIONS WERE DELETED HERE, NEITHER SHOULD RETURN ────────────────────────────────────
// "Anthropic API key" — the BYO key stored in `~/.pierre-review/config.json` is RETIRED. Local
// Claude Review resolves an ambient Claude session first (so a subscription pays) and otherwise
// the environment's `ANTHROPIC_API_KEY`; both rungs are already reported by the review tab's own
// auth line, so a form here could only offer a third, worse one. The routes are gone too.
//
// "Review bots (account-wide)" — an explainer plus one toggle. The explainer pointed at
// Activity → Feed → Bot classification, which is where a bot's judgement, identity and price actually live
// (one CORE/free `workspace_reviewers` row each), and the toggle — the Slack bot digest — became a
// property of the DELIVERY in plugin migration 0033 and is now a checkbox inside the Slack section
// under the schedule it modifies. An empty section pointing elsewhere is a signpost, not a setting.
export function SettingsModal({
  focus = null,
  onClose,
}: {
  /** A section to land on — Pending's "Customise" link opens straight to My Turn. */
  focus?: SettingsFocus | null;
  onClose: () => void;
}): JSX.Element {
  const aiEnabled = useAiCapabilities().enabled;
  // ⚠ `workspaceId === null` MEANS "NOT RESOLVED YET", NOT "NONE". Nothing scoped may render
  // against it and nothing may be WRITTEN against it — a PUT with no `?workspace=` is answered by
  // the account's DEFAULT workspace, so a save fired during resolution lands on a team the user
  // never opened. The whole half waits here, in ONE place, rather than three sections each
  // rendering their own pending shell under a heading that cannot yet name anybody.
  const { workspaceId, name } = useSettingsWorkspace();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // An open control inside the modal (the time-zone list) owns this Escape: it closes itself
      // and the modal stays. Capture on window runs before the control's own handler, so this
      // must step aside.
      if (escapeOwnedByControl(e.target)) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // ON OPEN, THREE THINGS, ONCE:
  //  • close any board popover still open (lib/activePopover.ts) — opened with Enter on "Customise"
  //    or on the avatar menu, the modal makes no outside press, so a Pending "i" or a pinned chart
  //    popover stayed drawn ABOVE it (z-[60]) and took its first Escape;
  //  • land on the section the opener asked for: scroll it to the top of the modal and move keyboard
  //    focus to its heading, so a keyboard reader starts where the link said they would — one frame
  //    later, so the section has laid out, and never again (the modal never re-scrolls under the
  //    reader);
  //  • ON CLOSE, hand focus back to what opened it. Moving focus in and dropping it on <body> on the
  //    way out left a keyboard reader at the top of the page instead of on the Pending board.
  //    Captured before the rAF moves it; skipped when the opener is gone (the avatar menu unmounts).
  useEffect(() => {
    closeActivePopover();
    const returnFocus = focusReturner(document.activeElement, document.body);
    // The issue tracker's heading appears only once its own GET answers (a pending shell renders
    // first), and on a cold cache or a slow local server that can take seconds. So the landing WAITS
    // for the heading for as long as the modal is open (a DOM observer, no polling), and gives up the
    // moment the reader does anything themselves — a late jump must never yank someone mid-scroll.
    const headingId =
      focus === 'my-turn'
        ? MY_TURN_SECTION_HEADING_ID
        : focus === 'issue-tracker'
          ? ISSUE_TRACKER_SECTION_HEADING_ID
          : focus === 'claude-spend'
            ? CLAUDE_SPEND_SECTION_HEADING_ID
            : null;
    let raf: number | null = null;
    let observer: MutationObserver | null = null;
    const INTERACTIONS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    const stopWaiting = (): void => {
      observer?.disconnect();
      observer = null;
      for (const ev of INTERACTIONS) window.removeEventListener(ev, stopWaiting, true);
    };
    const land = (): boolean => {
      if (headingId == null) return true;
      const heading = document.getElementById(headingId);
      if (heading == null) return false;
      stopWaiting();
      heading.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
      return true;
    };
    if (headingId != null) {
      // One frame first, so a section that is already there has laid out.
      raf = requestAnimationFrame(() => {
        raf = null;
        if (land()) return;
        observer = new MutationObserver(() => {
          if (raf == null) {
            raf = requestAnimationFrame(() => {
              raf = null;
              land();
            });
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        for (const ev of INTERACTIONS) window.addEventListener(ev, stopWaiting, { capture: true, passive: true });
      });
    }
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      stopWaiting();
      returnFocus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {/* ── GLOBAL. One account, every workspace. ─────────────────────────────────────── */}
          {/* Large-PR threshold. */}
          <LargePrThresholdSection />
          {/* Blast radius — /api/me-backed like the section above it. */}
          <BlastRadiusSection />
          {/* My Turn — which card types count as your turn, their order, and the ranking weights.
              Account-grained and /api/me-backed like the two above it. */}
          <MyTurnSection />
          {/* Local bot-comment scoring's one-time download. Account-level; renders nothing where
              there is nothing to set up (LIMN_ML_DISABLED). */}
          <BotScoringSection />
          {/* The Claude spend budget — account-grained (it guards this machine's Claude login or
              API key), read from its own `/api/ai/budget`. Only where AI runs at all. */}
          {aiEnabled && <ClaudeSpendSection />}

          {/* ── WORKSPACE. One team — the one selected in the rail — named ONCE, here. ────── */}
          {/* The half carries no rule of its own: `SectionShell` already draws one under the last
              global section (there is always at least one — the large-PR threshold), and a second
              line 16px below it reads as a rendering glitch rather than a boundary. The heading
              and its scope sentence are what mark the half. */}
          {/* The heading is gated on the scope resolving, below, and on nothing else. */}
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
                {/* Pending mute — reads `/api/workspaces`. */}
                <PendingMuteSection />
                {/* Chronology's working hours and budgets, read from the workspace row. */}
                <FlowSettingsSection />
                {/* The issue tracker for THIS workspace, read from core's `workspace_trackers`
                    row. */}
                <IssueLinksSection />
                {/* SonarCloud for THIS workspace — its own row (`workspace_sonar`). */}
                <SonarSection />
                {/* Dependency auto-merge, read from the workspace row. */}
                <DependencyAutoMergeSection />
                {/* The sprint grid for THIS workspace: cadence, phase anchor, and — since
                    plugin migration 0032 — the comparison-window mode that composes with them.
                    One grain, one Save. */}
                <SprintSection />
                {/* The Slack digest for THIS workspace (`/api/pro/slack/target?workspace=`),
                    schedule and content together: the "Review bots" block is a field on the same
                    row (plugin migration 0033). ⚠ IT USED TO EDIT THE ACCOUNT'S WHOLE SELECTION
                    — a multi-select plus an "apply this webhook to all" button — so a Save could
                    add, or by omission silently cancel, deliveries for teams the reader was not
                    looking at. One row now. The cap disclosure stayed: with no picker there is no
                    screen listing every delivery. */}
                <SlackSection />
                {/* Auto Claude review of new human PRs in THIS workspace, read from the workspace
                    row (core migration 0074). Shown only where Claude Review can run. */}
                {aiEnabled && <AutoReviewSection />}
                {/* Reference docs in Claude Review — local-only like the review itself, read from
                    the workspace row (`docs_in_review`), OFF by default. */}
                {aiEnabled && <ReferenceDocsSection />}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
