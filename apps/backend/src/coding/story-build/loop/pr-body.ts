// THE REVIEW LOOP'S SECTION OF THE PR BODY (docs/STORY-BUILD.md § The review loop → Opening the pull
// request). PURE. People who never saw Limn read it on GitHub: plain, short, every quoted text defanged
// (mentions too: it is the PR BODY, where an `@name` notifies — `mentions: false` is for commit messages).
import type { AiProviderId } from '@pierre-review/shared';
import { aiProviderName } from '@pierre-review/shared';
import { defangGithubText } from '../push.js';

/** The section is clipped to this many characters (the whole body stays under GitHub's cap). */
export const LOOP_BODY_MAX = 6_000;
const STILL_OPEN_MAX = 10;

export interface LoopBodySummary {
  /** Reviews that ran (the closing one included). */
  reviews: number;
  providers: AiProviderId[];
  fixed: number;
  answered: number;
  pushedBackAccepted: number;
  stillOpen: Array<{ severity: string; path: string; title: string }>;
  criteria: { met: number; notApplicable: Array<{ ref: string; why: string }>; notMet: number } | null;
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** The `## Review in Limn` section (no trailing newline). */
export function loopBodySection(s: LoopBodySummary): string {
  const lines: string[] = ['## Review in Limn', ''];
  const who = s.providers.length > 0 ? s.providers.map((p) => aiProviderName(p)).join(' and ') : 'Limn';
  lines.push(`Reviewed ${s.reviews === 1 ? 'once' : `${s.reviews} times`} by ${who} before this pull request opened.`);
  lines.push('');
  lines.push(`Fixed: ${s.fixed} · Answered: ${s.answered} · Pushed back and accepted: ${s.pushedBackAccepted} · Still open: ${s.stillOpen.length}`);
  if (s.criteria) {
    const na = s.criteria.notApplicable;
    const naText = na.length === 0 ? '0 not applicable' : `${na.length} not applicable (${na.map((x) => `${defangGithubText(oneLine(x.ref, 20))}: ${defangGithubText(oneLine(x.why, 160))}`).join('; ')})`;
    lines.push('');
    lines.push(`Acceptance criteria: ${s.criteria.met} met, ${naText}, ${s.criteria.notMet} not met.`);
  }
  if (s.stillOpen.length > 0) {
    lines.push('', 'Still open:');
    for (const f of s.stillOpen.slice(0, STILL_OPEN_MAX)) {
      lines.push(`- ${f.severity} · ${defangGithubText(oneLine(`${f.path}: ${f.title}`, 200)).replace(/[[\]]/g, '')}`);
    }
    if (s.stillOpen.length > STILL_OPEN_MAX) lines.push(`- and ${s.stillOpen.length - STILL_OPEN_MAX} more`);
  }
  return clip(lines.join('\n'), LOOP_BODY_MAX);
}
