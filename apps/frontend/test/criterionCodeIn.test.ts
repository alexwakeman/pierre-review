// An unmet criterion's evidence in OTHER PRs goes into the ref's popover ("Code in"), never under
// the row (2026-11-03). Only the viewed PR's own files stay under the row.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TicketReviewMember } from '@pierre-review/shared';
import { criterionDoneIn, evidenceElsewhere } from '../src/components/TicketReviewParts.js';

const member = (prId: number, repo: string, number: number): TicketReviewMember =>
  ({ prId, repo, repoId: prId, number, title: null, checkedOut: true }) as unknown as TicketReviewMember;
const members = [member(1, 'acme/web', 12), member(2, 'acme/api', 88), member(3, 'acme/docs', 4)];

describe('evidenceElsewhere', () => {
  it('groups the evidence by member PR, skipping the viewed PR, the "Done in" PRs and unknown PRs', () => {
    const c = {
      evidence: [
        { prId: 1, path: 'src/a.ts', line: 3 },
        { prId: 2, path: 'src/b.ts', line: null },
        { prId: 2, path: 'src/c.ts', line: 9 },
        { prId: 2, path: 'src/c.ts', line: 9 },
        { prId: 3, path: 'README.md', line: 1 },
        { prId: 99, path: 'x.ts', line: 1 },
      ],
    };
    const out = evidenceElsewhere(c, members, 1, [members[2] as TicketReviewMember]);
    expect(out.map((e) => e.member.prId)).toEqual([2]);
    expect(out[0]?.paths).toHaveLength(2);
  });

  it('in the story view (no viewed PR) every member PR is named', () => {
    const c = { evidence: [{ prId: 1, path: 'a.ts', line: 1 }, { prId: 2, path: 'b.ts', line: 2 }] };
    expect(evidenceElsewhere(c, members, null).map((e) => e.member.prId)).toEqual([1, 2]);
  });

  it('the unmet row draws only the viewed PR’s own evidence; the rest is behind the ref', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/TicketReviewParts.tsx', import.meta.url)), 'utf8');
    const row = src.slice(src.indexOf('export function CriterionRow('), src.indexOf('/** The member PRs that deliver'));
    expect(row).toMatch(/ownEvidence\.map\(/);
    expect(row).not.toMatch(/c\.evidence\.map\(/);
    expect(row).toMatch(/<CriterionRef label=\{c\.ref\} doneIn=\{doneIn\} codeIn=\{codeIn\}/);
    expect(src).toMatch(/>Code in</);
  });

  it('a NOT MET row names its evidence PRs under "Code in", never "Done in" (the server puts them in deliveredBy)', () => {
    const notMet = { status: 'not_met' as const, deliveredBy: [2, 3], evidence: [{ prId: 2, path: 'src/c.ts', line: 9 }] };
    expect(criterionDoneIn(notMet, members).map((m) => m.prId)).toEqual([3]);
    expect(evidenceElsewhere(notMet, members, 1, criterionDoneIn(notMet, members)).map((e) => e.member.prId)).toEqual([2]);
    // Partly met: the evidence PR did part of it, so it stays "Done in".
    const partly = { ...notMet, status: 'partly_met' as const };
    expect(criterionDoneIn(partly, members).map((m) => m.prId)).toEqual([2, 3]);
  });
});
