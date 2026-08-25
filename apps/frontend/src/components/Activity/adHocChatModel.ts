import { PRESET_PROMPTS } from '@pierre-review/shared';

// The ad-hoc chat's suggestion-pill model — pure (no React, no store) so the grouping rules and
// the pill prompts are unit-testable from `test/` without mounting the panel.

// One clickable suggestion: `label` is the pill caption, `question` the text submitted.
export interface SuggestionPill {
  label: string;
  question: string;
}

// Quick-question pills — the former "Sprint questions" presets plus two catch-alls (sprint report,
// retro), folded into the one chat panel. So the four old surfaces (Sprint report card, preset
// carousel, the Retro sub-tab, chat) collapse to one, and every answer comes from the single
// grounded chat endpoint.
const SPRINT_REPORT_PROMPT =
  'Give me a sprint status report: overall flow health, what needs attention now, the biggest changes shipped this sprint, and any blockers.';
// The retrospective catch-all — this REPLACES the deleted Insights "Retro" sub-tab, its route and
// its own `retro_reports` cache. Paired with the sprint report as the two catch-alls: that one is
// forward-looking ("what needs attention now"), this one backward-looking ("what just happened").
//
// It asks for a short narrative followed by ONE GFM pipe table of the retro items — the renderer
// (SummaryMarkdown/parseBlocks) parses pipe tables into a real table in PrTable's visual shell,
// with owner/name#N refs in cells still linkifying. The Category vocabulary is pinned in the
// prompt (shipped / went well / dragged / CI) so rows stay scannable across runs.
//
// It deliberately asks ONLY for what the chat's grounding payload actually holds — merged PRs,
// flow metrics, CI failure reasons, attention items. NOT themes or sentiment: those needed the
// retro's own 50-item corpus of raw comment/review bodies, which buildChatPayload has no
// equivalent of, so asking would just trip CHAT_SYSTEM's "the JSON doesn't hold the answer"
// decline and burn a third of a ~200-word answer. Discussion themes live in the Feed's Pro
// "Themes" tab instead.
//
// Frontend-LOCAL const, exactly like SPRINT_REPORT_PROMPT and for the same reason — NOT an entry
// in shared's PRESET_PROMPTS. A new PresetPromptKey is consumed by the plugin as two EXHAUSTIVE
// Record<PresetPromptKey, string> maps (PRESET_QUESTIONS + a bespoke per-key system prompt), so
// it would be an immediate compile error in packages/pro plus a new cache-row kind and a new
// independent throttle/billing path — for a pill that only needs to prefill the chat box.
// ⚠ Every pill prompt must stay ≤500 chars — the server's MAX_QUESTION truncates SILENTLY, and a
// mid-sentence cut would ship a live mispowered pill with no error anywhere. Pinned by
// `test/sprintChatThread.test.ts`.
const RETRO_PROMPT =
  'Give me a retrospective of this sprint: start with a short narrative summary (2-3 sentences), then ONE GitHub-flavoured markdown pipe table of the retro items with columns Item | Category | PRs | Note. Category is one of: shipped, went well, dragged, CI. Put PR references in the PRs column as plain owner/name#N.';
// The workspace-orientation catch-all: what is this set of repos FOR, and what is it busy with
// right now. Grounded in the payload's `repos` map (each repo's GitHub "About" description — the
// only real purpose text the payload carries) plus the merged/open PR activity.
const WORKSPACE_ABOUT_PROMPT =
  'What does this workspace do, and what are its latest priorities? Using the repo descriptions and recent PR activity in the JSON, give one line per repository on its purpose, then a short list of the current priorities and themes across the workspace.';
export const QUICK_QUESTIONS: SuggestionPill[] = [
  { label: 'Sprint report', question: SPRINT_REPORT_PROMPT },
  { label: 'Retro', question: RETRO_PROMPT },
  { label: 'About this Workspace', question: WORKSPACE_ABOUT_PROMPT },
  ...PRESET_PROMPTS.map((p) => ({ label: p.label, question: p.question })),
];

// One labelled pill group under the transcript. Report-derived pills and the built-ins are
// DIFFERENT claims — one is templated from the viewed report's own significant deltas (numbers
// computed client-side, D4-legal), the other is generic — so they render as two captioned groups
// rather than one undifferentiated row. Splitting them also removes the old merged array's
// latent duplicate-`key` risk: React keys only need uniqueness among siblings, and each group
// maps its own children.
export interface SuggestionGroup {
  key: 'report' | 'builtin';
  title: string;
  pills: SuggestionPill[];
}

// The report group exists only when the caller passed pills — structurally only when a report is
// on screen, since the sole mount derives them from the viewed report and passes none otherwise.
// The built-ins always render.
export function suggestionGroups(suggested?: SuggestionPill[]): SuggestionGroup[] {
  const groups: SuggestionGroup[] = [];
  if (suggested != null && suggested.length > 0) {
    groups.push({ key: 'report', title: 'From this report', pills: suggested });
  }
  groups.push({ key: 'builtin', title: 'Quick questions', pills: QUICK_QUESTIONS });
  return groups;
}
