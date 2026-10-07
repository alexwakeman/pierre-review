import type { JiraAcCandidate, JiraAcMatch } from '@pierre-review/shared';
import { adfToText, isAdfDoc, jiraWikiToMarkdown, normaliseJiraText } from './text.js';

// WHERE MIGHT THIS TICKET'S ACCEPTANCE CRITERIA BE? — the candidate list behind the Claude Review
// panel's "Acceptance criteria from" dropdown.
//
// Acceptance criteria is not a standard Jira field. It is a custom field whose id differs per site,
// real sites often carry SEVERAL fields named for it, and the one that is filled in varies by issue
// type. A single per-workspace choice was tried first and was unusable, so the choice is now made
// per ticket, from the ticket itself: every CUSTOM field whose value on THIS ticket is non-empty
// TEXT is a candidate, with its id, display name and whole text. The reader picks; the SPA
// preselects (a remembered choice for the issue type, else the best name match).
//
// What counts as text: a string (wiki markup, kept verbatim), an Atlassian Document Format value
// (flattened), or a single-select option (`{value: "…"}`). Everything else is skipped — arrays
// (multi-selects, labels, checklists), numbers, users, dates, and objects without a plain `value`.
//
// ⚠ NEVER TRUNCATED. A candidate carries its field's whole text; the panel's own check flags a
// value over the caps. What IS bounded is the COUNT (`JIRA_AC_CANDIDATE_CAP`), after ranking, so the
// weakest candidates are the ones cut and the response says how many.

/** The most candidate fields one response carries. Ranked first, then cut. */
export const JIRA_AC_CANDIDATE_CAP = 50;

const STRONG = /acceptance[\s_-]*criteri(a|on)/i;
const WEAK = /\bAC\b|definition[\s_-]*of[\s_-]*done/i;

export function acNameMatch(name: string): JiraAcMatch {
  if (STRONG.test(name)) return 'strong';
  if (WEAK.test(name)) return 'weak';
  return null;
}

// ── exclusions: fields that hold text-shaped values but are never content ────────────────────

// Jira `schema.type`s that are never prose, whatever the value looks like.
const EXCLUDED_TYPES = new Set([
  'date',
  'datetime',
  'number',
  'user',
  'group',
  'project',
  'priority',
  'status',
  'resolution',
  'issuetype',
  'issuelink',
  'securitylevel',
  'version',
  'component',
  'sd-servicelevelagreement',
  'sd-approvals',
  'sd-customerrequesttype',
  'sd-feedback',
]);

// `schema.custom` plugin keys: Jira Software's rank / sprint / epic / parent fields and the
// development panel's metadata (which Cloud returns as a "{}"-shaped string).
const EXCLUDED_CUSTOM =
  /gh-lexo-rank|gh-sprint|gh-epic|gh-parent|devsummary|jira-development-integration|pyxis\.greenhopper\.jira:gh-global-rank|vp-origin|sd-sla-field|sd-request-feedback|jpo-custom-field-parent|jpo-custom-field-baseline|flagged|servicedesk:sd-customer-organizations/i;

// Names that are never acceptance criteria even when a plugin gives them a string value.
const EXCLUDED_NAMES =
  /^(rank|sprint|epic (link|name|status|colou?r)|parent( link)?|development|story points?( estimate)?|flagged|team|start date|due date|target (start|end)|original story points|vulnerability)$/i;

// String values that are metadata, not prose.
const NUMERIC = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+([+-]\d{2}:?\d{2}|Z)?)?$/;
const BRACED = /^\{[\s\S]*\}$/; // "{}", "{pullrequest={dataType=pullrequest, …}}"

interface FieldSchema {
  type?: unknown;
  custom?: unknown;
}

/** A field value → its text, or null when it is not a text value (or is empty). */
export function candidateText(value: unknown): string | null {
  let text: string | null = null;
  // A text field answers WIKI MARKUP (REST v2), rewritten to markdown exactly as the description
  // is (client.ts), so the panel renders the criteria the way it renders the description.
  if (typeof value === 'string') text = jiraWikiToMarkdown(normaliseJiraText(value));
  else if (isAdfDoc(value)) text = adfToText(value);
  else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // A single-select option: `{self, value, id}`. Only a plain string `value` is read.
    const v = (value as Record<string, unknown>).value;
    if (typeof v === 'string') text = normaliseJiraText(v);
  }
  if (text == null || text === '') return null;
  if (NUMERIC.test(text) || ISO_DATE.test(text) || BRACED.test(text)) return null;
  return text;
}

function excluded(id: string, name: string, schema: FieldSchema | undefined): boolean {
  if (!/^customfield_\d{1,12}$/.test(id)) return true; // summary, description and every system field
  if (EXCLUDED_NAMES.test(name.trim())) return true;
  if (schema) {
    if (typeof schema.type === 'string' && EXCLUDED_TYPES.has(schema.type)) return true;
    if (typeof schema.custom === 'string' && EXCLUDED_CUSTOM.test(schema.custom)) return true;
  }
  return false;
}

const RANK: Record<string, number> = { strong: 0, weak: 1, none: 2 };

/**
 * Every custom text field on one ticket, ranked — strong name matches, then weak, then the rest,
 * each group by name then id — and capped at `JIRA_AC_CANDIDATE_CAP`.
 *
 * `fields` is the issue's `fields` object, `names` the `expand=names` id→name map and `schemas` the
 * `expand=schema` id→schema map (either may be absent; a field with no name is named by its id).
 */
export function extractAcCandidates(
  fields: Record<string, unknown>,
  names: Record<string, unknown> | undefined,
  schemas: Record<string, unknown> | undefined,
): { candidates: JiraAcCandidate[]; omitted: number } {
  const all: JiraAcCandidate[] = [];
  for (const [id, value] of Object.entries(fields)) {
    const rawName = names?.[id];
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : id;
    const schema = schemas?.[id];
    if (excluded(id, name, typeof schema === 'object' && schema !== null ? (schema as FieldSchema) : undefined))
      continue;
    const text = candidateText(value);
    if (text == null) continue;
    all.push({ id, name, text, match: acNameMatch(name) });
  }
  all.sort(
    (a, b) =>
      (RANK[a.match ?? 'none'] ?? 2) - (RANK[b.match ?? 'none'] ?? 2) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  const candidates = all.slice(0, JIRA_AC_CANDIDATE_CAP);
  return { candidates, omitted: all.length - candidates.length };
}
