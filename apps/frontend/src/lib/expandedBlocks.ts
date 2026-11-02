// WHO OWNS ESCAPE WHILE A BLOCK IS EXPANDED (a design diagram, a "What each PR adds" card, the agent's
// live log — components/RailLayout.tsx `onEscapeFirst`).
//
// Escape collapses the expanded block and does nothing else. The trap is listener ORDER: a layer that
// holds the block (the PR drawer `SidePanel`, the sprint story tray) added its own capture-phase
// Escape listener when it OPENED, before the block expanded, so it runs first and closes the whole
// layer. So every expanded block is registered here, and such a layer steps aside while
// `expandedBlockTakesEscape()`. The reverse holds too: a modal opened OVER the block (Settings, the
// palette) owns its Escape, so a block steps aside unless every open modal contains it.
//
// Duck-typed (no DOM needed), so `test/expandedBlocks.test.ts` can pin it.

interface ContainsLike {
  contains(other: never): boolean;
}

const open = new Set<{ el: unknown }>();

/** Registers an expanded block (its root element, null while unknown). Returns the release. */
export function registerExpandedBlock(el: unknown): () => void {
  const entry = { el };
  open.add(entry);
  return () => {
    open.delete(entry);
  };
}

/** The open modal dialogs (none outside a browser). */
export function openModals(): readonly ContainsLike[] {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll('[aria-modal="true"]'));
}

/** True when no modal stands over `el`: every open modal contains it (or none is open). */
export function escapeReachesBlock(el: unknown, modals: readonly ContainsLike[]): boolean {
  for (const m of modals) {
    if (el == null || !m.contains(el as never)) return false;
  }
  return true;
}

/** True when an Escape now belongs to an expanded block: one is open and no modal stands over it. */
export function expandedBlockTakesEscape(modals: readonly ContainsLike[] = openModals()): boolean {
  for (const b of open) if (escapeReachesBlock(b.el, modals)) return true;
  return false;
}
