import { createHash } from 'node:crypto';
import { acceptanceSectionOf, extractCriteria } from './story-criteria.js';

// WHAT THE STORY LABELLER IS SENT — and therefore WHICH label is current. Pure (story-label-input.
// test.ts). ONE builder, two callers: the label run (review/story-labels/) sends exactly this, and
// Story health (db/story-health.ts) recomputes it to decide whether a stored label is CURRENT — a
// label counts only while its `text_hash` equals today's hash of today's text, so an edited ticket
// falls out of the series until it is labelled again.
//
//   • CRITERIA come from the ONE extractor (db/story-criteria.ts `extractCriteria`) over the
//     tracker's criteria field, else the "Acceptance criteria" section of the description — the same
//     text and the same rule as Reports → Stories' criteria count, so "12 criteria" on one screen is
//     the 12 the labeller judged. No criteria → not labellable (null), never "0 criteria labelled".
//   • The DESCRIPTION is sent with Jira colour markup stripped and clipped; each criterion is clipped.
//     The clip is inside the hash, so a change past the clip does not relabel (nothing new was sent).
//   • The hash also folds the provider's text rule (`jira`), since `# ` means a list item in Jira and
//     a heading in Markdown — the same bytes can be different criteria.

export const STORY_LABEL_DESCRIPTION_MAX_CHARS = 2500;
export const STORY_LABEL_CRITERION_MAX_CHARS = 500;
const COLOR_RE = /\{color[^}]*\}/g;

export interface StoryLabelInput {
  title: string;
  description: string;
  criteria: string[];
  source: 'acceptance_criteria' | 'description_heading';
  /** sha256 hex of exactly what is sent. */
  textHash: string;
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
};

/** The labeller's input for a stored ticket, or null when it has no criteria to judge. */
export function storyLabelInput(
  ticket: { title: string | null; description: string | null; acceptanceCriteria: string | null } | null,
  provider: string,
): StoryLabelInput | null {
  if (ticket == null) return null;
  const jira = provider === 'jira';
  let source: StoryLabelInput['source'] = 'acceptance_criteria';
  let criteria = extractCriteria(ticket.acceptanceCriteria, { jira });
  if (criteria.length === 0) {
    const section = acceptanceSectionOf(ticket.description, { jira });
    criteria = section == null ? [] : extractCriteria(section, { jira });
    source = 'description_heading';
  }
  if (criteria.length === 0) return null;
  const title = (ticket.title ?? '').trim();
  const description = clip((ticket.description ?? '').replace(COLOR_RE, ''), STORY_LABEL_DESCRIPTION_MAX_CHARS);
  const sent = criteria.map((c) => clip(c, STORY_LABEL_CRITERION_MAX_CHARS));
  const textHash = createHash('sha256')
    .update(JSON.stringify({ jira, title, description, criteria: sent }))
    .digest('hex');
  return { title, description, criteria: sent, source, textHash };
}
