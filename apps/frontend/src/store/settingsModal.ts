import { create } from 'zustand';

// ── IS THE SETTINGS MODAL OPEN, AND WHERE SHOULD IT LAND ─────────────────────────────────────
//
// A module-level store (the `conflictResolver.ts` precedent) because the modal now opens from TWO
// places: the avatar menu in App's header, and the "Customise" link on the Pending board's My turn
// tab, which sits deep inside the Activity console and has no line of props back to App.
//
// ⚠ NOT PERSISTED AND NOT IN THE URL. It is not a filter, and a reload that reopened a modal
// would be a surprise, not a restored view — `workspaceId` and the resolver's decisions stay out of
// `store/filters.ts` for the same family of reason.
//
// ⚠ `closeSettings` IS A ZUSTAND ACTION, AND THAT IS WHY App PASSES IT STRAIGHT THROUGH.
// SettingsModal registers its capture-phase Escape handler in an effect keyed on `onClose`; an
// action is referentially stable for the life of the store, so the handler registers once. An
// inline arrow in its place re-registered it on every App render.

/** Which section the modal should scroll to when it opens. */
export type SettingsFocus = 'my-turn';

interface SettingsModalState {
  open: boolean;
  focus: SettingsFocus | null;
  openSettings: (focus?: SettingsFocus) => void;
  closeSettings: () => void;
}

export const useSettingsModal = create<SettingsModalState>((set) => ({
  open: false,
  focus: null,
  openSettings: (focus) => set({ open: true, focus: focus ?? null }),
  closeSettings: () => set({ open: false, focus: null }),
}));
