// TICKET LINKS IN A TICKET'S TEXT (lib/ticketLinks.ts) — Activity → This Sprint, the opened card.
// A link to a ticket on this site and a bare key the server listed become marked <a>s (the Markdown
// renderer opens the ticket's tab for them); a key's shape alone, the ticket itself, another site and
// anything inside code are left alone.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketLinks.test.ts
import { describe, expect, it } from 'vitest';
import { rehypeTicketLinks, splitBareTicketKeys, type TicketLinkOptions } from '../src/lib/ticketLinks.js';
import { sprintTicketSite } from '../src/components/Activity/sprintModel.js';

const O: TicketLinkOptions = {
  site: { provider: 'jira', root: 'https://eaflood.atlassian.net' },
  selfKey: 'BMD-919',
  related: [
    { key: 'BMD-855', title: 'Hedgerow summary v1' },
    { key: 'OPS-3', title: null },
  ],
};

const el = (tagName: string, properties: Record<string, unknown>, children: any[]) => ({ type: 'element', tagName, properties, children });
const txt = (value: string) => ({ type: 'text', value });

describe('ticket links', () => {
  it('marks a link to a ticket on this site with its ident, key and title', () => {
    const tree = { type: 'root', children: [el('p', {}, [el('a', { href: 'https://eaflood.atlassian.net/browse/BMD-855' }, [txt('BMD-855')])])] };
    rehypeTicketLinks(O)(tree as any);
    expect((tree.children[0] as any).children[0].properties).toMatchObject({
      href: 'https://eaflood.atlassian.net/browse/BMD-855',
      dataTicketIdent: 'jira:https://eaflood.atlassian.net#BMD-855',
      dataTicketKey: 'BMD-855',
      dataTicketTitle: 'Hedgerow summary v1',
    });
  });

  it('leaves another site, a non-ticket link and the ticket itself alone', () => {
    const tree = {
      type: 'root',
      children: [
        el('a', { href: 'https://other.atlassian.net/browse/BMD-855' }, [txt('x')]),
        el('a', { href: 'https://example.com' }, [txt('y')]),
        el('a', { href: 'https://eaflood.atlassian.net/browse/BMD-919' }, [txt('self')]),
      ],
    };
    rehypeTicketLinks(O)(tree as any);
    for (const a of tree.children as any[]) expect(a.properties.dataTicketIdent).toBeUndefined();
  });

  it('links a bare key only when listed, never inside code, never the ticket itself', () => {
    const tree = {
      type: 'root',
      children: [el('p', {}, [txt('Needs BMD-855 and ops-3, not UTF-8 or BMD-919.')]), el('code', {}, [txt('BMD-855')])],
    };
    rehypeTicketLinks(O)(tree as any);
    const p = tree.children[0] as any;
    expect(p.children.map((c: any) => (c.type === 'text' ? c.value : `[${c.properties.dataTicketKey}]`))).toEqual([
      'Needs ',
      '[BMD-855]',
      ' and ',
      '[OPS-3]',
      ', not UTF-8 or BMD-919.',
    ]);
    expect(p.children[1].properties.href).toBe('https://eaflood.atlassian.net/browse/BMD-855');
    expect((tree.children[1] as any).children).toEqual([txt('BMD-855')]);
    expect(splitBareTicketKeys('BMD-8550 xBMD-855', O)).toBeNull();
  });

  it('the site comes from the ident', () => {
    expect(sprintTicketSite({ ident: 'jira:https://eaflood.atlassian.net#BMD-919' })).toEqual({ provider: 'jira', root: 'https://eaflood.atlassian.net' });
    expect(sprintTicketSite({ ident: 'github:https://github.com/acme/web#12' })).toEqual({ provider: 'github', root: 'https://github.com' });
    expect(sprintTicketSite({ ident: 'nonsense' })).toBeNull();
  });
});
