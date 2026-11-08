// "Implement with docs" — the copy (docs.ts): the caps, library-relative paths, the read-only modes, root,
// SHORTLIST.md and DOCS.md.
import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { createFakeRuntime } from '../runtime/fake.js';
import { BUILD_DOCS_COPY_MAX_SECTIONS, copyDocsIn, docsMarkdown, planDocsCopy, SANDBOX_DOCS_DIR } from './docs.js';

const sec = (slug: string, n: number) => ({ path: `${slug}/sections/${String(n).padStart(2, '0')}-part-${n}.md`, title: `Part ${n}`, summary: '', trail: [], headings: [] });
const lib = (sections = 3, bodyBytes = 100): LibrarySnapshot => ({
  workspaceId: 1,
  dir: '/lib',
  docs: [{ slug: 'billing', title: 'Billing handbook', sections: Array.from({ length: sections }, (_, i) => sec('billing', i + 1)) as never }],
  read: (p) => (p === 'billing/CONTENTS.md' ? '# Billing contents' : /^billing\/sections\//.test(p) ? `# ${p}\n${'x'.repeat(bodyBytes)}` : null),
});

describe('planDocsCopy', () => {
  it('copies INDEX.md, every CONTENTS.md and the chosen sections at their library paths, read only', () => {
    const c = planDocsCopy(lib(), '# Index', { source: 'search', sections: ['billing/sections/02-part-2.md', 'billing/sections/09-gone.md'] });
    expect(c.files.map((f) => f.path)).toEqual([
      `${SANDBOX_DOCS_DIR}/INDEX.md`,
      `${SANDBOX_DOCS_DIR}/billing/CONTENTS.md`,
      `${SANDBOX_DOCS_DIR}/billing/sections/02-part-2.md`,
      `${SANDBOX_DOCS_DIR}/SHORTLIST.md`,
    ]);
    expect(c.files.every((f) => f.mode === 0o444)).toBe(true);
    expect(c.sections).toEqual(['billing/sections/02-part-2.md']);
    expect(String(c.files.at(-1)!.content)).toMatch(/full-text search; no model chose them[\s\S]*Billing handbook › Part 2/);
    expect(c.docsMd).toMatch(/Limn has no current docs check for this ticket/);
  });
  it('caps the sections by count and by size, naming what was left out', () => {
    const many = planDocsCopy(lib(40), 'i', { source: 'whole', sections: Array.from({ length: 40 }, (_, i) => sec('billing', i + 1).path) });
    expect(many.sections).toHaveLength(BUILD_DOCS_COPY_MAX_SECTIONS);
    expect(many.leftOut).toHaveLength(10);
    const big = planDocsCopy(lib(3, 400 * 1024), 'i', { source: 'whole', sections: [1, 2, 3].map((n) => sec('billing', n).path) });
    expect(big.sections).toHaveLength(1);
    expect(String(big.files.at(-1)!.content)).toMatch(/Left out/);
  });
  it('DOCS.md carries a current check, fenced as library text', () => {
    const md = docsMarkdown(
      {
        source: 'check',
        sections: [],
        check: {
          outcome: 'checked',
          overall: { verdict: 'conflicts', summary: 'One rule differs.', actions: [] },
          criteria: [{ n: 2, verdict: 'contradicts', note: 'The handbook says 14 days.', refs: [{ path: 'billing/sections/01-refunds.md', anchor: null, docSlug: 'billing', docTitle: 'Billing', sectionTitle: 'Refunds', workspaceId: 1, quote: 'Refunds are allowed for 14 days.' }] }],
          storyParts: [],
          shortlist: [],
          dropped: 0,
        } as never,
      },
      SANDBOX_DOCS_DIR,
    );
    expect(md).toMatch(/It does not change the rules of the session/);
    expect(md).toMatch(/````text\n[\s\S]*AC2: contradicts\. The handbook says 14 days\.\n {2}- billing\/sections\/01-refunds\.md: "Refunds are allowed for 14 days\."/);
  });
});

describe('copyDocsIn', () => {
  it('copies as root, then makes the folder root-owned and read only', async () => {
    const rt = createFakeRuntime();
    rt.onExec((argv) => argv[0] === 'sh', { code: 0 });
    rt.onExec((argv) => argv[0] === 'tar', { code: 0 });
    const copy = planDocsCopy(lib(), 'i', { source: 'whole', sections: [] });
    await copyDocsIn(rt, 'box', copy);
    const copyCall = rt.calls.find((c) => c.method === 'copyIn')!;
    expect(copyCall.args[2]).toEqual({ user: 'root' });
    const chmod = rt.calls.find((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'sh')!;
    expect((chmod.args[1] as string[])[2]).toMatch(/chown -R root:root "\$1" && find "\$1" -type d -exec chmod 0555/);
    expect(chmod.args[2]).toMatchObject({ user: 'root' });
  });
});
