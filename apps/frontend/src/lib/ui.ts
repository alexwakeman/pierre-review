import {
  CheckIcon,
  CloseIcon,
  DotIcon,
  MinusIcon,
  QuestionIcon,
  SkipIcon,
  WarningIcon,
} from '../components/Icons.js';
// A VALUE import (not `import type`): the large-PR resolver below needs the product default at
// runtime. `shared` is types-only for the BACKEND — the SPA bundles it from source.
import { LARGE_PR_CODE_LOC_DEFAULT } from '@pierre-review/shared';

/** A check-state mark. A REFERENCE, so this `.ts` module can name it without holding JSX. */
type IconComponent = (props: { size?: number; className?: string; title?: string }) => JSX.Element;

import type {
  AddressedConfidence,
  AddressedVerdict,
  AutomatedReviewerKind,
  CheckRunState,
  CiStatus,
  DerivedState,
  EventType,
  MergeBlocker,
  MergeBlockFacts,
  Mergeable,
  MergeStateStatus,
  MergeVerdict,
  MergeVerdictInfo,
  MlCategory,
  MlSeverity,
  MyTurnReason,
  PrState,
  ReasonTag,
  ReviewBotKind,
  ThreadStateCounts,
  TimelinePr,
  User,
} from '@pierre-review/shared';
import { AI_CREDITS_PER_USD, reviewBotKind } from '@pierre-review/shared';

// AI cost is conveyed in CREDITS, never dollars (1¢ = 5 credits ⇒ $1 = 500 credits), to
// decouple the app's price from its underlying running cost. Raw USD stays in the data;
// format it as credits at the display edge. Used everywhere AI spend surfaces (Track usage,
// Claude Review) so the whole app is non-currency + consistent.
export function usdToCredits(usd: number): number {
  return Math.max(0, Math.round(usd * AI_CREDITS_PER_USD));
}

export interface StateMeta {
  label: string;
  color: string;
  description: string;
}

export const DERIVED_STATE_META: Record<DerivedState, StateMeta> = {
  untouched: {
    label: 'Untouched',
    color: '#ef4444',
    description: 'No reply, and no follow-up commit touched the file.',
  },
  replied_unresolved: {
    label: 'Replied',
    color: '#f59e0b',
    description:
      'Someone replied, but the thread is unresolved and no later commit touched the file.',
  },
  likely_addressed: {
    label: 'Likely addressed',
    color: '#3b82f6',
    description:
      'A commit touched this file after the last comment. Heuristic — it may be a false positive.',
  },
  resolved: {
    label: 'Resolved',
    color: '#22c55e',
    description: 'Marked resolved on GitHub.',
  },
};

// Deterministic "how sure are we the thread was addressed?" grade (Part A/B). Advisory — drives
// the confidence pill + confidence-aware bulk-resolve. Distinct hues from the state colors so the
// two badges read independently side by side.
export const CONFIDENCE_META: Record<AddressedConfidence, StateMeta> = {
  high: {
    label: 'High',
    color: '#16a34a',
    description:
      'Strong deterministic evidence the thread was addressed — GitHub marked the lines outdated AND a later commit touched them, or the bot itself confirmed/resolved it.',
  },
  medium: {
    label: 'Medium',
    color: '#d97706',
    description:
      'One change signal — a later commit touched the file, or GitHub marked the lines outdated (could be an unrelated edit or a rebase).',
  },
  low: {
    label: 'Low',
    color: '#94a3b8',
    description: 'Only a reply — no follow-up change detected.',
  },
  none: {
    label: 'None',
    color: '#94a3b8',
    description: 'No addressed signal.',
  },
};

// Pro Haiku "was it TRULY addressed?" verdict vocabulary (Part C). The SEMANTIC layer — rendered
// with a ✨ to distinguish it from the deterministic CONFIDENCE_META.
export const ADDRESSED_VERDICT_META: Record<AddressedVerdict, { label: string; color: string }> = {
  addressed: { label: 'Addressed', color: '#16a34a' },
  likely: { label: 'Likely addressed', color: '#3b82f6' },
  partial: { label: 'Partially addressed', color: '#d97706' },
  not_addressed: { label: 'Not addressed', color: '#ef4444' },
  unclear: { label: 'Unclear', color: '#94a3b8' },
};

// ML severity of a BOT comment (CORE, free tier) — the `severity-api` model's four classes.
// Its own hues, deliberately: this badge sits next to a StateBadge and a ConfidenceBadge in the
// same header, and three pills that share a palette read as one gradient rather than three
// independent facts. Raw hex, like every meta record here, because badges compose the colour at
// low opacity for the background (`${color}22`).
export const ML_SEVERITY_META: Record<MlSeverity, StateMeta> = {
  critical: {
    label: 'Critical',
    color: '#dc2626',
    description:
      'The model rates this the most serious class of finding. Advisory — CRITICAL is the class it under-recalls, so treat major+critical together as "high".',
  },
  major: {
    label: 'Major',
    color: '#ea580c',
    description: 'A substantive problem the model expects to need a real change.',
  },
  minor: {
    label: 'Minor',
    color: '#0284c7',
    description: 'A small but genuine issue.',
  },
  nit: {
    label: 'Nit',
    color: '#78716c',
    description: 'Trivial or optional — style, wording, preference.',
  },
};

// Human labels for the model's eight fixed categories. NOT `BotThemeCategory` (nine values, an
// LLM's vocabulary) — the two must not be mixed in one chart.
export const ML_CATEGORY_LABEL: Record<MlCategory, string> = {
  correctness_bug: 'Correctness',
  security: 'Security',
  performance: 'Performance',
  style_readability: 'Style',
  maintainability_refactor: 'Maintainability',
  testing: 'Testing',
  documentation: 'Docs',
  nitpick: 'Nitpick',
  praise: 'Praise',
};

// One colour per category, for charts that stack or line up all nine at once. Not derived from a
// rotating palette index: a category has to keep its colour between charts (and between a bot's
// bar and the same category's trend line), which an index into SERIES_COLORS stops guaranteeing
// the moment two charts see different category SETS. `praise` is the only non-finding here and is
// the only green, so a bar that is mostly acknowledgment reads as such at a glance.
export const ML_CATEGORY_COLOR: Record<MlCategory, string> = {
  correctness_bug: '#ef4444',
  security: '#8957e5',
  performance: '#f59e0b',
  style_readability: '#3b82f6',
  maintainability_refactor: '#6366f1',
  testing: '#14b8a6',
  documentation: '#64748b',
  nitpick: '#9ca3af',
  praise: '#22c55e',
};

export const PR_STATE_META: Record<PrState, { label: string; color: string }> = {
  open: { label: 'Open', color: '#3b82f6' },
  merged: { label: 'Merged', color: '#22c55e' },
  closed: { label: 'Closed', color: '#9ca3af' },
};

export const EVENT_META: Record<
  EventType,
  { label: string; color: string; shape: 'dot' | 'diamond' | 'triangle' | 'square' }
> = {
  pr_opened: { label: 'PR opened', color: '#3b82f6', shape: 'dot' },
  pr_merged: { label: 'PR merged', color: '#8957e5', shape: 'dot' },
  pr_closed: { label: 'PR closed', color: '#9ca3af', shape: 'dot' },
  pr_reopened: { label: 'PR reopened', color: '#3b82f6', shape: 'dot' },
  pr_ready_for_review: { label: 'Ready for review', color: '#3b82f6', shape: 'dot' },
  review_submitted: { label: 'Review', color: '#22c55e', shape: 'triangle' },
  review_comment: { label: 'Review comment', color: '#f59e0b', shape: 'dot' },
  pr_comment: { label: 'PR comment', color: '#a78bfa', shape: 'square' },
  commit_pushed: { label: 'Commit', color: '#6b7280', shape: 'diamond' },
};

// Reason tags: short label + colour + whether it's a "you" reason (gets the
// pulsing ring + my-turn grouping).
export const REASON_META: Record<
  ReasonTag,
  { label: string; color: string; myTurn: boolean }
> = {
  awaiting_your_review: { label: 'Awaiting your review', color: '#3b82f6', myTurn: true },
  your_pr_new_comments: { label: 'Your PR · new comments', color: '#22c55e', myTurn: true },
  ci_failing: { label: 'CI failing', color: '#ef4444', myTurn: false },
  merge_conflicts: { label: 'Merge conflicts', color: '#f97316', myTurn: false },
  approved_ready: { label: 'Approved · ready to merge', color: '#22c55e', myTurn: false },
  stalled: { label: 'Stalled', color: '#eab308', myTurn: false },
  untouched_threads: { label: 'Untouched threads', color: '#f59e0b', myTurn: false },
  in_progress: { label: 'In progress', color: '#9ca3af', myTurn: false },
};

// Why a feed item is "My Turn" — the reason pill on the card. `label` is the short pill
// text, `title` the hover explanation. See MyTurnReason (most-relevant first).
export const MY_TURN_REASON_META: Record<MyTurnReason, { label: string; title: string }> = {
  requested: {
    label: 'Review requested',
    title: 'A review was requested from you on this PR',
  },
  authored: { label: 'You authored', title: 'You opened this PR' },
  merged: { label: 'You merged', title: 'You merged this PR' },
  reviewed: { label: 'You reviewed', title: 'You previously reviewed this PR' },
  commented: { label: 'You commented', title: 'You previously commented on this PR' },
};

// Automated-reviewer vendors: display label + accent colour. Keyed by the shared
// AutomatedReviewerKind = ReviewBotKind ∪ 'in_house' ∪ 'pierre' (vendor classification lives
// in @pierre-review/shared reviewBotKind; presentation lives here). Drives the PrDetail
// "Bots" chip, the feed vendor tag, the bot-signal / bot-ROI cards, so a review-comment card
// reads "CodeRabbit flagged…" (or "In-house AI" / "Pierre · Claude") not a bare bot login.
export const BOT_VENDOR_META: Record<
  AutomatedReviewerKind,
  { label: string; color: string }
> = {
  coderabbit: { label: 'CodeRabbit', color: '#ff7a45' },
  greptile: { label: 'Greptile', color: '#16a34a' },
  copilot: { label: 'Copilot', color: '#8957e5' },
  qodo: { label: 'Qodo', color: '#7c3aed' },
  sourcery: { label: 'Sourcery', color: '#0d9488' },
  bito: { label: 'Bito', color: '#e11d48' },
  ellipsis: { label: 'Ellipsis', color: '#64748b' },
  korbit: { label: 'Korbit', color: '#2563eb' },
  baz: { label: 'Baz', color: '#db2777' },
  graphite: { label: 'Graphite', color: '#475569' },
  cursor: { label: 'Cursor', color: '#334155' },
  devin: { label: 'Devin', color: '#0891b2' },
  entelligence: { label: 'Entelligence', color: '#ca8a04' },
  deepsource: { label: 'DeepSource', color: '#0ea5e9' },
  github_code_quality: { label: 'GitHub Code Quality', color: '#4338ca' },
  github_advanced_security: { label: 'GitHub Advanced Security', color: '#b91c1c' },
  // OpenAI Codex. The brand mark is essentially black, which is unusable here (it vanishes on
  // the dark theme and collides with the three slate vendors above), so we take OpenAI's product
  // green instead — close to Sourcery's teal, but the map already tolerates that (Copilot and
  // Qodo are both purple) and a legible near-brand hue beats an illegible exact one.
  codex: { label: 'Codex', color: '#10a37f' },
  // Quality gates, scanners and CI
  sonarqube: { label: 'SonarQube', color: '#4e9bcd' },
  codecov: { label: 'Codecov', color: '#f01f7a' },
  codeclimate: { label: 'Code Climate', color: '#5c4d8f' },
  codefactor: { label: 'CodeFactor', color: '#3b7dd8' },
  hound: { label: 'Hound', color: '#4a5568' },
  coveralls: { label: 'Coveralls', color: '#c1503f' },
  codacy: { label: 'Codacy', color: '#397ab8' },
  github_actions: { label: 'GitHub Actions', color: '#2088ff' },
  jit: { label: 'Jit', color: '#5b5bd6' },
  socket: { label: 'Socket', color: '#6d5efc' },
  gitguardian: { label: 'GitGuardian', color: '#1c3f94' },
  semgrep: { label: 'Semgrep', color: '#1aa382' },
  trunk: { label: 'Trunk', color: '#2d6a5a' },
  // Dependency & version bumps
  dependabot: { label: 'Dependabot', color: '#0366d6' },
  renovate: { label: 'Renovate', color: '#1a1f6c' },
  snyk: { label: 'Snyk', color: '#4c4a73' },
  pyup: { label: 'PyUp', color: '#3775a9' },
  greenkeeper: { label: 'Greenkeeper', color: '#3aa757' },
  depfu: { label: 'Depfu', color: '#7b5ea7' },
  // Code agents — automation that writes code
  sweep: { label: 'Sweep', color: '#e0913a' },
  codegen: { label: 'Codegen', color: '#b45309' },
  deepsource_autofix: { label: 'DeepSource Autofix', color: '#0284c7' },
  pre_commit_ci: { label: 'pre-commit.ci', color: '#f9a825' },
  restyled: { label: 'Restyled', color: '#a16207' },
  imgbot: { label: 'ImgBot', color: '#d97706' },
  transifex: { label: 'Transifex', color: '#0f6fbe' },
  crowdin: { label: 'Crowdin', color: '#2e3340' },
  mintlify: { label: 'Mintlify', color: '#0d9f6e' },
  allstar: { label: 'Allstar', color: '#8d6e2f' },
  // Release & merge automation
  mergify: { label: 'Mergify', color: '#ee6c4d' },
  kodiak: { label: 'Kodiak', color: '#3f7a8c' },
  bulldozer: { label: 'Bulldozer', color: '#6b7f3a' },
  release_please: { label: 'Release Please', color: '#1f7a8c' },
  semantic_release: { label: 'semantic-release', color: '#c0392b' },
  release_drafter: { label: 'Release Drafter', color: '#5a7d9a' },
  changesets: { label: 'Changesets', color: '#8a5cf6' },
  backport: { label: 'Backport bot', color: '#7e6b8f' },
  // Housekeeping — process, compliance, metadata
  cla_assistant: { label: 'CLA Assistant', color: '#78716c' },
  google_cla: { label: 'Google CLA', color: '#4285f4' },
  meta_cla: { label: 'Meta CLA', color: '#0866ff' },
  dco: { label: 'DCO', color: '#57534e' },
  stale_bot: { label: 'Stale bot', color: '#a8a29e' },
  welcome_bot: { label: 'Welcome bot', color: '#a3a3a3' },
  lock_bot: { label: 'Lock bot', color: '#737373' },
  allcontributors: { label: 'All Contributors', color: '#ff8c00' },
  semantic_pr: { label: 'Semantic PR', color: '#8b8b8b' },
  sizebot: { label: 'Size bot', color: '#9ca3af' },
  codesandbox: { label: 'CodeSandbox', color: '#151515' },
  netlify: { label: 'Netlify', color: '#00c7b7' },
  vercel: { label: 'Vercel', color: '#5f5f5f' },
  gitpod: { label: 'Gitpod', color: '#ff8a00' },
  // ── The three UNBRANDED kinds — legal in every role, rendered by login rather than by brand ──
  in_house: { label: 'In-house / custom', color: '#6b7280' },
  // Generic proprietary vendor (user-classified, brand unknown) — neutral tint; like
  // in_house it is NOT branded, so buildBotColorMap gives each one a distinct palette hue.
  vendor: { label: 'Vendor', color: '#71717a' },
  pierre: { label: 'Limn · Claude', color: '#d97757' },
};

// Display meta for an automated-reviewer kind (vendor / in-house / Pierre). The one lookup
// for "how do I render this AutomatedReviewerKind" — used wherever a classified kind is in
// hand (bot-signal / bot-ROI cards, provenance badges, dedup rollups).
/* ─────────────────────────────────────────────────────────────────────────────────────────────
   BRAND INK — a vendor's colour, made legible on whichever ground it lands on.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** THE PAGE GROUNDS. `bg-white` in light, `dark:bg-gray-950` in dark. */
const INK_LIGHT_BG = '#ffffff';
const INK_DARK_BG = '#030712';
/** WCAG AA for body text. Vendor chips render at 10-11px, so the large-text 3:1 relaxation
 *  does not apply to them. */
const INK_TARGET = 4.5;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
function relLuminance(rgb: [number, number, number]): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
/** WCAG contrast ratio between two hex colours. Exported so the guard test measures the same
 *  arithmetic the renderer does, rather than a second implementation that can drift from it. */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(hexToRgb(a));
  const lb = relLuminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0))
    : max === gn ? (bn - rn) / d + 2
    : (rn - gn) / d + 4;
  return [h / 6, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  const to = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * A brand colour adjusted along LIGHTNESS ONLY until it clears AA on `bg`, hue and saturation
 * untouched. Returns the original when it already passes.
 *
 * ⚠ TWO VARIANTS ARE NOT A PREFERENCE, THEY ARE FORCED. Clearing 4.5:1 on white needs a relative
 * luminance ≤ 0.175; clearing it on the near-black page needs ≥ 0.184. Those windows do not
 * overlap, so NO single colour is legible as small text on both grounds — which is why every
 * attempt to fix this by picking nicer hexes fails, and why the value is theme-selected in CSS
 * rather than stored once.
 *
 * ⚠ AND IT IS WHY THE RAW BRAND HEX MUST NOT BE USED AS TEXT COLOUR. Measured at the time this
 * was written: 40 of the 83 vendor colours failed AA on the dark ground and 43 failed on the
 * light one. Cursor (#334155) rendered at 1.94:1 on dark — a reader reported it as unreadable,
 * and CodeSandbox (#151515) was worse at 1.10:1. The raw value is still right for a chart stroke,
 * where the component controls the ground.
 */
export function readableInk(color: string, bg: string): string {
  if (contrastRatio(color, bg) >= INK_TARGET) return color;
  const [h, s, l0] = rgbToHsl(hexToRgb(color));
  const towardsLight = relLuminance(hexToRgb(bg)) < 0.5;
  // 1% steps: fine enough that the shift is imperceptible next to the brand mark, coarse enough
  // to terminate. Walks to pure white/black in the worst case, which is the correct answer for a
  // near-black brand on a near-black ground.
  for (let i = 1; i <= 100; i += 1) {
    const l = towardsLight ? Math.min(1, l0 + i / 100) : Math.max(0, l0 - i / 100);
    const candidate = hslToHex(h, s, l);
    if (contrastRatio(candidate, bg) >= INK_TARGET) return candidate;
    if (l === 0 || l === 1) break;
  }
  return towardsLight ? '#ffffff' : '#000000';
}

/**
 * The two custom properties a brand colour is applied through. Spread into an element's `style`;
 * index.css matches `[style*="--ink-light"]` and sets `color` from the right one per theme.
 *
 * ⚠ IT DELIBERATELY DOES NOT SET `color`. The first attempt returned `color: 'var(--ink)'` with
 * `:root { --ink: var(--ink-light) }` / `.dark { --ink: var(--ink-dark) }`, on the assumption that
 * `--ink` would re-resolve against each element's own pair. It does not: a custom property whose
 * value contains `var()` is substituted at the element where it is DECLARED, so `--ink` resolved
 * against `:root`'s (undefined) `--ink-light`, became invalid-at-computed-value-time, and every
 * chip silently fell back to its inherited colour. It typechecked, it rendered, and it was wrong
 * on screen — which is why this is spelled out rather than tidied away.
 */
export function vendorInk(color: string): Record<string, string> {
  return {
    '--ink-light': readableInk(color, INK_LIGHT_BG),
    '--ink-dark': readableInk(color, INK_DARK_BG),
  };
}

export function automatedReviewerMeta(kind: AutomatedReviewerKind): {
  label: string;
  color: string;
} {
  return BOT_VENDOR_META[kind];
}

// Classify a user (by login) as a known AI review bot → its vendor kind + display meta, or
// null for humans / non-review bots. The one call site for "is this actor a review bot".
export function botVendorMeta(
  user: Pick<User, 'githubLogin'> | null | undefined,
): { kind: ReviewBotKind; label: string; color: string } | null {
  const kind = reviewBotKind(user?.githubLogin);
  return kind ? { kind, ...BOT_VENDOR_META[kind] } : null;
}

// A curated categorical palette for bots that DON'T have a recognizable brand colour — every
// in-house bot, an unbranded reviewer, or a collision that needs breaking. 10 mid-tone hues
// spread across the wheel, each legible on both light and dark surfaces (used as chart strokes,
// small swatches, and text-on-10%-tint pills). ORDER MATTERS: buildBotColorMap assigns greedily
// from the front, so we lead with hues furthest from the most COMMON review-bot brand colours
// (CodeRabbit orange, Copilot/Qodo purple, Sourcery teal, Korbit blue, Greptile green) — this
// way the usual 1–3 in-house bots land on pink/lime/cyan, clearly distinct from the brands they
// sit beside, before we reach the brand-adjacent hues at the tail.
export const BOT_PALETTE: readonly string[] = [
  '#ec4899', // pink
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#ef4444', // red
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#14b8a6', // teal
  '#22c55e', // green
  '#f97316', // orange
] as const;

// The generic fallback tint for an automated reviewer we can't place (no login, roster not
// loaded yet) — the same neutral gray in_house has always used.
const BOT_FALLBACK_COLOR = BOT_VENDOR_META.in_house.color;

// The kinds that carry a distinctive BRAND colour worth preserving (recognition beats a
// palette slot). `in_house` (and anything unknown) is deliberately excluded — those are the
// bots that need a distinct palette colour instead of the shared gray.
function isBrandedKind(kind: AutomatedReviewerKind): boolean {
  return kind !== 'in_house' && kind !== 'vendor';
}

// Build a stable login → colour map for a roster of automated reviewers (brand-aware hybrid):
//   1. branded kinds (known vendors + Pierre) keep their BOT_VENDOR_META brand colour, and
//   2. in-house / unknown bots each get a DISTINCT palette colour (greedy, skipping any hue a
//      brand already claimed), so no two bots share a colour until the palette is exhausted.
// Keyed by login (unique per user) and seeded by a stable login sort, so a given bot resolves
// to the same colour across every surface + view (the map is account-wide, not per-view).
export function buildBotColorMap(
  roster: { login: string; kind: AutomatedReviewerKind }[],
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...roster].sort((a, b) => a.login.localeCompare(b.login));
  // Pass 1: branded vendors + Pierre claim their brand colour.
  for (const r of sorted) {
    if (map.has(r.login) || !isBrandedKind(r.kind)) continue;
    const c = BOT_VENDOR_META[r.kind].color;
    map.set(r.login, c);
    used.add(c.toLowerCase());
  }
  // Pass 2: in-house / unknown bots each take the next palette colour not already in use;
  // once the palette is exhausted, colours repeat (acceptable beyond the palette size).
  let cursor = 0;
  for (const r of sorted) {
    if (map.has(r.login)) continue;
    let chosen = BOT_PALETTE[cursor % BOT_PALETTE.length]!;
    for (let k = 0; k < BOT_PALETTE.length; k++) {
      const cand = BOT_PALETTE[(cursor + k) % BOT_PALETTE.length]!;
      if (!used.has(cand.toLowerCase())) {
        chosen = cand;
        cursor += k + 1;
        break;
      }
      if (k === BOT_PALETTE.length - 1) cursor += 1; // all used → cycle from the next slot
    }
    map.set(r.login, chosen);
    used.add(chosen.toLowerCase());
  }
  return map;
}

// Resolve one bot's colour: the account-wide map by login → its brand colour (branded kinds)
// → the neutral fallback. `login`/map absent (roster still loading) degrades to brand-by-kind,
// so a branded bot never flashes and an in-house bot briefly shows gray before its palette hue.
export function resolveBotColor(
  colorMap: Map<string, string>,
  bot: { login?: string | null; kind: AutomatedReviewerKind },
): string {
  if (bot.login) {
    const c = colorMap.get(bot.login);
    if (c) return c;
  }
  return isBrandedKind(bot.kind) ? BOT_VENDOR_META[bot.kind].color : BOT_FALLBACK_COLOR;
}

// The reason tags that make a PR "need attention" — mirrors the backend's
// ACTIVITY_ATTENTION_REASONS (db/queries.ts) so the per-PR ⚠ badge and the repo-level
// attentionCount agree exactly.
const ATTENTION_REASONS = new Set<ReasonTag>([
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'untouched_threads',
]);

// Whether an open PR needs attention (your turn · stalled · untouched threads / CI /
// conflicts). Keep in lockstep with getActivity's attentionCount predicate.
export function prNeedsAttention(pr: {
  isStalled: boolean;
  threadCounts: ThreadStateCounts;
  reasonTag: ReasonTag;
}): boolean {
  return pr.isStalled || pr.threadCounts.untouched > 0 || ATTENTION_REASONS.has(pr.reasonTag);
}

// A PR's "volume of activity" proxy for the open-PR sort: how much discussion it has
// accumulated (total review threads across every state — untouched + replied + likely-
// addressed + resolved). Cheap (already on the lean TimelinePr) and monotonic in activity.
export function prActivityVolume(pr: TimelinePr): number {
  const c = pr.threadCounts;
  return c.untouched + c.replied_unresolved + c.likely_addressed + c.resolved;
}

// Order a repo's / scope's OPEN PRs for the Activity console lists. Precedence:
//   1. maintainer-authored first (prioritised so they land on the first page) —
//      `isMaintainerAuthor(pr)` = the PR's author has merge rights in the PR's repo,
//   2. recentness of activity (updatedAt, newest first),
//   3. volume of activity (prActivityVolume, most first),
//   4. PR number desc — a stable final tiebreak.
// Returns a sorted COPY (never mutates the input). Both Activity open-PR lists share this
// so the cross-repo Feed panel and the per-repo list order identically.
export function sortOpenPrsByActivity(
  prs: TimelinePr[],
  isMaintainerAuthor: (pr: TimelinePr) => boolean,
): TimelinePr[] {
  return [...prs].sort((a, b) => {
    const ma = isMaintainerAuthor(a) ? 0 : 1;
    const mb = isMaintainerAuthor(b) ? 0 : 1;
    if (ma !== mb) return ma - mb;
    // ISO-8601 strings sort chronologically under localeCompare; reverse for newest-first.
    const r = b.updatedAt.localeCompare(a.updatedAt);
    if (r !== 0) return r;
    const v = prActivityVolume(b) - prActivityVolume(a);
    if (v !== 0) return v;
    return b.number - a.number;
  });
}

// CI rollup → dot colour + label. `null` when there are no checks at all.
export const CI_META: Record<
  CiStatus,
  { label: string; color: string } | null
> = {
  success: { label: 'CI passing', color: '#22c55e' },
  failure: { label: 'CI failing', color: '#ef4444' },
  error: { label: 'CI error', color: '#ef4444' },
  pending: { label: 'CI running', color: '#eab308' },
  expected: { label: 'CI expected', color: '#9ca3af' },
  unknown: null,
};

// Should the PR Overview's "Checks" row render at all?
//
// Two independent reasons to show it, and the gate must not fire without one of them — `Row`
// always paints its uppercase label, so a row whose every child renders null is a bare "CHECKS"
// heading next to an empty column.
//
//  1. There are check runs to list.
//  2. CI is red but `checkRuns` did not hydrate (an expired/SAML-blocked token, a partial
//     statusCheckRollup, a head pushed since the last sync). The row then exists ONLY to carry
//     the CI-failure diagnosis — and that card is Pro (`CiAnalysisCard` returns null without the
//     prSummary capability), so on the free tier this branch can never produce content and MUST
//     NOT open the row. That is why the capability is an argument here rather than a detail of
//     the card: the row's visibility depends on its child's.
export function checksRowVisible(
  checkCount: number,
  ciStatus: CiStatus | null | undefined,
  prSummary: boolean,
): boolean {
  if (checkCount > 0) return true;
  return prSummary && (ciStatus === 'failure' || ciStatus === 'error');
}

// Per-check display: icon + colour + short label.
//
// ⚠ `icon` is a COMPONENT REFERENCE, not an element and not a glyph. Three reasons, in order of
// how much each one cost:
//  • This module is `.ts`, not `.tsx`, so it cannot hold JSX at all. A reference can live here;
//    an element cannot. Consumers render it as `<m.icon size={11} />`.
//  • The seven states used to be seven characters (✓ ✕ • – ⤼ ! ?) drawn from whatever font the
//    platform picked, so they landed on different baselines at different optical weights inside
//    one vertical column of check rows — the column that is meant to be scannable at a glance.
//  • `color` below is a HEX applied by the caller, and only a `currentColor` icon follows it.
// `neutral`, `skipped` and `unknown` each keep a mark of their own: "it decided nothing", "it
// never ran" and "GitHub told us nothing" are three different facts, and collapsing any of them
// into the failure mark would report a red that nobody observed.
export const CHECK_STATE_META: Record<
  CheckRunState,
  { label: string; color: string; icon: IconComponent }
> = {
  success: { label: 'passed', color: '#22c55e', icon: CheckIcon },
  failure: { label: 'failed', color: '#ef4444', icon: CloseIcon },
  pending: { label: 'running', color: '#eab308', icon: DotIcon },
  neutral: { label: 'neutral', color: '#9ca3af', icon: MinusIcon },
  skipped: { label: 'skipped', color: '#9ca3af', icon: SkipIcon },
  error: { label: 'error', color: '#ef4444', icon: WarningIcon },
  unknown: { label: 'unknown', color: '#9ca3af', icon: QuestionIcon },
};

// ---- The ONE merge verdict --------------------------------------------------------------
//
// Everything that renders "can this land?" resolves it here. Before this existed, each
// surface combined GitHub's fields its own way and the PR-detail Overview read
// `mergeable === 'mergeable'` as a green "mergeable" — which is WRONG, and wrong on ~444 of
// the open PRs in a real database:
//
//   • `mergeable` reports ONLY merge-CONFLICT state (MERGEABLE / CONFLICTING / UNKNOWN). A PR
//     whose required checks are failing is still `mergeable: 'mergeable'`.
//   • `mergeStateStatus` is the branch-protection-aware field, and the one to lead with:
//       clean     — mergeable and passing
//       blocked   — protection unmet (required checks failing / required reviews missing)
//       unstable  — NON-required checks are red; GitHub WILL still merge it
//       behind    — the base moved and this repo requires up-to-date branches
//       dirty     — conflicts with the base
//       has_hooks — mergeable, with a pre-receive hook to run
//       unknown   — GitHub hasn't computed it yet
//     It is ACTOR-AGNOSTIC (it does not model an admin's bypass power), which is exactly why
//     it needs no branch-protection API call to be trustworthy.
//
// So: mergeStateStatus first, `mergeable` only as the conflict corroborator.
export interface MergeVerdictInput {
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  // Draft-ness is its own stored boolean — GitHub's MergeStateStatus.DRAFT is deliberately
  // not modelled in the enum (see sync/upsert.ts), so it is passed separately.
  isDraft?: boolean;
  // Everything the BLOCKED-reason derivation reads, in one optional object — see
  // `MergeBlockFacts` for why presence itself is the signal. Absent (every compact surface,
  // which is fed a lean TimelinePr) → the blocked reason stays generic, never invented.
  blockFacts?: MergeBlockFacts;
  // Out-of-band states only the live merge-options fetch knows about.
  inMergeQueue?: boolean;
  queuePosition?: number | null;
  autoMergeArmed?: boolean;
  // Commits behind the base, when known — turns "behind" into "3 commits behind".
  behindBy?: number;
}

// The sentence a blocked PR gets when the caller supplied no facts to reason from (every
// compact surface: the timeline bar tooltip, the dense open-PR rows, the Pending cards). It
// promises nothing beyond what `mergeStateStatus: 'blocked'` itself says.
const BLOCKED_GENERIC_DETAIL = 'required checks or reviews aren’t satisfied';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * THE ranked candidate causes of a `blocked` merge state, most certain first.
 *
 * ⚠ `certainty` ORDERS the list; it is NOT rendered, and there is no `note`. The pane states
 * the facts and stops — see **Product voice** in CLAUDE.md.
 *
 * Pure, and exported for its unit test. See `MergeBlockerKind` in `shared` for the argument:
 * GitHub collapses at least six protection failures into one word and the only field that
 * would separate them is admin-gated, so this reasons from the data the app already syncs
 * instead — and never asserts a cause it cannot check.
 *
 * WHAT COUNTS AS PROVEN. Only `reviewDecision`: it is GitHub's own answer to "does review still
 * block this?", so 'review_required' / 'changes_requested' NAME an unmet requirement. Nothing
 * else on the payload names a rule, so every other row is a fact of the PR offered as a
 * possibility. That split is the whole feature — a confident wrong reason is worse than none.
 *
 * WHAT `reviewDecision === 'approved'` BUYS. It does not produce a row; it REMOVES one. The
 * predecessor of this function returned a flat "required checks aren’t passing" for approved
 * PRs, which was false on 10 measured PRs whose CI rollup was green — an assertion made from a
 * field that says nothing at all about checks. Approval now only sharpens `unexplained`.
 *
 * THE ORDER is fixed and by evidence strength, not by which cause anyone expects: GitHub's own
 * naming first, then a red rollup (a red NON-required check alone reads as 'unstable', not
 * 'blocked' — the same inference `merge/auto-merge-runner.ts` already makes when it labels an
 * armed intent's wait), then checks that have not reported, then unresolved threads (real, but
 * conditional on a repo setting we cannot read). Only 89 of 572 blocked PRs in a real database
 * have ANY unresolved thread, so threads must not lead.
 *
 * Never returns an empty array: `unexplained` is the terminal entry, and it exists so that a
 * blocked PR can never fall back to a bare "blocked" with nothing underneath it.
 */
export function deriveMergeBlockers(facts: MergeBlockFacts): MergeBlocker[] {
  const out: MergeBlocker[] = [];
  const { reviewDecision, ciStatus, requestedReviewers } = facts;
  const unresolved = facts.unresolvedThreads ?? 0;
  const likely = Math.min(facts.likelyAddressedThreads ?? 0, unresolved);

  // ---- proven: GitHub itself names the unmet requirement -------------------------------
  if (reviewDecision === 'changes_requested') {
    out.push({
      kind: 'changes_requested',
      certainty: 'proven',
      text: 'a reviewer requested changes',
    });
  } else if (reviewDecision === 'review_required') {
    out.push({
      kind: 'review_required',
      certainty: 'proven',
      text: 'required reviews aren’t in yet',
      // The outstanding-request count NAMES this proven blocker; it is never a blocker of its
      // own (see MergeBlockFacts.requestedReviewers for why that would be a false cause).
      ...(requestedReviewers != null && requestedReviewers > 0
        ? {
            count: requestedReviewers,
          }
        : {
          }),
    });
  }

  // ---- inferred: true of this PR, but GitHub never says it is what "blocked" means ------
  if (ciStatus === 'failure' || ciStatus === 'error') {
    out.push({
      kind: 'checks_red',
      certainty: 'inferred',
      text: ciStatus === 'error' ? 'a check errored on the head commit' : 'CI is red on the head commit',
    });
  } else if (ciStatus === 'pending' || ciStatus === 'expected') {
    out.push({
      kind: 'checks_pending',
      certainty: 'inferred',
      // 'expected' is GitHub's word for a required context that is REGISTERED and has never
      // reported — a sharper fact than "still running", and worth its own sentence.
      text:
        ciStatus === 'expected'
          ? 'a required check hasn’t reported yet'
          : 'checks are still running',
    });
  }

  if (unresolved > 0) {
    out.push({
      kind: 'unresolved_threads',
      certainty: 'inferred',
      count: unresolved,
      text: `${unresolved} review ${plural(unresolved, 'thread isn’t', 'threads aren’t')} resolved on GitHub${
        likely > 0 ? ` (${likely} of them look addressed)` : ''
      }`,
    });
  }

  if (out.length === 0) {
    // Nothing we hold explains it. This is a real and common state — 17 PRs in a measured
    // database are approved + blocked with no unresolved thread and a green rollup — and it is
    // the case the old "required checks aren’t passing" sentence lied about.
    const approved = reviewDecision === 'approved';
    out.push({
      kind: 'unexplained',
      certainty: 'inferred',
      text: approved
        ? 'approved, and nothing we can see explains the block'
        : 'nothing we can see explains it',
    });
  }

  return out;
}

const MERGE_STATE_STATUSES: readonly MergeStateStatus[] = [
  'clean',
  'dirty',
  'unstable',
  'blocked',
  'behind',
  'has_hooks',
  'unknown',
];

/**
 * Narrow a RAW mergeStateStatus string to the modelled enum. `PrMergeOptions` carries
 * GitHub's live REST value as a plain `string` (it can return values we don't model, e.g.
 * `draft`), so the live merge path funnels through this instead of casting.
 */
export function toMergeStateStatus(raw: string | null | undefined): MergeStateStatus {
  const lower = (raw ?? '').toLowerCase();
  return (MERGE_STATE_STATUSES as readonly string[]).includes(lower)
    ? (lower as MergeStateStatus)
    : 'unknown';
}

/**
 * Collapse GitHub's mergeability fields (+ the two out-of-band states) into ONE verdict.
 * Pure: same input, same answer, on every surface.
 */
export function mergeVerdict(pr: MergeVerdictInput): MergeVerdictInfo {
  const mss = pr.mergeStateStatus;

  // Out-of-band first — being in the queue or armed is the truest answer to "what happens
  // next", and both outrank the raw status they're waiting on.
  if (pr.inMergeQueue) {
    return {
      verdict: 'queued',
      label: 'in merge queue',
      tone: 'ok',
      canMerge: false,
      detail: pr.queuePosition != null ? `position ${pr.queuePosition}` : null,
    };
  }
  if (pr.autoMergeArmed) {
    return {
      verdict: 'armed',
      label: 'auto-merge armed',
      tone: 'ok',
      // Arming doesn't take the manual merge away — the user can still land it by hand.
      canMerge: true,
      detail: 'it lands by itself once the blockers clear',
    };
  }

  // Conflicts outrank draft: a conflicting draft still needs a human to resolve them, and
  // that is more actionable than "it's a draft".
  if (mss === 'dirty' || pr.mergeable === 'conflicting') {
    return {
      verdict: 'conflicts',
      label: 'conflicts',
      tone: 'bad',
      canMerge: false,
      detail: 'resolve the conflicts with the base branch',
    };
  }
  if (pr.isDraft) {
    return {
      verdict: 'draft',
      label: 'draft',
      tone: 'muted',
      canMerge: false,
      detail: 'mark it ready for review to merge',
    };
  }
  if (mss === 'blocked') {
    // The ONE verdict GitHub refuses to explain, so it is the ONE that carries a list. When the
    // caller has facts to reason from, the headline detail is the TOP-RANKED candidate rather
    // than a fixed sentence — which is what stops it asserting a cause the evidence doesn't
    // support (its predecessor claimed "required checks aren’t passing" for every approved PR,
    // green rollup included).
    const blockers = pr.blockFacts ? deriveMergeBlockers(pr.blockFacts) : null;
    return {
      verdict: 'blocked',
      label: 'blocked',
      tone: 'bad',
      canMerge: false,
      detail: blockers?.[0]?.text ?? BLOCKED_GENERIC_DETAIL,
      ...(blockers ? { blockers } : {}),
    };
  }
  if (mss === 'behind') {
    return {
      verdict: 'behind',
      label: 'behind base',
      tone: 'warn',
      // GitHub itself refuses the merge in this state (the repo requires up-to-date
      // branches), so offering a merge button would just produce a 405.
      canMerge: false,
      detail:
        pr.behindBy != null && pr.behindBy > 0
          ? `${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} behind — update the branch first`
          : 'update the branch first',
    };
  }
  if (mss === 'unstable') {
    return {
      verdict: 'unstable',
      label: 'checks failing',
      tone: 'warn',
      // The load-bearing subtlety: 'unstable' means only NON-required checks are red, so
      // GitHub will merge it. Warn, don't block.
      canMerge: true,
      detail: 'some non-required checks are failing — GitHub will still merge it',
    };
  }
  if (mss === 'clean' || mss === 'has_hooks') {
    return {
      verdict: 'clean',
      label: 'ready to merge',
      tone: 'ok',
      canMerge: true,
      detail: null,
    };
  }
  // 'unknown': GitHub computes mergeability asynchronously and briefly reports nothing. We
  // render it honestly and do NOT kick off a repair pass — a background re-fetch on every
  // unknown would be a per-render GitHub call for a state that resolves itself.
  return {
    verdict: 'unknown',
    label: 'mergeability unknown',
    tone: 'muted',
    canMerge: false,
    detail: null,
  };
}

// Tailwind classes per tone, so every compact surface tints a verdict identically.
export const MERGE_TONE_CLASS: Record<MergeVerdictInfo['tone'], string> = {
  ok: 'text-green-600 dark:text-green-400',
  warn: 'text-orange-600 dark:text-orange-400',
  bad: 'text-red-600 dark:text-red-400',
  muted: 'text-gray-400 dark:text-gray-500',
};

// Chip backgrounds for the dense list rows (RepoOpenPrList).
export const MERGE_TONE_CHIP: Record<MergeVerdictInfo['tone'], string> = {
  ok: 'bg-green-500/15 text-green-700 dark:text-green-400',
  warn: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  bad: 'bg-red-500/15 text-red-600 dark:text-red-400',
  muted: 'bg-gray-500/10 text-gray-500 dark:text-gray-400',
};

// Which verdicts deserve the ⚠ on the COMPACT surfaces (open-PR rows, timeline tooltips).
// `blocked` joins conflicts/behind/unstable here — it is the whole point of the fix: a PR
// whose required checks are red used to render as plain "mergeable" with no warning at all.
const COMPACT_WARN_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'conflicts',
  'blocked',
  'behind',
  'unstable',
]);

// The subset a DRAFT may still fall back to. Deliberately narrower: these two are branch
// facts a human has to act on whether or not the PR is ready, so they survive the draft
// verdict. `blocked`/`unstable` do NOT — required reviews being absent is what "draft" means,
// and unstable's copy ("GitHub will still merge it") is a lie about a draft.
const DRAFT_COMPACT_WARN_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'conflicts',
  'behind',
]);

/**
 * The verdict a dense row should SHOW, or null when there is nothing worth the pixels
 * ('clean' / 'unknown' are already conveyed by the row's other affordances).
 *
 * Drafts are the trap: `mergeVerdict` returns 'draft' before it ever looks at behind/blocked,
 * and 'draft' isn't a compact warning — so a draft that was ALSO behind its base silently lost
 * its ⚠ on the timeline bar and the open-PR rows, which the verdict resolver's predecessor
 * (which had no draft branch at all) did show. Re-deriving with `isDraft` dropped recovers the
 * co-occurring condition for the compact surfaces ONLY; the main chain stays untouched, since
 * leading with 'draft' really is the most important fact about the PR everywhere else.
 */
export function mergeVerdictWarning(pr: MergeVerdictInput): MergeVerdictInfo | null {
  const info = mergeVerdict(pr);
  if (COMPACT_WARN_VERDICTS.has(info.verdict)) return info;
  if (info.verdict !== 'draft') return null;
  const underneath = mergeVerdict({ ...pr, isDraft: false });
  return DRAFT_COMPACT_WARN_VERDICTS.has(underneath.verdict) ? underneath : null;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The LARGE-PR FLAG — the ONE resolver
   ─────────────────────────────────────────────────────────────────────────────────────────────

   A pull request whose CODE churn is big enough that reviewing it well is unlikely. The backend
   does the hard half (`db/code-loc.ts` decides what counts as code and sums it); the wire then
   carries a NUMBER, never an `isLarge` boolean, so the comparison against the account's
   threshold is a pure render-time operation — changing the threshold in Settings repaints every
   surface with no cache invalidation anywhere.

   ⚠ EVERY SURFACE COMPARES HERE AND NOWHERE ELSE. Feed cards, Pending cards, the PR-detail
   header and the vis-timeline tooltip all call `largePrFlag`. A per-component `codeLoc >
   threshold` is how the timeline and the board come to disagree about the same pull request.

   The three data traps this function exists to get right — all three end in "render nothing",
   which is why it returns `null` rather than a verdict object with a `false` in it:

     1. `codeLoc == null` is UNKNOWN, never "not large". Roughly a fifth of synced PRs have no
        stored per-file breakdown or no observed size at all. Nothing is drawn, and in
        particular no "unknown" chrome — a reader who sees no flag on any PR must not be able to
        tell the unmeasured ones from the small ones, because we cannot.
     2. `codeLocIsLowerBound` reads ASYMMETRICALLY. GitHub's `files(first: 100)` truncates, and
        it truncates exactly the biggest pull requests. Over the threshold is still safe to
        assert (a missing file can only ADD lines); under it proves nothing.
     3. Under the threshold we say nothing at all — no "small PR" affordance, on any surface.
        That keeps trap 2 structurally impossible to get wrong: there is no under-threshold
        rendering path for a truncated number to lie on. */

/** The rendered form of an over-threshold pull request. `null` from `largePrFlag` means "draw
 *  nothing", covering both "we don't know" and "not large" — deliberately the same answer. */
export interface LargePrFlagInfo {
  /** The measured code-only churn. A FLOOR when `isLowerBound`. */
  codeLoc: number;
  /** GitHub truncated the file list, so the real figure is higher than `codeLoc`. */
  isLowerBound: boolean;
  /** Full sentence for a `title=` / accessible label — carries the number AND the threshold,
   *  because "large" without a magnitude is not reviewable information. */
  label: string;
  /** Compact visible text beside the icon, e.g. `2,340 code lines` / `2,340+ code lines`. */
  short: string;
}

/**
 * Should this pull request carry the large-PR flag, and what does it say?
 *
 * `pr` is deliberately structural (`codeLoc` + `codeLocIsLowerBound`) so the one function serves
 * `TimelinePr`, `InsightPrRef` and `ConsolidatedFeedItem` — all three carry the pair as TRAILING
 * OPTIONAL fields, so an IndexedDB-persisted response written before this feature existed simply
 * reads as unknown.
 */
export function largePrFlag(
  pr: { codeLoc?: number | null; codeLocIsLowerBound?: boolean },
  threshold: number,
): LargePrFlagInfo | null {
  const codeLoc = pr.codeLoc;
  // TRAP 1 — unknown. `== null` catches the undefined of a stale cached payload too.
  if (codeLoc == null) return null;
  // TRAP 3 (and, structurally, TRAP 2) — under the threshold we make no claim in either
  // direction. Note this is the ONLY comparison; there is no `else` branch to get wrong.
  if (codeLoc < threshold) return null;
  const n = codeLoc.toLocaleString();
  const t = threshold.toLocaleString();
  // TRAP 2 — over the threshold a truncated count is still true, so the flag stands; the copy
  // just stops claiming the number is exact.
  const isLowerBound = pr.codeLocIsLowerBound === true;
  return {
    codeLoc,
    isLowerBound,
    label: isLowerBound
      ? `At least ${n} code lines changed — above your ${t} threshold. GitHub truncated the file list, so the real figure is higher.`
      : `${n} code lines changed — above your ${t} threshold.`,
    short: isLowerBound ? `${n}+ code lines` : `${n} code lines`,
  };
}

/* The account's threshold, mirrored into a module cell.
 *
 * Every React surface reads it through `useLargePrThreshold()` (hooks/useLargePr.ts) off
 * `/api/me`. The vis-timeline tooltip CANNOT: `components/Timeline/prBar.ts` builds raw HTML
 * strings for the library and is not a component, so it has no hook to call. Rather than give
 * the timeline its own default — which is how one surface comes to flag a PR the other doesn't —
 * it reads this cell.
 *
 * ⚠ ONE WRITER: `useMe()` in hooks/useTriage.ts, which App.tsx mounts at the root, so the cell
 * is seeded before any board paints. Until /api/me lands it holds the product default, which is
 * also what the server would have resolved for an account that never set one. */
let largePrThresholdCell: number = LARGE_PR_CODE_LOC_DEFAULT;

export function noteLargePrThreshold(n: number | undefined): void {
  largePrThresholdCell = n != null && Number.isInteger(n) && n > 0 ? n : LARGE_PR_CODE_LOC_DEFAULT;
}

export function currentLargePrThreshold(): number {
  return largePrThresholdCell;
}

// The verdicts the auto-merge watcher can WAIT OUT on its own: blocked/behind clear via CI,
// reviews or an update-branch; unknown resolves itself. Conflicts and drafts need a human
// push, which DISARMS the intent — advertising "merge when ready" there would promise a wait
// that can only end by cancelling itself. Deliberately the MergeVerdict vocabulary (no third
// "armable" enum beside canMerge / READY_MERGE_STATES).
const ARM_WAIT_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'blocked',
  'behind',
  'unknown',
]);

/**
 * Whether the dedicated "Merge when ready" control is worth offering — i.e. arming would DO
 * something the plain Merge button doesn't. True while a self-clearing blocker is in the way
 * (blocked / behind / unknown) OR when the PR is mergeable RIGHT NOW but trailing its base
 * (`canMerge && behindBy > 0` — arming updates from trunk first, then lands it). A fully
 * clean, up-to-date PR gets no button (arming it is just a delayed merge — press Merge).
 *
 * Merge-QUEUE repos use the SAME rules: the watcher's terminal action there is "add to the
 * queue" instead of a direct merge, so the button reads "queue when ready". A queue repo's
 * perpetual 'blocked' status makes the button broadly available there — correct, since the
 * enqueue really is gated (on required reviews) until then. A PR already IN the queue is
 * excluded by its own verdict: 'queued' is not a waitable blocker and reports
 * canMerge:false, so both arms of the predicate reject it.
 *
 * ⚠ `behindBy > 0` is true of MOST healthy PRs and only ever WIDENS this button's
 * eligibility. It must never gate the plain Merge button (only the 'behind' VERDICT —
 * mergeStateStatus — means GitHub is blocking), and the verdict passed here must never have
 * been fed `autoMergeArmed` ('armed' reports canMerge:true, which would make an armed PR
 * look like the clean-but-behind case).
 */
export function mergeWhenReadyEligible(input: {
  allowedByRepo: boolean;
  methodCount: number;
  alreadyArmed: boolean;
  verdict: Pick<MergeVerdictInfo, 'verdict' | 'canMerge'>;
  behindBy: number;
}): boolean {
  if (!input.allowedByRepo || input.methodCount === 0 || input.alreadyArmed) {
    return false;
  }
  if (ARM_WAIT_VERDICTS.has(input.verdict.verdict)) return true;
  return input.verdict.canMerge && input.behindBy > 0;
}

export function userLabel(user: User | undefined, fallbackId: number | null): string {
  if (user) return user.displayName || user.githubLogin;
  return fallbackId == null ? 'unknown' : `user ${fallbackId}`;
}

/** GitHub profile URL for a login (e.g. `octocat` → https://github.com/octocat). */
export function profileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

/**
 * Sanitise a URL that came from DATA before putting it in an `href` / `src`.
 *
 * React does NOT protect you here. `<a href={someUrl}>` renders whatever string it is given;
 * for a `javascript:` URL React 18 logs a console warning and then renders it anyway. So a
 * URL that arrived from GitHub is a script-execution sink one click wide.
 *
 * And plenty of these URLs are attacker-influenceable. `checkRuns[].url` is a check run's
 * `details_url` or a commit status's `target_url` — set by whatever third-party CI app posted
 * the status on a watched repository. Same class: ticket links derived from a configurable base
 * URL, and any `html_url` a future GraphQL field returns.
 *
 * The consequence is not theoretical: the dashboard origin is also the API origin, so script
 * running there can drive every write action (post a review, resolve threads, merge) with the
 * caller's own session — or, in local mode, with no credential needed at all.
 *
 * Returns undefined for anything that is not http(s), so `href={safeExternalUrl(u)}` renders a
 * plain non-navigating anchor rather than a live weapon. Callers that need a fallback can do
 * `safeExternalUrl(u) ?? pr.githubUrl`.
 */
export function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let url: URL;
  try {
    // A relative URL is fine and stays relative — base only matters for parsing.
    url = new URL(trimmed, window.location.origin);
  } catch {
    return undefined;
  }
  // Allowlist, not blocklist: `javascript:`, `data:`, `vbscript:`, `blob:` and every future
  // scheme are rejected by default. mailto: is not used in a data-derived href anywhere.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return trimmed;
}

// Prefill for "replying" to a comment: GitHub issue comments are flat (no native
// reply threading), so a reply is a new comment that quotes the original as a `> `
// blockquote and @mentions its author. The user edits from there. Empty bodies
// (e.g. lean mode before hydration) just yield the bare mention.
export function buildQuotedReply(body: string | null, authorLogin: string | null): string {
  const mention = authorLogin ? `@${authorLogin} ` : '';
  const trimmed = (body ?? '').trim();
  if (trimmed === '') return mention;
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n${mention}`;
}

export function indexUsers(users: User[] | undefined): Map<number, User> {
  const map = new Map<number, User>();
  for (const u of users ?? []) map.set(u.id, u);
  return map;
}

// Single source of truth for a plain calendar date. Locale-aware: the runtime
// locale decides field order + separators, so en-GB renders "02/05/2026" (dd/mm/
// yyyy) and en-US "05/02/2026" (mm/dd/yyyy). 2-digit day/month + 4-digit year give
// an unambiguous, stable-width date. Every date the app shows goes through here (or
// dateTime), so the format stays consistent everywhere.
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (abs < min) return 'just now';
  if (abs < hr) return fmt(Math.round(diff / min), 'min');
  if (abs < day) return fmt(Math.round(diff / hr), 'hour');
  if (abs < 30 * day) return fmt(Math.round(diff / day), 'day');
  return formatDate(iso);
}

// Absolute date *with* time of day, e.g. "02/05/2026, 09:04" — the absolute formatter
// for tooltips and anywhere the exact moment must be shown. The date part matches
// formatDate (locale-aware dd/mm/yyyy ordering) for consistency.
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// (The "Watched repo" eye glyph — `WATCHED_TITLE` / `watchedGlyphHtml()` / its React twin
// `<WatchedBadge>` / the `.tl-repo-watch` rule — is DELETED along with the whole "watched"
// concept. A workspace IS the scope now, so every repo in one is fully live and there is no
// per-repo visibility state left for a badge to report.)
