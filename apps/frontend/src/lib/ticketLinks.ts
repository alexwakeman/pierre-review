import { siteTicketKeyOfUrl, ticketBrowseUrl, trackerTicketIdent, type TicketSite } from '@pierre-review/shared';

// TICKET REFERENCES IN A TICKET'S TEXT → THAT TICKET IN LIMN (Reports → This sprint, the opened card).
// The rehype half: after the sanitizer, every LINK to a ticket on this tracker site (shared
// `siteTicketKeyOfUrl`, the one URL parser) and every BARE KEY the server listed in `related` (a key's
// shape alone is not enough — `UTF-8` has it) is marked with `data-ticket-ident` / `-key` / `-title`.
// `Markdown` (with `ticketLinks`) renders a marked `<a>` as `TicketRefLink`: a click opens the ticket's
// tab; a small icon beside it still goes to the tracker. The ticket itself is never linked to itself.
// Pure apart from the tree it is handed; unit-tested in test/ticketLinks.test.ts.

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

export interface TicketLinkOptions {
  site: TicketSite;
  /** The ticket's own key (never linked). */
  selfKey: string;
  /** Keys the server listed for this ticket, with their titles (bare mentions are linked only for these). */
  related: ReadonlyArray<{ key: string; title: string | null }>;
}

const SKIP = new Set(['a', 'code', 'pre', 'button']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function marked(key: string, o: TicketLinkOptions): Record<string, unknown> {
  const title = o.related.find((r) => r.key === key)?.title ?? null;
  return {
    dataTicketIdent: trackerTicketIdent(o.site.provider, o.site.root, key),
    dataTicketKey: key,
    ...(title != null ? { dataTicketTitle: title } : {}),
  };
}

/** Split one text value at every bare related key; null when there is none. */
export function splitBareTicketKeys(value: string, o: TicketLinkOptions): HNode[] | null {
  const keys = o.related.map((r) => r.key).filter((k) => k !== o.selfKey);
  if (keys.length === 0) return null;
  const re = new RegExp(`(?<![A-Za-z0-9_/#-])(${keys.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  const out: HNode[] = [];
  let last = 0;
  for (const m of value.matchAll(re)) {
    const at = m.index ?? 0;
    const key = keys.find((k) => k.toLowerCase() === m[0].toLowerCase()) ?? m[0];
    if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href: ticketBrowseUrl(o.site, key) ?? undefined, ...marked(key, o) },
      children: [{ type: 'text', value: m[0] }],
    });
    last = at + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: HNode, o: TicketLinkOptions): void {
  const children = node.children;
  if (children == null) return;
  const next: HNode[] = [];
  let changed = false;
  for (const c of children) {
    if (c.type === 'element' && c.tagName === 'a') {
      const href = c.properties?.href;
      const key = typeof href === 'string' ? siteTicketKeyOfUrl(href, o.site) : null;
      if (key != null && key !== o.selfKey) c.properties = { ...(c.properties ?? {}), ...marked(key, o) };
      next.push(c);
      continue;
    }
    if (c.type === 'element') {
      if (!SKIP.has(c.tagName ?? '')) walk(c, o);
      next.push(c);
      continue;
    }
    if (c.type === 'text' && c.value != null) {
      const parts = splitBareTicketKeys(c.value, o);
      if (parts != null) {
        next.push(...parts);
        changed = true;
        continue;
      }
    }
    next.push(c);
  }
  if (changed) node.children = next;
}

/** Rehype plugin (run AFTER the sanitizer): ticket links and listed bare keys → marked `<a>`s. */
export function rehypeTicketLinks(o: TicketLinkOptions): (tree: HNode) => void {
  return (tree) => walk(tree, o);
}
