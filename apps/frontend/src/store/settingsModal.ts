import { create } from 'zustand';
import type { SettingsTabId } from '../components/settings/settingsTabs.js';

// ── IS THE SETTINGS MODAL OPEN, AND WHERE SHOULD IT LAND ─────────────────────────────────────
//
// A module-level store (the `conflictResolver.ts` precedent) because the modal now opens from TWO
// places: the avatar menu in App's header, and the "Customise" link on the Pending board's My turn
// tab, which sits deep inside the Activity console and has no line of props back to App.
//
// ⚠ NOT PERSISTED AND NOT IN THE URL. It is not a filter, and a reload that reopened a modal
// would be a surprise, not a restored view — `workspaceId` and the resolver's decisions stay out of
// `store/filters.ts` for the same family of reason. `lastTab` is memory only for the same reason:
// a reopen in the same page load lands on the tab last shown; a reload starts on the first.
//
// ⚠ `closeSettings` IS A ZUSTAND ACTION, AND THAT IS WHY App PASSES IT STRAIGHT THROUGH.
// SettingsModal registers its capture-phase Escape handler in an effect keyed on `onClose`; an
// action is referentially stable for the life of the store, so the handler registers once. An
// inline arrow in its place re-registered it on every App render.

/** Which section the modal should land on when it opens — its TAB first (`SETTINGS_FOCUS_TAB`),
 *  then the section scrolled to and focused: My Turn (the Pending board's "Customise"), the
 *  workspace's issue tracker (This Sprint's "Set up in Settings"), or the Claude spend budget (the
 *  budget meter beside a Run button, the over-budget toast), the workspace's auto review and the AI
 *  section's effort (Reports → AI usage's suggestions). */
export type SettingsFocus = 'my-turn' | 'issue-tracker' | 'claude-spend' | 'auto-review' | 'ai-effort';

interface SettingsModalState {
  open: boolean;
  focus: SettingsFocus | null;
  /** The tab last shown — clicked, arrowed to or opened by a focus — so a reopen lands there. */
  lastTab: SettingsTabId | null;
  openSettings: (focus?: SettingsFocus) => void;
  closeSettings: () => void;
  setLastTab: (tab: SettingsTabId) => void;
}

export const useSettingsModal = create<SettingsModalState>((set) => ({
  open: false,
  focus: null,
  lastTab: null,
  openSettings: (focus) => set({ open: true, focus: focus ?? null }),
  closeSettings: () => set({ open: false, focus: null }),
  setLastTab: (tab) => set({ lastTab: tab }),
}));
