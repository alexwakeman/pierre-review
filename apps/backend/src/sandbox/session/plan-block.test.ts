import { describe, expect, it } from 'vitest';
import { BUILD_PLAN_MAX_BYTES, hidePartialPlanText } from '@pierre-review/shared';
import { extractPlanBlock, stripPlanBlock } from './plan-block.js';

const block = (body: string, fence = '```'): string => `${fence}limn-plan\n${body}\n${fence}`;

describe('extractPlanBlock', () => {
  it('takes the last limn-plan block, across texts', () => {
    expect(extractPlanBlock([`Plan:\n${block('{"a":1}')}\nand\n${block('{"a":2}')}`])).toEqual({ kind: 'found', body: '{"a":2}' });
    expect(extractPlanBlock([block('{"a":1}'), 'A later text with no block.'])).toEqual({ kind: 'found', body: '{"a":1}' });
    expect(extractPlanBlock([block('{"a":1}'), block('{"a":3}')])).toEqual({ kind: 'found', body: '{"a":3}' });
  });
  it('none: no block, another info string, or a block inside another fence', () => {
    expect(extractPlanBlock(['Just words.'])).toEqual({ kind: 'none' });
    expect(extractPlanBlock(['```json\n{}\n```'])).toEqual({ kind: 'none' });
    expect(extractPlanBlock([`\`\`\`\`markdown\n${block('{"a":1}')}\n\`\`\``])).toEqual({ kind: 'none' });
    expect(extractPlanBlock([`\`\`\`text\nexample:\n\`\`\`limn-plan\n{}\n`])).toEqual({ kind: 'none' });
  });
  it('refuses a block over the cap', () => {
    const r = extractPlanBlock([block(`"${'x'.repeat(BUILD_PLAN_MAX_BYTES)}"`)]);
    expect(r.kind).toBe('too_large');
  });
  it('a multi-line body is kept as it is', () => {
    expect(extractPlanBlock([block('{\n  "a": 1\n}')])).toEqual({ kind: 'found', body: '{\n  "a": 1\n}' });
  });
});

describe('stripPlanBlock / hidePartialPlan', () => {
  it('replaces the block with one line', () => {
    expect(stripPlanBlock(`The plan, in short.\n\n${block('{"a":1}')}\n`, 'Plan submitted: revision 1.')).toBe('The plan, in short.\n\nPlan submitted: revision 1.');
    expect(stripPlanBlock('No block.', 'x')).toBeNull();
  });
  it('hides a block still being written', () => {
    expect(hidePartialPlanText('Short plan.\n```limn-plan\n{"sch', 'Writing the plan…')).toBe('Short plan.\n\nWriting the plan…');
    expect(hidePartialPlanText('No block yet', 'x')).toBe('No block yet');
  });
});
