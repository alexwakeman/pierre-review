// THE REVIEW LOOP'S FIX PASS (loop/seed.ts): REVIEW.md lists every open item — findings by severity with
// questions INCLUDED and praise never, criteria and missing items by their own refs, a rejected "not
// applicable" note re-shown with the checker's reason — fenced with the nonce; over the budget the lowest
// priority is left out and NAMED; the instruction names the report and the checker.
import { describe, expect, it } from 'vitest';
import { buildLoopFixInstruction, buildLoopFixSeed, responseLine, type LoopSeedFinding } from './seed.js';

const NONCE = 'feedfacefeedface';
const f = (id: number, severity: LoopSeedFinding['severity'], over: Partial<LoopSeedFinding> = {}): LoopSeedFinding => ({
  findingId: id,
  target: 'acme/api',
  severity,
  path: `src/f${id}.ts`,
  line: id,
  title: `Title ${id}`,
  body: `Body ${id}`,
  suggestion: null,
  earlier: null,
  ...over,
});

describe('buildLoopFixSeed', () => {
  it('orders findings by severity, includes questions, never praise; criteria keep their refs', () => {
    const s = buildLoopFixSeed({
      round: 2,
      rounds: 3,
      root: '/workspace/',
      nonce: NONCE,
      findings: [f(1, 'nit'), f(2, 'praise'), f(3, 'question'), f(4, 'blocker')],
      criteria: [
        { ref: 'AC2', status: 'not_met', text: 'Email the buyer', explanation: 'No email is sent.', rejectedClaim: 'Emails are in scope: the ticket says so.' },
        { ref: 'M1', status: 'missing', text: 'An audit row', explanation: null, rejectedClaim: null },
      ],
    });
    expect(s.shown).toEqual(['F1', 'F2', 'F3', 'AC2', 'M1']);
    expect([...s.refs.entries()].slice(0, 3)).toEqual([
      ['F1', { kind: 'finding', findingId: 4 }],
      ['F2', { kind: 'finding', findingId: 3 }],
      ['F3', { kind: 'finding', findingId: 1 }],
    ]);
    expect(s.text).toContain('# Review round 2 of 3');
    expect(s.text).toContain(`---BEGIN F2 ${NONCE}---`);
    expect(s.text).toContain('A question: answer it.');
    expect(s.text).toContain('You said it does not apply. The story check did not accept that: Emails are in scope');
    expect(s.text).toContain('/workspace/.limn/review-response.json');
    expect(s.text).toContain('node /home/agent/.limn/review-response-check.cjs');
    expect(s.text).not.toContain('Title 2');
    expect(s.leftOut).toEqual([]);
  });

  it('a re-raised finding carries the reviewer\'s words and the earlier answer', () => {
    const s = buildLoopFixSeed({ round: 2, rounds: 3, root: '/w', nonce: NONCE, findings: [f(1, 'warning', { earlier: { reviewer: 'Still no expiry.', agentAnswer: 'I did not change this: sessions expire.' } })], criteria: [] });
    expect(s.text).toContain('Your earlier answer: I did not change this: sessions expire.');
    expect(s.text).toContain('The reviewer on it now: Still no expiry.');
  });

  it('leaves out the lowest priority over the budget, and names how many', () => {
    const big = 'x'.repeat(2_000);
    const s = buildLoopFixSeed({ round: 1, rounds: 1, root: '/w', nonce: NONCE, budget: 4_500, findings: [f(1, 'blocker', { body: big }), f(2, 'nit', { body: big }), f(3, 'nit', { body: big })], criteria: [] });
    expect(s.shown).toEqual(['F1', 'F2']);
    expect(s.leftOut).toEqual([{ kind: 'finding', findingId: 3 }]);
    expect(s.text).toContain('Left out to keep this file short (they come back in the next round): 1 item.');
  });
});

describe('the fix turn and the answers as the next review reads them', () => {
  it('says what to do, and never to push', () => {
    const t = buildLoopFixInstruction({ round: 1, rounds: 3, root: '/workspace', stacked: true });
    expect(t).toContain('round 1 of 3');
    expect(t).toContain('/workspace/REVIEW.md');
    expect(t).toContain('Do not push. Do not open pull requests.');
    expect(t).toContain('rebase the later branches');
    expect(buildLoopFixInstruction({ round: 1, rounds: 3, root: '/w', stacked: false })).not.toContain('rebase');
  });

  it('turns an answer into a reply line', () => {
    expect(responseLine('fixed', 'Added it.')).toBe('Fixed: Added it.');
    expect(responseLine('answered', 'It is right.')).toBe('Answer: It is right.');
    expect(responseLine('pushed_back', 'The caller checks.')).toBe('I did not change this: The caller checks.');
  });
});
