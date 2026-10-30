import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import { AiProviderSection } from './AiProviderSection.js';
import { PendingMuteSection } from './PendingMuteSection.js';
import { DependencyAutoMergeSection } from './DependencyAutoMergeSection.js';
import { SonarSection } from './SonarSection.js';
import { ReferenceDocsSection } from './ReferenceDocsSection.js';
import { ConfluenceSection } from './ConfluenceSection.js';
import { NotionSection } from './NotionSection.js';
import { RelatedReposSection } from './RelatedReposSection.js';
import { FlowSettingsSection } from './FlowSettingsSection.js';
import { useSettingsWorkspace } from './workspaceScope.js';
import {
  initialSettingsTab,
  settingsPanelDomId,
  settingsTabDomId,
  tabForKey,
  visibleSettingsTabs,
  type SettingsTabDef,
  type SettingsTabId,
} from './settingsTabs.js';
import { ChevronIcon, CloseIcon } from '../Icons.js';
import { IconButton, cx, FOCUS_RING, useIsPhone } from '../ui/index.js';
import { useShell } from '../../store/shell.js';
import { escapeOwnedByControl } from '../../lib/escapeOwner.js';
import { closeActivePopover, hasActivePopover } from '../../lib/activePopover.js';
import { focusReturner } from '../../lib/focusReturn.js';
import { useSettingsModal, type SettingsFocus } from '../../store/settingsModal.js';

// User configuration modal, opened from the sidebar foot's account menu, ⌘K "Settings: <area>" and the
// deep links below (fixed overlay + role=dialog + capture-phase Escape so a dismiss doesn't reach the
// global keyboard hook). Redesign (docs/redesign/DESIGN.md): a tone-separated sheet; from md a
// column of areas beside the area on show; on a phone, full screen, the list of areas THEN one area.
//
// ── ONE AREA AT A TIME: A TAB LIST, NOT ONE LONG PANEL ──────────────────────────────────────────
// The modal was a single scrolling column of sixteen sections; finding Slack meant scrolling past
// My Turn's weights. It is now WIDER, with a vertical tab list on the left (a top row on a narrow
// screen) and one area on the right. Which section lives in which tab is DATA, in
// `settingsTabs.ts` (`SETTINGS_TABS`), pinned by `test/settingsTabs.test.ts`; `SECTIONS` below maps
// each name to its component.
//
// ⚠ EVERY PANEL STAYS MOUNTED; ONLY THE SELECTED ONE IS SHOWN (`hidden`). A half-typed Slack
// webhook must survive a look at another tab, and each section re-seeds its form only when its
// STORED value changes — unmounting would throw the draft away. It also keeps the requests what
// they were: every section's GET still fires on open, as the single panel did.
//
// ── THE GRAIN SPLIT SURVIVES INSIDE EACH TAB ─────────────────────────────────────────────────
// Global sections first, then ONE "Workspace · <name>" heading and the tab's workspace-scoped
// sections beneath it. The heading is load-bearing, not decoration: it is the ONLY thing telling
// the reader which team they are retuning (there is no workspace picker in Settings — the sidebar's
// workspace is the scope), and by being a boundary rather than a suffix it also says which
// settings are NOT a team's. Sections below it name a workspace only in a sentence that names a
// DIFFERENT one (see SlackSection's cap disclosure). Every tab with workspace sections draws it.
//
// `scopeReady` holds back the WHOLE workspace part of a tab: nothing workspace-scoped may render OR
// be written against an unresolved id.
//
// ── TWO SECTIONS WERE DELETED HERE, NEITHER SHOULD RETURN ────────────────────────────────────
// "Anthropic API key" — the BYO key stored in `~/.pierre-review/config.json` is RETIRED. Local
// Claude Review resolves an ambient Claude session first (so a subscription pays) and otherwise
// the environment's `ANTHROPIC_API_KEY`; both rungs are already reported by the review tab's own
// auth line, so a form here could only offer a third, worse one. The routes are gone too.
//
// "Review bots (account-wide)" — an explainer plus one toggle. The explainer pointed at
// Activity → Bots Monitoring → Classification, which is where a bot's judgement, identity and price actually live
// (one CORE/free `workspace_reviewers` row each), and the toggle — the Slack bot digest — became a
// property of the DELIVERY in plugin migration 0033 and is now a checkbox inside the Slack section
// under the schedule it modifies. An empty section pointing elsewhere is a signpost, not a setting.

/** Every section, by the name `SETTINGS_TABS` lists it under. */
const SECTIONS: Record<string, () => JSX.Element | null> = {
  LargePrThresholdSection,
  BlastRadiusSection,
  MyTurnSection,
  PendingMuteSection,
  AiProviderSection,
  ClaudeSpendSection,
  AutoReviewSection,
  ReferenceDocsSection,
  ConfluenceSection,
  NotionSection,
  RelatedReposSection,
  FlowSettingsSection,
  SprintSection,
  IssueLinksSection,
  SonarSection,
  SlackSection,
  BotScoringSection,
  DependencyAutoMergeSection,
};

function renderSections(names: readonly string[]): (JSX.Element | null)[] {
  return names.map((n) => {
    const Section = SECTIONS[n];
    return Section ? <Section key={n} /> : null;
  });
}

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
  // never opened. Each tab's workspace part waits here, in ONE place, rather than each section
  // rendering its own pending shell under a heading that cannot yet name anybody.
  const { workspaceId, name } = useSettingsWorkspace();
  const tabs = visibleSettingsTabs(aiEnabled);
  const lastTab = useSettingsModal((s) => s.lastTab);
  const setLastTab = useSettingsModal((s) => s.setLastTab);
  const [tab, setTab] = useState<SettingsTabId>(() => initialSettingsTab(focus, lastTab, aiEnabled));
  // AI can turn off while the modal is open (rare); never leave an unshown tab selected.
  const activeTab: SettingsTabId = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id;
  // PHONE (< md): a full-screen sheet that shows EITHER the list of areas OR one area, with a Back
  // button between them (docs/redesign/DESIGN.md § 6). A deep link (a `focus`) opens straight on its
  // area; a plain open starts on the list. Wider: the list is a column beside the area.
  const phone = useIsPhone();
  const [phoneList, setPhoneList] = useState(focus == null);
  const showList = !phone || phoneList;
  const showPanel = !phone || !phoneList;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<SettingsTabId, HTMLButtonElement>());
  // The tab the modal OPENED on — the one the mount effect focuses when no section was asked for.
  const initialTabRef = useRef(activeTab);

  const select = useCallback(
    (id: SettingsTabId, moveFocus: boolean, openArea = true): void => {
      setTab(id);
      if (openArea) setPhoneList(false);
      // One scroller serves every panel, so a new tab starts at its top, not at the old one's depth.
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
      if (moveFocus) tabRefs.current.get(id)?.focus();
    },
    [],
  );

  // ⚠ `lastTab` MIRRORS THE TAB ON SCREEN, however it got there — a click, an arrow key, a
  // deep link's focus tab (`openSettings('claude-spend')` opens AI) or the AI-off fallback. Written
  // only on a click, a deep-linked open left it on an older tab and the next plain reopen landed
  // there rather than on the tab last shown.
  useEffect(() => {
    setLastTab(activeTab);
  }, [activeTab, setLastTab]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const next = tabForKey(e.key, activeTab, tabs);
    if (next == null) return;
    e.preventDefault();
    // On the phone's list the arrows walk the list; a tap or Enter opens the area.
    select(next, true, !phone);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // An open control inside the modal (the time-zone list) owns this Escape: it closes itself
      // and the modal stays. Capture on window runs before the control's own handler, so this
      // must step aside.
      if (escapeOwnedByControl(e.target)) return;
      // So does an open Select or Menu inside it (they hold the one popover slot, lib/activePopover.ts).
      if (hasActivePopover()) return;
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
  //  • land on the section the opener asked for: its TAB is already selected (the initial state,
  //    `SETTINGS_FOCUS_TAB`), so scroll the section to the top of the panel and move keyboard focus
  //    to its heading — one frame later, so the section has laid out, and never again (the modal
  //    never re-scrolls under the reader). With no section asked for, focus goes to the selected
  //    tab, so a keyboard reader starts on the tab list;
  //  • ON CLOSE, hand focus back to what opened it. Moving focus in and dropping it on <body> on the
  //    way out left a keyboard reader at the top of the page instead of on the Pending board.
  //    Captured before the rAF moves it; skipped when the opener is gone (the avatar menu unmounts).
  useEffect(() => {
    closeActivePopover();
    // Opened from the drawer (the account menu sits in its foot below lg): the drawer is its own
    // modal layer and would otherwise stay drawn over this one.
    useShell.getState().setDrawerOpen(false);
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
    if (headingId == null) {
      raf = requestAnimationFrame(() => {
        raf = null;
        document.getElementById(settingsTabDomId(initialTabRef.current))?.focus();
      });
    } else {
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
  const activeDef = tabs.find((t) => t.id === activeTab);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-ui-scrim/40 md:items-center md:p-6 motion-safe:animate-ui-fade"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={cx(
          'flex h-full w-full overflow-hidden bg-ui-bg text-body text-ui-ink shadow-2xl shadow-black/30',
          'pt-[env(safe-area-inset-top)] md:h-[85vh] md:w-[60rem] md:max-w-[95vw] md:rounded-[10px] md:pt-0',
          'motion-safe:animate-ui-sheet-up md:motion-safe:animate-ui-pop',
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        {/* THE AREAS: a column beside the area from md; on a phone, the whole sheet until one is picked. */}
        <div className={cx('min-h-0 shrink-0 flex-col bg-ui-surface md:flex md:w-52', showList ? 'flex w-full' : 'hidden')}>
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 pl-5 pr-2 md:h-14 md:pl-4">
            <h2 className="text-title text-ui-ink">Settings</h2>
            {phone && <IconButton label="Close (Esc)" icon={<CloseIcon size={14} />} onClick={onClose} />}
          </div>
          <div
            role="tablist"
            aria-label="Settings areas"
            aria-orientation="vertical"
            className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3"
          >
            {tabs.map((t) => {
              const selected = t.id === activeTab;
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    if (el) tabRefs.current.set(t.id, el);
                    else tabRefs.current.delete(t.id);
                  }}
                  type="button"
                  role="tab"
                  id={settingsTabDomId(t.id)}
                  aria-selected={selected}
                  aria-controls={settingsPanelDomId(t.id)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(t.id, false)}
                  onKeyDown={onTabKey}
                  className={cx(
                    'flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-ui px-2.5 text-left text-body',
                    phone ? 'min-h-11 py-2' : 'h-8 touch:h-11',
                    'motion-safe:transition-colors motion-safe:duration-ui-fast',
                    // The phone's list is a list of places to go, not a selection: no highlight.
                    phone
                      ? 'text-ui-ink hover:bg-ui-hover'
                      : selected
                        ? 'bg-ui-sel font-medium text-ui-ink'
                        : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
                    FOCUS_RING,
                    'focus-visible:ring-offset-ui-surface',
                  )}
                >
                  {phone ? (
                    <span className="min-w-0">
                      <span className="block">{t.label}</span>
                      <span className="block truncate text-meta text-ui-mute">{t.summary}</span>
                    </span>
                  ) : (
                    t.label
                  )}
                  {phone && <ChevronIcon dir="right" size={12} className="shrink-0 text-ui-faint" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* THE AREA ON SHOW. One scroller serves every panel; every panel stays mounted. */}
        <div className={cx('min-h-0 min-w-0 flex-1 flex-col', showPanel ? 'flex' : 'hidden')}>
          <div className="flex h-12 shrink-0 items-center gap-1 px-2 md:h-14 md:pl-8">
            {phone && (
              <button
                type="button"
                onClick={() => {
                  setPhoneList(true);
                  requestAnimationFrame(() => tabRefs.current.get(activeTab)?.focus());
                }}
                className={cx(
                  'hit inline-flex h-10 shrink-0 items-center gap-1.5 rounded-ui px-2 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
                  FOCUS_RING,
                )}
              >
                <ChevronIcon dir="left" size={12} />
                Settings
              </button>
            )}
            <p className="min-w-0 flex-1 truncate text-title text-ui-ink" aria-hidden="true">
              {phone ? '' : activeDef?.label}
            </p>
            <IconButton label="Close (Esc)" icon={<CloseIcon size={14} />} onClick={onClose} />
          </div>
          <div
            ref={scrollerRef}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 md:px-8"
          >
            {phone && activeDef != null && <p className="mb-5 text-display text-ui-ink">{activeDef.label}</p>}
            <div className="max-w-[44rem]">
              {tabs.map((t) => (
                <SettingsTabPanel
                  key={t.id}
                  def={t}
                  hidden={t.id !== activeTab}
                  scopeReady={scopeReady}
                  workspaceName={name}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsTabPanel({
  def,
  hidden,
  scopeReady,
  workspaceName,
}: {
  def: SettingsTabDef;
  hidden: boolean;
  scopeReady: boolean;
  workspaceName: string | null;
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={settingsPanelDomId(def.id)}
      aria-labelledby={settingsTabDomId(def.id)}
      hidden={hidden}
    >
      {/* ── GLOBAL. One account, every workspace. ─────────────────────────────────────── */}
      {/* ⚠ `peer` + `:empty`, NOT `def.global.length`: a listed section may render nothing
          (BotScoringSection where ML is off), and the rule below must then go with it, or the tab
          opens on a divider with nothing above it. */}
      {def.global.length > 0 && <div className="peer space-y-4">{renderSections(def.global)}</div>}

      {/* ── WORKSPACE. One team — the one selected in the sidebar — named ONCE per tab, here. ── */}
      {/* The heading is gated on the scope resolving, below, and on nothing else. */}
      {def.workspace.length > 0 && (
        <section
          className={
            def.global.length > 0
              ? 'mt-6 border-t border-ui-line pt-6 peer-empty:mt-0 peer-empty:border-t-0 peer-empty:pt-0'
              : undefined
          }
        >
          {/* The boundary is a tone band, not a rule: the ONE place that names the team. */}
          <div className="mb-6 rounded-ui bg-ui-surface px-4 py-3">
            <h3 className="text-body font-semibold text-ui-ink">
              Workspace
              {workspaceName != null && (
                <>
                  {' · '}
                  <span>{workspaceName}</span>
                </>
              )}
            </h3>
            <p className="mt-0.5 text-meta text-ui-mute">
              Everything below applies to{' '}
              <span className="font-medium text-ui-ink">{workspaceName ?? 'the selected workspace'}</span> alone
              — every other workspace keeps its own. Switch workspace at the top of the sidebar to configure a
              different one.
            </p>
          </div>

          {/* ⚠ THE SCOPE STILL HOLDS THE WHOLE PART BACK, AS ONE. Nothing workspace-scoped may
              render against an unresolved id, and every section below would otherwise render its
              own pending shell — several "Loading this workspace's settings…" boxes under a
              heading that cannot yet name anybody reads as several broken sections rather than
              one unfinished request. */}
          {!scopeReady ? (
            <p className="py-4 text-center text-meta text-ui-faint">Loading this workspace’s settings…</p>
          ) : (
            <div className="space-y-4">{renderSections(def.workspace)}</div>
          )}
        </section>
      )}
    </div>
  );
}
