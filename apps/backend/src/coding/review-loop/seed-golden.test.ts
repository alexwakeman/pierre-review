// THE LOOP SEED'S GOLDENS (coding/review-loop/seed.ts): the words the fix agent gets after a review round.
//   • Build's fix-turn message (`buildLoopFixInstruction`) is BYTE-IDENTICAL to what it was before AI Fix's loop
//     (AI Fix has its own builder);
//   • AI Fix's REVIEW.md and fix-turn message (`subject: 'fix'`, `buildAiFixLoopFixInstruction`) are pinned.
// A deliberate change of these words regenerates the file: LIMN_WRITE_GOLDEN=1 vitest run seed-golden.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAiFixLoopFixInstruction, buildLoopFixInstruction, buildLoopFixSeed } from './seed.js';

const FILE = new URL('./__fixtures__/loop-seed-golden.json', import.meta.url);

function now(): Record<string, string> {
  const seed = (subject: 'build' | 'fix') =>
    buildLoopFixSeed({
      subject,
      round: 2,
      rounds: 5,
      root: '/workspace',
      nonce: 'feedfacefeedface',
      findings: [
        { findingId: 7, target: 'acme/api', severity: 'blocker', path: 'src/refund.ts', line: 12, title: 'No amount check', body: 'A negative amount is refunded.', suggestion: 'if (amount <= 0) throw …', earlier: null },
        { findingId: 8, target: 'acme/api', severity: 'question', path: 'src/refund.ts', line: null, title: 'Is the email async?', body: 'It blocks the request.', suggestion: null, earlier: { reviewer: 'Still blocking.', agentAnswer: 'I did not change this: it is fast.' } },
      ],
      criteria: [{ ref: 'AC2', status: 'not_met', text: 'Email the buyer', explanation: 'No email is sent.', rejectedClaim: null }],
    }).text;
  return {
    buildInstruction: buildLoopFixInstruction({ round: 2, rounds: 5, root: '/workspace', stacked: false }),
    buildInstructionStacked: buildLoopFixInstruction({ round: 1, rounds: 3, root: '/workspace/', stacked: true }),
    buildSeed: seed('build'),
    aiFixInstruction: buildAiFixLoopFixInstruction({ round: 2, rounds: 5, root: '/workspace/', repoPath: '/workspace/acme/api' }),
    aiFixSeed: seed('fix'),
  };
}

describe('the loop seed goldens', () => {
  it('match byte for byte', () => {
    const got = now();
    if (process.env.LIMN_WRITE_GOLDEN === '1' || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(got, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    expect(got).toEqual(golden);
  });
});
