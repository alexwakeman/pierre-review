// ---------------------------------------------------------------------------
// THE PRODUCT NAME, and the three labels that compose it.
//
// The app is called Limn. It used to be called Pierre, and the rename was staged:
// every user-visible string moved, while the published/runtime identifiers stayed
// on the old spelling because they are migrations rather than text edits. The
// canonical statement of that split lives at apps/landing/src/lib/site.ts (which
// has its own SITE_NAME and deliberately imports nothing from here — the landing
// bundle does not depend on this package). Short version of what is STILL
// `pierre` on purpose, and must never be swept:
//
//   · the npm package `pierre-review` and its `npx` invocation
//   · the domain, the `pierre_session` / `pierre_oauth_state` cookies
//   · `~/.pierre-review/` and the ~20 `pierre:*` localStorage keys
//   · the AutomatedReviewerKind `'pierre'` — a persisted DB value AND a
//     400-validated API path segment
//   · the `refs/pierre/conflict/` git namespace the janitor sweeps by prefix
//   · `<!-- pierre:claude-review v=1 -->`, already stamped into GitHub review
//     bodies we do not control
//
// So the name is a STRING, never an identifier. Use PRODUCT_NAME wherever the
// name is composed into a sentence or a label; the ~30 plain "Limn" literals
// already in the SPA are left alone on purpose (rewriting files nobody is
// otherwise touching buys churn, not safety).
// ---------------------------------------------------------------------------

import type { GenericReviewerKind } from './types.js';

/** The product name, as a reader sees it. */
export const PRODUCT_NAME = 'Limn';

/**
 * Display labels for the three UNBRANDED automated-reviewer kinds.
 *
 * ⚠ SHARED IS OTHERWISE PRESENTATION-FREE AND THIS IS THE ONE EXCEPTION, narrowly. The ~80
 * BRANDED vendor labels stay in the frontend's `BOT_VENDOR_META` beside their colours, which
 * is what that rule is for. These three are different: `pierre` COMPOSES THE PRODUCT NAME, and
 * `in_house` carries a judgement ("In-house / custom", not "In-house AI" — see below) that has
 * to read the same everywhere. Three independent copies of these strings existed — the SPA's
 * `BOT_VENDOR_META`, the backend's `labelFor`, and the Pro plugin's Slack `BOT_LABELS` — and
 * they had drifted on BOTH counts: Slack was still emitting "Pierre · Claude" into digests
 * months after the other two were renamed, and "In-house AI" after the other two had rejected
 * that wording. Each of the three now reads these three keys from here.
 *
 * ⚠ "In-house / custom", NOT "In-house AI". The kind is the fallback for EVERY reviewer role,
 * so an unbranded quality gate or a CLA bot lands here — and calling those "In-house AI" is how
 * the bucket earned its reputation for being wrong. It is the role-neutral escape hatch.
 *
 * ⚠ `labelFor` in the backend WRITES these into `workspace_reviewers.label`, so they are
 * persisted as well as rendered. Changing one is a copy change that shows up on already-stored
 * rows only after the next classification pass.
 */
export const GENERIC_REVIEWER_LABELS: Readonly<Record<GenericReviewerKind, string>> = {
  in_house: 'In-house / custom',
  vendor: 'Vendor',
  pierre: `${PRODUCT_NAME} · Claude`,
};
