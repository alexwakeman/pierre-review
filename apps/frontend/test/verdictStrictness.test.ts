// THE AUTO VERDICT'S TWO RULES AND THE ONE REASON, ON SCREEN (docs/CLAUDE-REVIEW.md § AUTO VERDICT).
//
//   1. "Not approved: …" — ONE line under the review's verdict (`notApprovedLine`): the server's
//      `notApproved` (recorded, or computed on read when auto-posting is off), else the record's own
//      reason; nothing on an approval; "Posted on GitHub." when it went out alone. The Post-to-GitHub
//      section does not repeat it (`autoVerdictLine`), and a replies pass says it too.
//   2. Settings: "When Claude and Codex disagree" shows ONLY while both are signed in
//      (`pairReviewReady`), with an ⓘ; "Approve with open findings" sits under Approve; both ride Save.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend verdictStrictness
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiKindStatus, AiRunKind, ClaudeRepliesCheckRun, MeResponse } from '@pierre-review/shared';
import { autoVerdictLine, notApprovedLine } from '../src/lib/autoPost.js';
import { pairReviewReady } from '../src/lib/aiCapabilities.js';
import { repliesCheckLine } from '../src/lib/repliesCheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(join(here, '../src', p), 'utf8');

const REASON = 'Not approved: Codex didn’t approve. The binary fixture change cannot be verified from this diff.';

describe('the not-approved line', () => {
  it('prefers the server’s reason; nothing on an approval', () => {
    expect(notApprovedLine({ notApproved: { heldReason: 'pair_strict', text: REASON } })).toBe(REASON);
    expect(notApprovedLine({ notApproved: null, autoPost: null })).toBeNull();
    expect(
      notApprovedLine({
        notApproved: null,
        autoPost: { status: 'posted', verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null } },
      }),
    ).toBeNull();
  });

  it('falls back to the record’s reason, and says when it went out on its own', () => {
    const verdict = { wanted: 'COMMENT' as const, submitted: 'COMMENT' as const, heldReason: 'pair_strict' as const, reasonText: REASON };
    expect(notApprovedLine({ autoPost: { status: 'skipped', verdict } })).toBe(REASON);
    expect(notApprovedLine({ autoPost: { status: 'posted', verdict, reasonOnly: true } })).toBe(`${REASON} Posted on GitHub.`);
  });

  it('the Post-to-GitHub section does not repeat a reason; the old held lines still read', () => {
    const held = { wanted: 'APPROVE' as const, submitted: 'COMMENT' as const, heldReason: 'impact' as const, impact: 'high' as const };
    expect(autoVerdictLine({ status: 'posted', verdict: held })).toBe('Not approved: High impact.');
    expect(autoVerdictLine({ status: 'posted', verdict: { ...held, reasonText: 'Not approved: High impact.' } })).toBeNull();
    expect(autoVerdictLine({ status: 'posted', verdict: { wanted: 'REQUEST_CHANGES', submitted: 'REQUEST_CHANGES', heldReason: null } })).toBe(
      'Requested changes automatically.',
    );
  });

  it('a replies pass says why too, manual and automatic', () => {
    const run = (over: Partial<ClaudeRepliesCheckRun>): ClaudeRepliesCheckRun => ({
      reviewId: 9,
      status: 'succeeded',
      trigger: 'manual',
      createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      error: null,
      accepted: 1,
      disputed: 0,
      notChecked: 0,
      verdict: null,
      autoPost: null,
      ...over,
    });
    const notApproved = { heldReason: 'open_findings' as const, text: 'Not approved: a question is still open.' };
    expect(repliesCheckLine(run({ notApproved }))).toBe('Replies checked 2 hours ago: 1 accepted. Not approved: a question is still open.');
    expect(repliesCheckLine(run({ trigger: 'auto', notApproved }))).toBe(
      'Replies checked 2 hours ago: 1 accepted. Not approved: a question is still open.',
    );
  });

  it('the AI Review tab mounts it under the verdict', () => {
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).toContain('notApprovedLine(storedReview)');
    expect(tab.indexOf('notApprovedLine(storedReview)')).toBeGreaterThan(tab.indexOf('<VerdictBadge verdict={review.verdict} />'));
  });
});

// ---- Settings ----

const KINDS: AiRunKind[] = ['review', 'review_chat', 'fix', 'plan', 'complete'];
const kinds = (s: AiKindStatus): Record<AiRunKind, AiKindStatus> =>
  Object.fromEntries(KINDS.map((k) => [k, s])) as Record<AiRunKind, AiKindStatus>;
function me(o: { claude?: boolean; codex?: boolean }): MeResponse {
  const ok = { auth: 'ok' as const, message: null };
  const none = { auth: 'none' as const, message: 'no' };
  return {
    ai: {
      enabled: true,
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      authMessage: null,
      provider: 'claude',
      providerSetting: { value: 'auto', source: 'settings' },
      providers: {
        claude: { auth: o.claude ? 'ok' : 'none', route: o.claude ? 'login' : 'none', message: null, runtime: 'ready' },
        codex: {
          runtime: 'ready',
          runtimeMessage: null,
          auth: o.codex ? 'ok' : 'none',
          route: o.codex ? 'login' : 'none',
          signedIn: !!o.codex,
          plan: null,
          available: !!o.codex,
          message: null,
          kinds: kinds(o.codex ? ok : none),
        },
      },
    },
  } as unknown as MeResponse;
}

describe('Settings → Auto review', () => {
  it('"When Claude and Codex disagree" is offered only while BOTH are signed in', () => {
    expect(pairReviewReady(me({ claude: true, codex: true }))).toBe(true);
    expect(pairReviewReady(me({ claude: true }))).toBe(false);
    expect(pairReviewReady(me({ codex: true }))).toBe(false);
    expect(pairReviewReady(undefined)).toBe(false);
    const s = src('components/settings/AutoReviewSection.tsx');
    expect(s).toContain('const pairReady = pairReviewReady(useMe().data);');
    // The whole block is behind the gate, with its ⓘ.
    const gate = s.indexOf('{pairReady && (');
    expect(gate).toBeGreaterThan(-1);
    expect(s.indexOf('dark:text-gray-200">When Claude and Codex disagree</legend>')).toBeGreaterThan(gate);
    expect(s).toContain('<InfoButton title="When Claude and Codex disagree">');
    expect(s).toContain('Strict: approve only if both approve');
    expect(s).toContain('Relaxed: approve if one approves and the other raises nothing that blocks');
    expect(s).toMatch(/binary file/);
  });

  it('"Approve with open findings" sits under Approve, with three choices, and both rules ride Save', () => {
    const s = src('components/settings/AutoReviewSection.tsx');
    expect(s.indexOf('Approve with open findings')).toBeGreaterThan(s.indexOf('IMPACT_ROWS.map'));
    for (const label of ['Only when nothing is left open', 'When only nits are left', 'When only nits and questions are left']) {
      expect(s).toContain(label);
    }
    expect(s).toContain('approveLeftovers: leftovers');
    expect(s).toContain('{ pairStrictness: strictness }');
  });
});
