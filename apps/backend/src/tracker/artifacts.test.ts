import { describe, expect, it } from 'vitest';
import {
  MANIFEST_MAX_ENTRIES,
  buildManifest,
  classifyLink,
  jiraAttachmentsOf,
  kindOfFile,
  linksInText,
  manifestText,
  safeFileName,
  type TicketAttachment,
} from './artifacts.js';

const att = (id: string, filename: string, mime: string | null = null, size: number | null = 1000): TicketAttachment => ({
  id,
  filename,
  mime,
  size,
  fetch: { kind: 'jira_attachment', contentUrl: `https://acme.atlassian.net/rest/api/2/attachment/content/${id}` },
});

describe('classifyLink', () => {
  it('reads a Figma link: the file key, and the node id as the API names it', () => {
    const c = classifyLink('https://www.figma.com/design/AbCdEfGhIj1234/Checkout-Flow?node-id=12-345&t=xyz');
    expect(c).toMatchObject({ kind: 'figma', figma: { fileKey: 'AbCdEfGhIj1234', nodeId: '12:345' }, name: 'Figma: Checkout Flow (frame 12:345)' });
  });

  it('a Figma link with no frame, and one with a malformed node id, have no node', () => {
    expect(classifyLink('https://figma.com/file/AbCdEfGhIj1234')?.figma).toEqual({ fileKey: 'AbCdEfGhIj1234', nodeId: null });
    expect(classifyLink('https://figma.com/file/AbCdEfGhIj1234/x?node-id=../../etc')?.figma?.nodeId).toBeNull();
  });

  it('identity ignores the query: a re-signed address is the same artifact', () => {
    const a = classifyLink('https://prod-files-secure.s3.us-west-2.amazonaws.com/x/mock.png?X-Amz-Signature=aaa');
    const b = classifyLink('https://prod-files-secure.s3.us-west-2.amazonaws.com/x/mock.png?X-Amz-Signature=bbb');
    expect(a?.stable).toBe(b?.stable);
    expect(a?.kind).toBe('image');
  });

  it('kinds from the path; GitHub uploads are images; http, credentials and junk are refused', () => {
    expect(classifyLink('https://example.com/spec/tokens.json')?.kind).toBe('json');
    expect(classifyLink('https://example.com/a/flow.drawio')?.kind).toBe('diagram');
    expect(classifyLink('https://github.com/user-attachments/assets/1f2e3d')?.kind).toBe('image');
    expect(classifyLink('https://example.com/docs/page')?.kind).toBe('link');
    expect(classifyLink('http://example.com/a.png')).toBeNull();
    expect(classifyLink('https://user:pw@example.com/a.png')).toBeNull();
    expect(classifyLink('https://')).toBeNull();
  });
});

describe('linksInText', () => {
  it('finds markdown and bare links, once each, without trailing punctuation', () => {
    const text = 'See [the mock](https://example.com/mock.png). Also https://example.com/mock.png, and (https://x.test/a).';
    expect(linksInText(text)).toEqual(['https://example.com/mock.png', 'https://x.test/a']);
  });

  it('is capped', () => {
    const text = Array.from({ length: 100 }, (_, i) => `https://e.test/${i}`).join(' ');
    expect(linksInText(text, 5)).toHaveLength(5);
  });

  it('a hostile line stays linear', () => {
    const t0 = Date.now();
    linksInText(`${'https://'.repeat(50_000)}${'a'.repeat(100_000)}`);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('jiraAttachmentsOf', () => {
  it('reads the attachment field defensively', () => {
    const raw = {
      fields: {
        attachment: [
          { id: '10001', filename: 'mock.png', mimeType: 'image/png', size: 2048, content: 'https://acme.atlassian.net/rest/api/2/attachment/content/10001' },
          { id: 10002, filename: 'tokens.json', content: 'https://acme.atlassian.net/rest/api/2/attachment/content/10002' },
          { id: '../x', filename: 'bad', content: 'https://e.test' },
          { filename: 'no id', content: 'https://e.test' },
          'junk',
        ],
      },
    };
    expect(jiraAttachmentsOf(raw).map((a) => [a.id, a.filename, a.mime, a.size])).toEqual([
      ['10001', 'mock.png', 'image/png', 2048],
      ['10002', 'tokens.json', null, null],
    ]);
    expect(jiraAttachmentsOf(null)).toEqual([]);
    expect(jiraAttachmentsOf({ fields: { attachment: 'x' } })).toEqual([]);
  });
});

describe('buildManifest', () => {
  it('attachments first, then description links, then comment links; one entry per stable id', () => {
    const m = buildManifest({
      provider: 'jira',
      attachments: [att('1', 'mock.png', 'image/png'), att('2', 'flow.drawio')],
      description: 'Design: https://www.figma.com/design/AbCdEfGhIj1234/X?node-id=1-2 and https://e.test/spec',
      comments: 'Same as https://e.test/spec — and https://e.test/extra.json',
    });
    expect(m.map((e) => [e.artifact.kind, e.artifact.source, e.artifact.fetchable])).toEqual([
      ['image', 'attachment', true],
      ['diagram', 'attachment', true],
      ['figma', 'description', false],
      ['link', 'description', false],
      ['json', 'comment', false],
    ]);
    expect(m[0]!.artifact.id).toMatch(/^a-[0-9a-f]{10}$/);
    expect(m[2]!.artifact.id).toMatch(/^l-[0-9a-f]{10}$/);
    // An attachment's download address is the host's, never the agent's.
    expect(m[0]!.artifact.url).toBeNull();
    expect(JSON.stringify(m.map((e) => e.artifact))).not.toContain('attachment/content');
  });

  it('ids are stable across reads, and differ by provider for attachments', () => {
    const a = buildManifest({ provider: 'jira', attachments: [att('1', 'a.png')], description: '', comments: null });
    const b = buildManifest({ provider: 'jira', attachments: [att('1', 'renamed.png')], description: '', comments: null });
    const c = buildManifest({ provider: 'linear', attachments: [att('1', 'a.png')], description: '', comments: null });
    expect(a[0]!.artifact.id).toBe(b[0]!.artifact.id);
    expect(a[0]!.artifact.id).not.toBe(c[0]!.artifact.id);
  });

  it('is capped', () => {
    const many = Array.from({ length: MANIFEST_MAX_ENTRIES + 20 }, (_, i) => att(String(i), `f${i}.png`));
    expect(buildManifest({ provider: 'jira', attachments: many, description: '', comments: null })).toHaveLength(MANIFEST_MAX_ENTRIES);
  });
});

describe('the small folds', () => {
  it('kindOfFile', () => {
    expect(kindOfFile('a.PNG', null)).toBe('image');
    expect(kindOfFile('x', 'image/webp')).toBe('image');
    expect(kindOfFile('x.json', null)).toBe('json');
    expect(kindOfFile('spec.pdf', null)).toBe('pdf');
    expect(kindOfFile('board.drawio.xml', null)).toBe('diagram');
    expect(kindOfFile('notes.docx', null)).toBe('file');
  });

  it('safeFileName keeps one safe path segment', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('Mock up (v2).png')).toBe('Mock_up_v2_.png');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('a'.repeat(200))).toHaveLength(80);
  });

  it('manifestText says how to read each item', () => {
    const m = buildManifest({ provider: 'jira', attachments: [att('1', 'mock.png', 'image/png', 4096)], description: 'https://e.test/page', comments: null });
    const t = manifestText(m);
    expect(t).toContain('image · attachment · 4 KB · mock.png');
    expect(t).toContain(`ensemble-ticket get ${m[0]!.artifact.id}`);
    expect(t).toContain('https://e.test/page');
    expect(manifestText([])).toBe('The ticket has no attachments or links.\n');
  });
});
