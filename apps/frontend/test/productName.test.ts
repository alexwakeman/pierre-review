// The SPA's half of the product-name guard. Hand-run (the frontend's `test` script is a no-op):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// `BOT_VENDOR_META` is one of THREE copies of the automated-reviewer label map — the others are
// `labelFor` in apps/backend/src/sync/reviewer-classify.ts (which also persists the label) and
// `BOT_LABELS` in the Pro plugin's Slack digest. They had drifted on both unbranded keys: the
// Slack copy was still emitting "Pierre · Claude" long after the rename, and "In-house AI" after
// the other two had rejected that wording. The three unbranded labels now come from shared.
//
// The CI-running half of this guard is apps/backend/src/product-name.test.ts.
import { describe, expect, it } from 'vitest';
import { GENERIC_REVIEWER_LABELS, PRODUCT_NAME } from '@pierre-review/shared';
import { BOT_VENDOR_META } from '../src/lib/ui.js';

describe('BOT_VENDOR_META and the product name', () => {
  it('takes its three unbranded labels from shared', () => {
    expect(BOT_VENDOR_META.pierre.label).toBe(GENERIC_REVIEWER_LABELS.pierre);
    expect(BOT_VENDOR_META.in_house.label).toBe(GENERIC_REVIEWER_LABELS.in_house);
    expect(BOT_VENDOR_META.vendor.label).toBe(GENERIC_REVIEWER_LABELS.vendor);
    expect(BOT_VENDOR_META.pierre.label).toBe(`${PRODUCT_NAME} · Claude`);
  });

  it('names no vendor after the old brand', () => {
    // The `pierre` KEY stays — it is a persisted DB value and a 400-validated API path segment.
    // Only what a reader SEES follows the rename.
    for (const [kind, meta] of Object.entries(BOT_VENDOR_META)) {
      expect(`${kind}: ${meta.label}`).not.toMatch(/\bPierre\b/);
    }
  });
});
