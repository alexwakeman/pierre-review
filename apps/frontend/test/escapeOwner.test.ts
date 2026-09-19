// Whether an Escape belongs to an open control inside a modal rather than to the modal. The modal's
// capture-phase handler asks this first, so an open time-zone list closes itself and Settings stays.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/escapeOwner.test.ts
import { describe, expect, it } from 'vitest';
import { ESCAPE_OWNER_ATTR, escapeOwnedByControl } from '../src/lib/escapeOwner.js';

describe('escapeOwnedByControl', () => {
  it('is false with no target', () => {
    expect(escapeOwnedByControl(null)).toBe(false);
  });

  it('is true inside an element carrying the owner attribute', () => {
    const target = { closest: (s: string) => (s === `[${ESCAPE_OWNER_ATTR}]` ? {} : null) };
    expect(escapeOwnedByControl(target as unknown as EventTarget)).toBe(true);
    expect(ESCAPE_OWNER_ATTR).toBe('data-owns-escape');
  });

  it('is false anywhere else', () => {
    expect(escapeOwnedByControl({ closest: () => null } as unknown as EventTarget)).toBe(false);
    // `window` and `document` are event targets with no `closest`.
    expect(escapeOwnedByControl({} as EventTarget)).toBe(false);
  });
});
