// PROMOTE_TO_LINT — DeepSource-only title-template extraction (T4). Measured on the dev
// corpus: first-backtick truncation collapses 1,908 DeepSource titles into ~250 templates,
// with the top 20 covering 37% — a rule-shaped distribution worth naming. Generic rule-ID
// regexes on other vendors measured ≤8% yield and are NOT built (v1 scope).
//
// Output feeds `deriveIntents`'s `lintTemplates` option as SHARPENED ADVISORY TEXT
// ("rule-template × fires × acted-on") — never config emission. Pure functions over comment
// rows the route prefetched via ctx.queries.getBotReviewComments.
import type { LintTemplateStat } from '../intents.js';

export interface LintCommentRow {
  botUserId: number;
  body: string;
  actedOn: boolean;
}

// A rule title is short prose. DeepSource's run-summary comments open with a full HTML
// banner (<h2><picture>…) — frequent enough to cross the fires floor and surface a "rule"
// that is markup, not a rule. Anything tag-shaped or over-long is not a template.
const TEMPLATE_MAX_CHARS = 120;

// The template = the first line, truncated at the first backtick (DeepSource titles embed
// the varying identifier in backticks: "Unused variable `foo` found" → "Unused variable").
export function titleTemplate(body: string): string | null {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return null;
  const backtick = firstLine.indexOf('`');
  const template = (backtick === -1 ? firstLine : firstLine.slice(0, backtick)).trim();
  // Markdown heading/bold prefixes carry no signal — strip a leading run of #/* chars.
  const clean = template.replace(/^[#*\s]+/, '').replace(/[*:\s]+$/, '');
  if (clean.includes('<') || clean.length > TEMPLATE_MAX_CHARS) return null;
  return clean.length >= 8 ? clean : null; // too short to be a rule title
}

export function extractLintTemplates(rows: LintCommentRow[]): LintTemplateStat[] {
  const byKey = new Map<string, LintTemplateStat>();
  for (const row of rows) {
    const template = titleTemplate(row.body);
    if (!template) continue;
    const key = `${row.botUserId}|${template}`;
    let stat = byKey.get(key);
    if (!stat) {
      stat = { botUserId: row.botUserId, template, fires: 0, actedOn: 0 };
      byKey.set(key, stat);
    }
    stat.fires += 1;
    if (row.actedOn) stat.actedOn += 1;
  }
  return [...byKey.values()].sort(
    (a, b) => b.fires - a.fires || a.template.localeCompare(b.template),
  );
}
