import { parseNotionPageUrl, type WikiProviderId } from '@pierre-review/shared';
import { WikiSourceError, type WikiPage, type WikiPageMeta, type WikiSource } from './source.js';

/** A PNG header of the given size, distinct per seed (figures.ts reads only the header). */
export function fakePng(seed: number, w = 640, h = 480): Buffer {
  const b = Buffer.alloc(4096);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt32BE(seed, 4092);
  return b;
}

// AN IN-MEMORY WIKI for the tests (sync.test.ts, wiki-db.test.ts, notion-figures-db.test.ts) — the
// provider-blind half of the WikiSource contract, with every call counted. Not imported by production
// code. A body's `{{figure:N}}` is an image: with a figure sink it becomes a marker (fakePng(N)).

export interface FakePage {
  id: string;
  title: string;
  parentId: string | null;
  version: number;
  editedAt: Date;
  body: string;
  position?: number;
}

export interface FakeWiki extends WikiSource {
  pages: Map<string, FakePage>;
  calls: { getMeta: string[]; getBody: string[]; list: number; changed: number; access: number };
  /** Page id → the error code a read of it throws (a root that is gone, a forbidden child). */
  failing: Map<string, WikiSourceError>;
  edit(id: string, body: string, at?: Date): void;
  resetCalls(): void;
}

export function fakeWiki(seed: FakePage[], provider: WikiProviderId = 'confluence'): FakeWiki {
  const pages = new Map(seed.map((p) => [p.id, { ...p }]));
  const calls = { getMeta: [] as string[], getBody: [] as string[], list: 0, changed: 0, access: 0 };
  const failing = new Map<string, WikiSourceError>();
  const depthOf = (id: string, root: string): number => {
    let d = 0;
    let cur = pages.get(id);
    while (cur && cur.id !== root) {
      d += 1;
      cur = cur.parentId ? pages.get(cur.parentId) : undefined;
    }
    return cur ? d : -1;
  };
  const meta = (p: FakePage, depth = 0): WikiPageMeta => ({
    id: p.id,
    title: p.title,
    parentId: p.parentId,
    version: p.version,
    editedAt: p.editedAt,
    depth,
    position: p.position ?? null,
  });
  return {
    provider,
    pages,
    calls,
    failing,
    resolveRef: (raw) => {
      if (provider === 'notion') {
        const a = parseNotionPageUrl(raw);
        return a ? { provider: 'notion', origin: a.origin, host: a.host, pageId: a.pageId } : null;
      }
      const m = /^https:\/\/([a-z0-9.-]+)\/wiki\/spaces\/[A-Z]+\/pages\/(\d+)/.exec(raw);
      return m ? { provider: 'confluence', origin: `https://${m[1]}`, host: m[1]!, pageId: m[2]! } : null;
    },
    async getPage(_site, id, opts): Promise<WikiPage> {
      (opts.body ? calls.getBody : calls.getMeta).push(id);
      const err = failing.get(id);
      if (err) throw err;
      const p = pages.get(id);
      if (!p) throw new WikiSourceError('not_found', 404);
      return { ...meta(p), body: opts.body ? p.body : '', webUrl: `https://acme.test/wiki/pages/${id}` };
    },
    async listDescendants(_site, root, depth, cap) {
      calls.list += 1;
      const out: WikiPageMeta[] = [];
      const walk = (parent: string, d: number): void => {
        if (d > depth) return;
        const kids = [...pages.values()].filter((p) => p.parentId === parent).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
        for (const k of kids) {
          out.push({ ...meta(k, d), version: null, editedAt: null });
          walk(k.id, d + 1);
        }
      };
      walk(root, 1);
      return { pages: out.slice(0, cap), more: out.length > cap };
    },
    async changedSince(_site, root, since) {
      calls.changed += 1;
      return [...pages.values()].filter((p) => p.id !== root && depthOf(p.id, root) > 0 && p.editedAt.getTime() > since.getTime() - 24 * 3600_000).map((p) => meta(p));
    },
    async toMarkdown(page, opts) {
      return page.body.replace(/\{\{figure:(\d+)\}\}/g, (_m, n: string) => opts?.figures?.add(fakePng(Number(n)), `Image: figure-${n}.png`) ?? `[Image: figure-${n}.png]`);
    },
    async checkAccess() {
      calls.access += 1;
    },
    pageUrl: (site, id) => `${site.origin}/wiki/pages/viewpage.action?pageId=${id}`,
    edit(id, body, at = new Date()) {
      const p = pages.get(id)!;
      p.body = body;
      p.version += 1;
      p.editedAt = at;
    },
    resetCalls() {
      calls.getMeta = [];
      calls.getBody = [];
      calls.list = 0;
      calls.changed = 0;
      calls.access = 0;
    },
  };
}
