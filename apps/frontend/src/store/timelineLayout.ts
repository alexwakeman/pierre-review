import { create } from 'zustand';

// HOW A PHONE READS THE TIMELINE (the redesign; docs/redesign/DESIGN.md § 6): as a LIST of the
// board's pull requests (components/Timeline/TimelineList.tsx) — the default, since a time-axis
// canvas at 390px is mostly label gutter — or as the BOARD itself (vis-timeline, pan and pinch).
// Wider screens draw the board; this choice is read below `md`, and on a touch screen below `lg`
// (components/ui/media.ts `useTimelineListCapable`).
//
// A per-viewer convenience like the sprint board's filters (store/sprintBoardFilter.ts):
// localStorage ONLY — never the URL and never `FilterDefaults`, so deep links and "Clear filters"
// are untouched and no FILTER_STORAGE_VERSION bump is needed. Every read/write is try/catch.

export type TimelinePhoneLayout = 'list' | 'board';

const KEY = 'limn:timelinePhoneLayout';

function load(): TimelinePhoneLayout {
  try {
    return localStorage.getItem(KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

interface TimelineLayoutState {
  phone: TimelinePhoneLayout;
  setPhone: (v: TimelinePhoneLayout) => void;
}

export const useTimelineLayout = create<TimelineLayoutState>((set) => ({
  phone: load(),
  setPhone: (phone) => {
    try {
      localStorage.setItem(KEY, phone);
    } catch {
      /* private mode — the choice just won't persist */
    }
    set({ phone });
  },
}));
