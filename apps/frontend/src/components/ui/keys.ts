// THE KEYBOARD RULES EVERY PRIMITIVE SHARES (docs/redesign/DESIGN.md § Keyboard).
//
// A single-letter shortcut (j, k, a, m, e, z, 1–9) must never fire while the reader is typing, while
// a modal or a popover owns the keyboard, or with a modifier held (⌘K, ⌃F are someone else's).
// Every screen-level key handler asks `shortcutBlocked(e)` first, so the rule lives in one place.
//
// Pure where it can be (duck-typed targets), so test/uiPrimitives.test.ts can pin it without a DOM.

import { hasActivePopover } from '../../lib/activePopover.js';
import { escapeOwnedByControl } from '../../lib/escapeOwner.js';

interface TargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  getAttribute?: unknown;
}

/** True for a field the reader types into (input, textarea, select, contenteditable, role=textbox). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const t = target as TargetLike | null;
  if (t == null || typeof t.tagName !== 'string') return false;
  const tag = t.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type =
      typeof t.getAttribute === 'function'
        ? String((t.getAttribute as (n: string) => unknown).call(t, 'type') ?? 'text').toLowerCase()
        : 'text';
    // A checkbox, radio, button or range takes no text: letters stay shortcuts on it.
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  if (t.isContentEditable === true) return true;
  if (typeof t.getAttribute === 'function') {
    const role = (t.getAttribute as (n: string) => unknown).call(t, 'role');
    if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
  }
  return false;
}

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  defaultPrevented?: boolean;
}

/** True when a modal dialog (Settings, Help, the palette, a sheet) is open over the page. */
export function modalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[aria-modal="true"]') != null;
}

/**
 * Should a plain single-key shortcut be ignored? Yes while typing, with ⌘/⌃/⌥ held, after another
 * handler took the key, while a popover holds the one-popover slot, or while a modal is open
 * (unless the handler lives INSIDE that modal and passes `insideModal`).
 */
export function shortcutBlocked(e: KeyLike, opts: { insideModal?: boolean } = {}): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (isTypingTarget(e.target)) return true;
  if (hasActivePopover()) return true;
  if (!opts.insideModal && modalOpen()) return true;
  return false;
}

/** Escape should close THIS layer unless an open control inside it owns the key. */
export function escapeBelongsToLayer(e: KeyLike): boolean {
  return e.key === 'Escape' && !escapeOwnedByControl(e.target) && !hasActivePopover();
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere — for the words a Kbd shows. */
export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}

/** ⌘K on a Mac, Ctrl+K elsewhere (either is accepted everywhere). */
export function isPaletteChord(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
}
