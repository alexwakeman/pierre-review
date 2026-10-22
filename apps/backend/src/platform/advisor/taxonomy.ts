// The advisor's category taxonomy — the TEMPLATED slot data. Pure constants: canonical
// negative ("stop flagging …") and positive ("prioritize …") phrasing per ML category, used
// verbatim by the prose emitter and as `path_instructions` text by the structured emitters.
// The recommendation itself is NEVER model-generated; the one LLM touchpoint (refine/) may
// only reword these sentences inside a managed marker block, and the deterministic version is
// always retained.
//
// `import type` only from shared (the plugin must never take a runtime dependency on the
// types-only package), so the category list is re-declared here as a typed constant.
import type { MlCategory } from '@pierre-review/shared';

export interface CategoryPhrasing {
  label: string;
  // The suppression slot: what to tell the bot to STOP doing. Written to be true at the
  // category grain ("comments like these"), never about a specific finding.
  negative: string;
  // The amplification slot: what to ask the bot to do MORE of / rank higher.
  positive: string;
}

// All nine categories the severity-api emits (praise is labelled work but never a finding —
// it appears here only so lookups are total; no intent ever targets it).
export const ADVISOR_CATEGORIES: readonly MlCategory[] = [
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise',
];

export const CATEGORY_PHRASING: Record<MlCategory, CategoryPhrasing> = {
  correctness_bug: {
    label: 'Correctness bugs',
    negative:
      'Do not flag speculative correctness issues without a concrete failure scenario (inputs and the wrong outcome).',
    positive:
      'Prioritize correctness: concrete bugs with a reproducible failure scenario outrank every stylistic finding.',
  },
  security: {
    label: 'Security',
    negative:
      'Do not raise generic security boilerplate (e.g. blanket injection warnings) where the data flow shown cannot reach an attacker-controlled input.',
    positive:
      'Prioritize security findings: authentication/authorization gaps, injection risks, and secrets handling should be raised even at low confidence.',
  },
  performance: {
    label: 'Performance',
    negative:
      'Do not flag micro-optimizations without evidence the code is on a hot path; skip performance comments on tests and one-off scripts.',
    positive:
      'Prioritize algorithmic and query-shape performance issues (N+1 access, unbounded scans, quadratic loops over user data).',
  },
  style_readability: {
    label: 'Style & readability',
    negative:
      'Do not post style or readability comments; the linters own formatting and naming here.',
    positive:
      'Readability comments are welcome where they change how the next reader acts (misleading names, non-obvious control flow).',
  },
  maintainability_refactor: {
    label: 'Maintainability / refactoring',
    negative:
      'Do not propose refactors that are out of scope for the change under review; keep suggestions to the touched code.',
    positive:
      'Prioritize maintainability findings on duplicated logic and layering violations introduced by the change itself.',
  },
  testing: {
    label: 'Testing',
    negative:
      'Do not request tests reflexively on every change; flag missing tests only where the change alters observable behavior.',
    positive:
      'Prioritize test-coverage findings on behavior-changing code paths and bug fixes without a regression test.',
  },
  documentation: {
    label: 'Documentation',
    negative:
      'Do not request docstrings, comments, or documentation updates; documentation is reviewed separately here.',
    positive:
      'Prioritize documentation findings where a public API contract changed without its documentation.',
  },
  nitpick: {
    label: 'Nitpicks',
    negative:
      'Do not post nitpick-level comments (typos, trivial phrasing, cosmetic preferences); batch them or drop them.',
    positive:
      'Nitpicks are acceptable here when batched into a single summary comment rather than one thread each.',
  },
  praise: {
    label: 'Praise',
    negative: 'Do not post praise-only comments.',
    positive: 'A short praise note on genuinely unusual work is welcome.',
  },
};

// The LOWER_VERBOSITY slot (severity, not category): the one sentence both the prose emitter
// and CodeRabbit's `profile` mapping key on.
export const SEVERITY_FLOOR_PHRASING = {
  negative:
    'Raise the severity floor: do not post nitpick-level findings as individual comments — reserve comments for minor and above.',
  positive: 'Keep the current severity floor.',
} as const;
