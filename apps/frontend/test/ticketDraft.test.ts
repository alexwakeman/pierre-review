// THE TICKET DRAFT (lib/ticketDraft.ts) — Reports → This sprint, the opened card.
//
//   1. A quote is found in RAW Markdown whitespace-normalised and mapped back to raw offsets, so
//      Replace rewrites exactly that occurrence (and nothing when the quote is gone).
//   2. Revision sentinels wrap added words only, never before a line's Markdown syntax, never on a
//      fence / rule / link-definition line; the rehype pass turns them into <ins class="story-rev">.
//   3. Changed fields, a moved base, editability and the finding → field rule.
//   4. The stored draft is validated and every storage access is guarded.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketDraft.test.ts
import { describe, expect, it } from 'vitest';
import {
  REV_CLOSE,
  REV_OPEN,
  applyAllSuggestions,
  changedFields,
  draftBaseMoved,
  draftPristine,
  rebaseDraft,
  fieldEditable,
  findQuoteInMarkdown,
  findingDraftField,
  freshDraft,
  loadStoredDraft,
  rehypeRevisions,
  replaceQuoteInMarkdown,
  revisionMarkdown,
  storeDraft,
} from '../src/lib/ticketDraft.js';

const show = (s: string): string => s.replaceAll(REV_OPEN, '[').replaceAll(REV_CLOSE, ']');

describe('finding a quote in raw Markdown', () => {
  it('matches across a line break and extra spaces, and maps back to raw offsets', () => {
    const raw = 'Intro.\n\n- Given a  user\n  when they log in\n- Then done';
    const hit = findQuoteInMarkdown(raw, 'Given a user when they log in');
    expect(hit).not.toBeNull();
    expect(raw.slice(hit!.start, hit!.end)).toBe('Given a  user\n  when they log in');
  });
  it('curly quotes read as straight; case-insensitive as a fallback', () => {
    expect(findQuoteInMarkdown('Say "hello" now', 'say “hello”')).toEqual({ start: 0, end: 11 });
  });
  it('replaces exactly that occurrence and keeps the rest byte for byte', () => {
    const raw = '## AC\n\n- It should be fast\n- It should be safe\n';
    expect(replaceQuoteInMarkdown(raw, 'It should  be fast', 'Loads in under 2 s')).toBe('## AC\n\n- Loads in under 2 s\n- It should be safe\n');
  });
  it('a quote no longer in the text → null (no Replace)', () => {
    expect(replaceQuoteInMarkdown('Nothing here', 'missing words', 'x')).toBeNull();
    expect(findQuoteInMarkdown('abc', '   ')).toBeNull();
  });
});

describe('revision highlights', () => {
  it('wraps the added words only', () => {
    expect(show(revisionMarkdown('The page is fast.', 'The page loads in 2 s.'))).toBe('The page [loads in 2 s.]');
  });
  it('unchanged text has no sentinels', () => {
    expect(revisionMarkdown('a b', 'a b')).toBe('a b');
  });
  it('a sentinel stays after list markers, headings and task boxes', () => {
    expect(show(revisionMarkdown('- one\n- two', '- one\n- two\n- [ ] three'))).toBe('- one\n- two\n- [ ] [three]');
    expect(show(revisionMarkdown('Intro', '## New heading\n\nIntro'))).toBe('## [New heading]\n\nIntro');
  });
  it('no sentinel on a fence or a rule line', () => {
    const out = revisionMarkdown('Text', 'Text\n\n```\ncode\n```');
    expect(show(out)).toBe('Text\n\n```\n[code]\n```');
    expect(show(revisionMarkdown('a', 'a\n\n---'))).toBe('a\n\n---');
  });
  it('the rehype pass turns sentinels into <ins> and strips them from attributes', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'text', value: `Keep ${REV_OPEN}new ` },
            { type: 'element', tagName: 'a', properties: { href: `https://x.test${REV_CLOSE}` }, children: [{ type: 'text', value: `link${REV_CLOSE}` }] },
            { type: 'text', value: ' end' },
          ],
        },
      ],
    };
    rehypeRevisions()(tree);
    const p = tree.children[0]!;
    expect(p.children[0]).toEqual({ type: 'text', value: 'Keep ' });
    expect(p.children[1]).toMatchObject({ tagName: 'ins', properties: { className: ['story-rev'] }, children: [{ value: 'new ' }] });
    const a = p.children[2] as { properties: { href: string }; children: Array<{ tagName?: string; value?: string }> };
    expect(a.properties.href).toBe('https://x.test');
    expect(a.children[0]).toMatchObject({ tagName: 'ins', children: [{ value: 'link' }] });
    expect(p.children[3]).toEqual({ type: 'text', value: ' end' });
  });
});

const ticket = (over: { ac?: boolean; truncated?: boolean } = {}) => ({
  description: 'Desc',
  acceptanceCriteria: over.ac ? '- AC' : '',
  replaceBases: {
    description: { hash: 'd1', truncated: over.truncated ?? false },
    acceptanceCriteria: over.ac ? { hash: 'c1', truncated: false } : null,
  },
});

describe('the draft', () => {
  it('starts as the original; criteria only with a field of its own', () => {
    expect(freshDraft(ticket()).text).toEqual({ description: 'Desc', criteria: null });
    expect(freshDraft(ticket({ ac: true }))).toEqual({
      bases: { description: 'd1', criteria: 'c1' },
      base: { description: 'Desc', criteria: '- AC' },
      text: { description: 'Desc', criteria: '- AC' },
      replaced: [],
    });
  });
  it('pristine until something changes', () => {
    const d = freshDraft(ticket());
    expect(draftPristine(d)).toBe(true);
    expect(draftPristine({ ...d, text: { ...d.text, description: 'x' } })).toBe(false);
  });
  it('changed fields, in write order', () => {
    const o = { description: 'a', criteria: 'b' };
    expect(changedFields(o, { description: 'a', criteria: 'b' })).toEqual([]);
    expect(changedFields(o, { description: 'x', criteria: 'y' })).toEqual(['description', 'criteria']);
  });
  it('a moved base is seen per field', () => {
    const d = freshDraft(ticket({ ac: true }));
    expect(draftBaseMoved(d, ticket({ ac: true }))).toBe(false);
    const moved = ticket({ ac: true });
    moved.replaceBases.acceptanceCriteria = { hash: 'c2', truncated: false };
    expect(draftBaseMoved(d, moved)).toBe(true);
  });
  it('a moved field restarts unless it holds an edit nobody wrote', () => {
    const d = freshDraft(ticket({ ac: true }));
    const edited = { ...d, text: { description: 'My edit', criteria: '- My AC' }, replaced: ['f1'] };
    const next = { ...ticket({ ac: true }), description: 'Theirs' };
    next.replaceBases.description = { hash: 'd2', truncated: false };
    // Unedited → restarts.
    expect(rebaseDraft(d, next).text.description).toBe('Theirs');
    // Edited and not written → kept; the base stays the old one (the card warns).
    expect(rebaseDraft(edited, next)).toBe(edited);
    // Written from this card over d1 → restarts; the criteria edit (base unmoved) is kept.
    const after = rebaseDraft(edited, next, { description: 'd1' });
    expect(after.text).toEqual({ description: 'Theirs', criteria: '- My AC' });
    expect(after.bases.description).toBe('d2');
    expect(after.replaced).toEqual(['f1']);
    // Now equal to the ticket → restarts, and with nothing left changed the replaced list clears.
    const same = { ...d, text: { description: 'Theirs', criteria: '- AC' }, replaced: ['f1'] };
    expect(rebaseDraft(same, next)).toMatchObject({ text: { description: 'Theirs' }, replaced: [] });
  });
  it('a field cut on the wire is not editable', () => {
    expect(fieldEditable(ticket({ truncated: true }), 'description')).toBe(false);
    expect(fieldEditable(ticket(), 'criteria')).toBe(false);
    expect(fieldEditable(ticket({ ac: true }), 'criteria')).toBe(true);
  });
  it('a finding’s field', () => {
    const f = (where: 'title' | 'description' | 'criteria' | null, quote: string | null = 'q') => ({ where, quote });
    expect(findingDraftField(f('title'), ticket(), false)).toBeNull();
    expect(findingDraftField(f('description', null), ticket(), false)).toBeNull();
    expect(findingDraftField(f('criteria'), ticket({ ac: true }), true)).toBe('criteria');
    expect(findingDraftField(f('criteria'), ticket(), false)).toBe('description');
    expect(findingDraftField(f('criteria'), ticket(), true)).toBeNull();
  });
});

describe('storage', () => {
  it('works without localStorage and rejects a malformed blob', () => {
    expect(() => storeDraft('k', freshDraft(ticket()))).not.toThrow();
    expect(loadStoredDraft('k')).toBeNull();
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    try {
      const d = freshDraft(ticket({ ac: true }));
      storeDraft('k', d);
      expect(loadStoredDraft('k')).toEqual(d);
      mem.set('k', '{"bases":1}');
      expect(loadStoredDraft('k')).toBeNull();
      mem.set('k', 'not json');
      expect(loadStoredDraft('k')).toBeNull();
      storeDraft('k', null);
      expect(mem.has('k')).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('apply all suggestions', () => {
  const base = () => {
    const d = freshDraft({
      description: 'Users can upload a file quickly.\n\n## Acceptance criteria\n\n1. It works',
      acceptanceCriteria: '- Fast enough\n- Shows an error',
      replaceBases: { description: { hash: 'd1', truncated: false }, acceptanceCriteria: { hash: 'c1', truncated: false } },
    });
    return d;
  };
  const all = () => true;

  it('replaces every quote still in the text, as one step, and records the findings', () => {
    const d = base();
    const r = applyAllSuggestions(
      d,
      [
        { id: 'a', field: 'description', quote: 'quickly', suggestion: 'in under 5 seconds' },
        { id: 'b', field: 'criteria', quote: 'Fast enough', suggestion: 'Loads in 2 s' },
        { id: 'c', field: 'criteria', quote: 'not there', suggestion: 'x' },
        { id: 'd', field: 'description', quote: 'file', suggestion: null },
        { id: 'e', field: null, quote: 'Title', suggestion: 'y' },
      ],
      [],
      all,
    );
    expect(r.applied).toBe(2);
    expect(r.findingIds).toEqual(['a', 'b']);
    expect(r.draft.text.description).toContain('in under 5 seconds');
    expect(r.draft.text.criteria).toBe('- Loads in 2 s\n- Shows an error');
    expect(r.draft.replaced).toEqual(['a', 'b']);
  });

  it('applies whole-field proposals first and then skips quote-replaces in a field they rewrote', () => {
    const d = base();
    const r = applyAllSuggestions(
      d,
      [
        { id: 'a', field: 'description', quote: 'quickly', suggestion: 'fast' },
        { id: 'b', field: 'criteria', quote: 'Fast enough', suggestion: 'Loads in 2 s' },
      ],
      [{ field: 'criteria', build: () => '1. New list' }],
      all,
    );
    expect(r.applied).toBe(2);
    expect(r.draft.text.criteria).toBe('1. New list');
    expect(r.findingIds).toEqual(['a']);
  });

  it('builds a later proposal on an earlier one (criteria swapped into the proposed description)', () => {
    const d = base();
    const r = applyAllSuggestions(
      d,
      [],
      [
        { field: 'description', build: () => 'New description' },
        { field: 'description', build: (x) => `${x.description}\n\n1. Criteria` },
      ],
      all,
    );
    expect(r.draft.text.description).toBe('New description\n\n1. Criteria');
    expect(r.applied).toBe(2);
  });

  it('touches no field that is not editable, skips findings already replaced, and returns the same draft when nothing applies', () => {
    const d = { ...base(), replaced: ['a'] };
    const r = applyAllSuggestions(
      d,
      [
        { id: 'a', field: 'description', quote: 'quickly', suggestion: 'fast' },
        { id: 'b', field: 'criteria', quote: 'Fast enough', suggestion: 'Loads in 2 s' },
      ],
      [{ field: 'criteria', build: () => '1. New list' }],
      (f) => f === 'description',
    );
    expect(r.applied).toBe(0);
    expect(r.draft).toBe(d);
  });

  it('counts a proposal already in the draft as nothing to apply', () => {
    const d = base();
    const r = applyAllSuggestions(d, [], [{ field: 'criteria', build: (x) => x.criteria ?? '' }], all);
    expect(r.applied).toBe(0);
    expect(r.draft).toBe(d);
  });
});
