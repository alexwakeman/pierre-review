import { describe, expect, it } from 'vitest';
import { MAX_FINISH_ATTEMPTS, judgeFinish, judgeRecord, newBuildState, outstanding, progressReply } from './build-judge.js';

describe("the build agent's tools, judged by the server", () => {
  it("'sections' mode records only the server's files, and finishes only when each has a summary", () => {
    const st = newBuildState('sections', ['01-a.md', '02-b.md']);
    const r = judgeRecord(st, { sections: [{ file: '01-a.md', summary: 'Refunds within 14 days.' }, { file: '99-x.md', summary: 'nope' }] }, []);
    expect(r.accepted).toBe(1);
    expect(r.reply).toMatch(/99-x\.md: no such section file/);
    expect(outstanding(st, [])).toEqual(['02-b.md']);
    const early = judgeFinish(st, { summary: 'A handbook.', topics: ['refunds'] }, []);
    expect('reply' in early && early.reply).toMatch(/record summaries first for: 02-b\.md/);
    judgeRecord(st, { sections: [{ file: 'sections/02-b.md', summary: 'Invoices monthly.', title: 'Invoices' }] }, []);
    expect(progressReply(st, [])).toMatch(/Every file has a summary/);
    const done = judgeFinish(st, { summary: 'A handbook.', topics: ['refunds', 'Refunds', 'invoices'] }, []);
    expect(done).toEqual({ accepted: { title: null, summary: 'A handbook.', topics: ['refunds', 'invoices'] } });
    expect(st.recorded.get('02-b.md')?.title).toBe('Invoices');
  });

  it("'pdf' mode needs a title per section and records reading order", () => {
    const st = newBuildState('pdf');
    const written = ['002-b.md', '001-a.md'];
    const r = judgeRecord(st, { sections: [{ file: '002-b.md', summary: 's', depth: 2, title: 'B' }, { file: '001-a.md', summary: 's' }] }, written);
    expect(r.reply).toMatch(/001-a\.md: give its title/);
    expect(st.order).toEqual(['002-b.md']);
    expect(st.recorded.get('002-b.md')?.depth).toBe(2);
    const f = judgeFinish(st, { summary: 'x', topics: ['y'] }, written);
    expect('reply' in f && f.reply).toMatch(/record these written files first: 001-a\.md/);
  });

  it('accepts what it has on the last attempt, unless the index entry itself is missing', () => {
    const st = newBuildState('sections', ['01-a.md']);
    for (let i = 1; i < MAX_FINISH_ATTEMPTS; i++) expect('reply' in judgeFinish(st, { summary: 'x', topics: ['t'] }, [])).toBe(true);
    expect('accepted' in judgeFinish(st, { summary: 'x', topics: ['t'] }, [])).toBe(true);
    const empty = newBuildState('sections', []);
    empty.finishAttempts = MAX_FINISH_ATTEMPTS;
    expect('reply' in judgeFinish(empty, { summary: '', topics: [] }, [])).toBe(true);
  });

  it('clips an over-long summary to one line', () => {
    const st = newBuildState('sections', ['01-a.md']);
    judgeRecord(st, { sections: [{ file: '01-a.md', summary: `line one\n${'x'.repeat(500)}` }] }, []);
    const s = st.recorded.get('01-a.md')!.summary;
    expect(s.includes('\n')).toBe(false);
    expect(s.length).toBeLessThanOrEqual(240);
  });
});
