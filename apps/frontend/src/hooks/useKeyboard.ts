import { useEffect } from 'react';
import { useTimeline } from './useTimeline.js';
import { useFilters } from '../store/filters.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// Global shortcuts: `/` focus filter, `j`/`k` cycle PRs, `esc` clear selection.
export function useKeyboard(): void {
  const { data } = useTimeline();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { selectedPrId, selectPr, clearSelection } = useFilters.getState();

      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) (e.target as HTMLElement).blur();
        else clearSelection();
        return;
      }
      if (isTypingTarget(e.target)) return;

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('add-repo-input')?.focus();
        return;
      }

      if (e.key === 'j' || e.key === 'k') {
        const prs = [...(data?.prs ?? [])].sort((a, b) =>
          b.openedAt.localeCompare(a.openedAt),
        );
        if (prs.length === 0) return;
        const idx = prs.findIndex((p) => p.id === selectedPrId);
        let next: number;
        if (idx === -1) next = 0;
        else next = e.key === 'j' ? idx + 1 : idx - 1;
        next = Math.max(0, Math.min(prs.length - 1, next));
        const target = prs[next];
        if (target) selectPr(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data]);
}
