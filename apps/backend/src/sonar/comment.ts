import {
  AUTO_POST_FOOTER,
  SONAR_SEVERITY_LABEL,
  sonarConditionSentence,
  sonarFailingConditions,
  sonarGateItems,
  sonarMetricLabel,
  sonarMetricValue,
  type SonarIssue,
  type SonarSnapshot,
} from '@pierre-review/shared';
import { isFindingAnchored, type AnchorIndex } from '../github/diff-anchor.js';
import { sonarCutSentence } from './gather.js';

// THE ONE GITHUB REVIEW carrying a snapshot's SonarCloud issues (docs/SONARCLOUD.md § Posting): an
// inline thread per issue on a changed line (`sonarInlineBody`) and a summary BODY with everything
// else in full (`sonarCommentBody` with a `splitSonarIssues` split). Detailed enough to fix each issue
// from GitHub alone: rule, severity, location, SonarCloud's message, the flagged lines and the rule's
// own fix guidance. Every body ends with the footer and the hidden marker
// (`<!-- pierre:claude-review…`), so `isLimnPostedComment` knows it and it never re-triggers a review.
//
// ⚠ GITHUB'S LIMIT IS 65,536 CHARACTERS. The body is built under COMMENT_BUDGET; issues that do not
// fit are COUNTED in a closing line ("12 more on SonarCloud"), never silently dropped.
// ⚠ Every SonarCloud string is made safe for our comment (no @-mention pings, no forged marker) —
// the message and code are third-party text. ⚠ PROSE OUTSIDE A CODE FENCE IS HTML-ESCAPED
// (`safeProse`): a rule's guidance quotes its own code examples (`<a target="_blank">`, `</div>`),
// and GitHub renders raw tags in a comment — a quoted `</details>` closed our block early and a
// quoted `<a href>` became a real link posted under the reader's name. Code spans and fences are
// literal already and are NOT escaped (an `&lt;` there would print as typed).

export const SONAR_COMMENT_MARKER = '<!-- pierre:claude-review-sonar v=1 -->';
export const COMMENT_BUDGET = 60_000;

/**
 * Third-party text made safe for OUR comment: no @-mention pings, no HTML comment (a forged marker),
 * one line where one line is asked for. The same rule as ci-review/auto-post.ts `safeCommentText`,
 * repeated here so this module stays free of the review pipeline's imports.
 */
export function safeCommentText(t: string, oneLine = false): string {
  let out = t.replace(/<!--/g, '&lt;!--').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  if (oneLine) out = out.replace(/\s+/g, ' ').trim();
  return out;
}

const TYPE_LABEL: Record<string, string> = {
  BUG: 'Bug',
  VULNERABILITY: 'Vulnerability',
  CODE_SMELL: 'Code smell',
  SECURITY_HOTSPOT: 'Security hotspot',
  QUALITY_GATE: 'Quality gate',
};

/** Third-party PROSE for outside a code fence: escaped so no tag renders, then made safe. */
export function safeProse(t: string, oneLine = false): string {
  return safeCommentText(t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), oneLine);
}

const oneLine = (t: string): string => safeProse(t, true);
const codeSpan = (t: string): string => `\`${safeCommentText(t, true).replace(/`/g, "'")}\``;

function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function where(it: SonarIssue): string | null {
  if (!it.path) return null;
  if (it.line == null) return it.path;
  return it.endLine != null && it.endLine !== it.line ? `${it.path}:${it.line}-${it.endLine}` : `${it.path}:${it.line}`;
}

/** One issue's block. Exported for its test. */
export function issueBlock(it: SonarIssue, n: number): string {
  const lines: string[] = [];
  const type = it.type ? TYPE_LABEL[it.type] ?? it.type : null;
  const head = [SONAR_SEVERITY_LABEL[it.severity], type].filter(Boolean).join(' · ');
  const title = it.ruleName ? oneLine(it.ruleName) : oneLine(it.rule);
  lines.push(`#### ${n}. ${head}: ${title}`);
  const meta = it.kind === 'gate' ? [] : [`Rule ${codeSpan(it.rule)}`];
  const loc = where(it);
  if (loc) meta.push(codeSpan(loc));
  if (it.effort) meta.push(`about ${oneLine(it.effort)} to fix`);
  if (it.securityCategory) meta.push(`category ${codeSpan(it.securityCategory)}`);
  meta.push(`[open in SonarCloud](${it.url})`);
  lines.push(meta.join(' · '));
  lines.push('');
  if (it.message) lines.push(`> ${oneLine(it.message)}`);
  if (it.code.length > 0) {
    const width = String(it.code[it.code.length - 1]!.line).length;
    const text = it.code
      .map((c) => `${c.flagged ? '>' : ' '} ${String(c.line).padStart(width)} | ${c.code.replace(/<!--/g, '<!-​-')}`)
      .join('\n');
    const f = fenceFor(text);
    lines.push('');
    lines.push(`${f}text`);
    lines.push(text);
    lines.push(f);
  }
  if (it.howToFix) {
    lines.push('');
    lines.push('<details><summary>How to fix</summary>');
    lines.push('');
    lines.push(safeProse(it.howToFix));
    lines.push('');
    lines.push('</details>');
  } else if (it.whyIsThisAnIssue) {
    lines.push('');
    lines.push('<details><summary>Why this is an issue</summary>');
    lines.push('');
    lines.push(safeProse(it.whyIsThisAnIssue));
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

function gateLine(s: SonarSnapshot): string | null {
  const g = s.qualityGate;
  if (!g || g.status === 'NONE') return null;
  if (g.status === 'OK') return 'Quality gate: passed.';
  const failed = sonarFailingConditions(g).map((c) => `- ${oneLine(sonarConditionSentence(c))}`);
  const head = `Quality gate: ${g.status === 'ERROR' ? 'failed' : 'warning'}${failed.length > 0 ? ':' : '.'}`;
  return failed.length > 0 ? `${head}\n${failed.join('\n')}` : head;
}

function measuresLine(s: SonarSnapshot): string | null {
  const ms = s.qualityGate?.measures ?? [];
  if (ms.length === 0) return null;
  return `New code: ${ms.map((m) => oneLine(`${sonarMetricLabel(m.metric).replace(/ on new code$/, '')} ${sonarMetricValue(m.metric, m.value)}`)).join(' · ')}.`;
}

/** Is there anything worth a comment? Issues, or a gate that did not pass. */
export function sonarHasSomethingToPost(s: SonarSnapshot): boolean {
  return s.state === 'ok' && (s.issues.length > 0 || s.qualityGate?.status === 'ERROR');
}

export interface SonarCommentBody {
  body: string;
  // Issues carried IN FULL by the body (inline ones not counted).
  issueCount: number;
  truncated: boolean;
}

/**
 * Where each issue of a snapshot goes in the ONE review (docs/SONARCLOUD.md § Posting):
 *   already  threaded inline on an EARLIER head of this PR (by SonarCloud issue key) — named in the
 *            summary, never threaded twice;
 *   inline   its path + line is an addable RIGHT-side line of the live diff — its own thread there;
 *   summary  everything else (no file, no line, a line outside the diff, a noise-stripped file) — in
 *            full in the review body. ⚠ NEVER pinned to the file's first change: a SonarCloud issue
 *            on an unrelated line misleads.
 * `index` null (the diff could not be read) ⇒ nothing is inline.
 */
export interface SonarSplit {
  inline: SonarIssue[];
  already: SonarIssue[];
  summary: SonarIssue[];
}
export function splitSonarIssues(
  issues: readonly SonarIssue[],
  index: AnchorIndex | null,
  alreadyKeys: ReadonlySet<string>,
): SonarSplit {
  const out: SonarSplit = { inline: [], already: [], summary: [] };
  for (const it of issues) {
    if (it.kind !== 'gate' && alreadyKeys.has(it.key)) out.already.push(it);
    else if (it.kind !== 'gate' && index != null && it.path && it.line != null && isFindingAnchored(index, it.path, it.line, 'RIGHT')) {
      out.inline.push(it);
    } else out.summary.push(it);
  }
  return out;
}

/** The hidden marker on a review body: the sonar marker plus a per-ATTEMPT nonce, so the read-back
 *  after a failed POST can only adopt THIS attempt's review. Readers match the prefix only. */
export function sonarReviewMarker(nonce: string): string {
  return SONAR_COMMENT_MARKER.replace(' -->', ` a=${nonce} -->`);
}

const INLINE_GUIDANCE_MAX = 8_000;

/** One issue's INLINE thread body: what, the rule, SonarCloud's message and how to fix it. The line
 *  it sits on is the location. Footer (auto) + the hidden marker, like every Limn body. */
export function sonarInlineBody(it: SonarIssue, opts: { auto: boolean }): string {
  const lines: string[] = [];
  const type = it.type ? TYPE_LABEL[it.type] ?? it.type : null;
  const head = [SONAR_SEVERITY_LABEL[it.severity], type].filter(Boolean).join(' · ');
  const title = it.ruleName ? oneLine(it.ruleName) : oneLine(it.rule);
  lines.push(`**SonarCloud** · ${head}: ${title}`);
  const meta = [`Rule ${codeSpan(it.rule)}`];
  if (it.endLine != null && it.line != null && it.endLine !== it.line) meta.push(`lines ${it.line}-${it.endLine}`);
  if (it.effort) meta.push(`about ${oneLine(it.effort)} to fix`);
  if (it.securityCategory) meta.push(`category ${codeSpan(it.securityCategory)}`);
  meta.push(`[open in SonarCloud](${it.url})`);
  lines.push(meta.join(' · '));
  if (it.message) {
    lines.push('');
    lines.push(`> ${oneLine(it.message)}`);
  }
  const guidance = it.howToFix ? ['How to fix', it.howToFix] : it.whyIsThisAnIssue ? ['Why this is an issue', it.whyIsThisAnIssue] : null;
  if (guidance) {
    const text = guidance[1]!.length > INLINE_GUIDANCE_MAX ? `${guidance[1]!.slice(0, INLINE_GUIDANCE_MAX)}…` : guidance[1]!;
    lines.push('');
    lines.push(`<details><summary>${guidance[0]}</summary>`);
    lines.push('');
    lines.push(safeProse(text));
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');
  if (opts.auto) {
    lines.push(AUTO_POST_FOOTER);
    lines.push('');
  }
  lines.push(SONAR_COMMENT_MARKER);
  return lines.join('\n');
}

/** "Major · Rule name · `src/a.ts:12`" — an issue named in one line (the already-posted list). */
function issueOneLine(it: SonarIssue): string {
  const title = it.ruleName ? oneLine(it.ruleName) : oneLine(it.rule);
  const loc = where(it);
  return [SONAR_SEVERITY_LABEL[it.severity], title, loc ? codeSpan(loc) : null].filter(Boolean).join(' · ');
}

/**
 * The body for a snapshot, within COMMENT_BUDGET: the lead, the gate, the measures and the link, then
 * (with a `split`) how many went inline and which were already on GitHub, then every summary issue in
 * full. Without a split every issue goes in full (the older one-comment shape).
 */
export function sonarCommentBody(
  s: SonarSnapshot,
  opts: { auto: boolean; budget?: number; split?: SonarSplit; marker?: string },
): SonarCommentBody {
  const budget = opts.budget ?? COMMENT_BUDGET;
  const split = opts.split ?? { inline: [], already: [], summary: s.issues };
  const head: string[] = [];
  head.push(`**SonarCloud** on ${s.headSha.slice(0, 7)}: ${sonarCutSentence(s.issues.length, s.totalIssues, s.totalHotspots)}.`);
  const gate = gateLine(s);
  if (gate) head.push(gate);
  const measures = measuresLine(s);
  if (measures) head.push(measures);
  if (s.dashboardUrl) head.push(`[See the analysis on SonarCloud](${s.dashboardUrl})`);
  const k = split.inline.length;
  if (k > 0) head.push(`${k} ${k === 1 ? 'issue is' : 'issues are'} on the changed lines, as comments there.`);
  if (split.already.length > 0) {
    head.push(
      `Already on GitHub from an earlier commit:\n${split.already.map((it) => `- ${issueOneLine(it)}`).join('\n')}`,
    );
  }
  const tail: string[] = [];
  if (opts.auto) tail.push(AUTO_POST_FOOTER);
  tail.push(opts.marker ?? SONAR_COMMENT_MARKER);

  const blocks: string[] = [];
  let used = head.join('\n\n').length + tail.join('\n\n').length + 200;
  // The failing coverage / duplication conditions first, with the files behind each (not counted
  // as issues: the counts are SonarCloud's own).
  const gateItems = sonarGateItems(s.qualityGate, s.dashboardUrl);
  gateItems.forEach((it, i) => {
    const b = issueBlock(it, i + 1);
    blocks.push(b);
    used += b.length + 2;
  });
  let n = 0;
  for (const it of split.summary) {
    const b = issueBlock(it, gateItems.length + n + 1);
    if (n > 0 && used + b.length + 2 > budget) break;
    // The first block always goes in, clipped if it alone is over the budget.
    blocks.push(b.length + used > budget ? `${b.slice(0, Math.max(0, budget - used - 20))}\n…(cut)` : b);
    used += b.length + 2;
    n += 1;
  }
  const left = split.summary.length - n;
  const parts = [head.join('\n\n'), ...blocks];
  if (left > 0) parts.push(`${left} more ${left === 1 ? 'issue' : 'issues'} did not fit in this comment. See them on SonarCloud.`);
  parts.push(tail.join('\n\n'));
  return { body: parts.join('\n\n'), issueCount: n, truncated: left > 0 };
}
