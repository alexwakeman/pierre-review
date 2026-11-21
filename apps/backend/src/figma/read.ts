import { fetchPage, nodePageTransport, type PageTransport } from '../reference-docs/url-fetch.js';
import type { JiraTransport } from '../tracker/jira/fetch.js';
import { figmaClient, FigmaError, isFigmaFileKey, isFigmaNodeId } from './client.js';
import { figmaOutline } from './outline.js';

// READ A FIGMA FRAME FOR A WORKSPACE SESSION (docs/IMPLEMENT-UI-PLAN.md § 3), on the HOST, with the
// workspace's token: the frame's layers as an outline (outline.ts, no model) and a PNG of it.
//
//   1. a link with no node id: `GET /v1/files/:key?depth=2` → the first page's top frames (≤ FRAMES_MAX);
//   2. `GET /v1/files/:key/nodes?ids=…` → the outline (and the file's version);
//   3. `GET /v1/images/:key?ids=…&format=png` → each frame's picture address; the picture is read from that
//      address WITHOUT the token (it is signed), public addresses only.
//
// CACHED per (account, file, frames, file VERSION): a re-run in the same process reads only step 2 again.

export const FRAMES_MAX = 3;
const PNG_MAX_BYTES = 15 * 1024 * 1024;
const CACHE_MAX = 30;

export interface FigmaFrameRead {
  outline: string;
  /** One picture per frame that Figma rendered. */
  pngs: Array<{ nodeId: string; bytes: Buffer }>;
  version: string | null;
  /** Requests made to Figma (for the Network panel). */
  calls: number;
  cached: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

const cache = new Map<string, Omit<FigmaFrameRead, 'calls' | 'cached'>>();

/** Test seam. */
export function clearFigmaCache(): void {
  cache.clear();
}

export async function readFigmaFrames(o: {
  accountId: number;
  token: string;
  fileKey: string;
  nodeId: string | null;
  transport?: JiraTransport;
  pageTransport?: PageTransport;
}): Promise<FigmaFrameRead> {
  if (!isFigmaFileKey(o.fileKey) || (o.nodeId != null && !isFigmaNodeId(o.nodeId))) throw new FigmaError('bad_input');
  const client = figmaClient(o.token, o.transport);
  let calls = 0;
  let ids: string[];
  if (o.nodeId != null) ids = [o.nodeId];
  else {
    calls += 1;
    const file = obj(await client.get(`/v1/files/${o.fileKey}`, { depth: '2' }));
    const firstPage = obj((Array.isArray(obj(file?.document)?.children) ? (obj(file?.document)!.children as unknown[]) : [])[0]);
    const frames = Array.isArray(firstPage?.children) ? (firstPage!.children as unknown[]) : [];
    ids = frames
      .map((f) => obj(f))
      .filter((f): f is Obj => f != null && ['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET'].includes(String(f.type)) && f.visible !== false)
      .map((f) => String(f.id))
      .filter(isFigmaNodeId)
      .slice(0, FRAMES_MAX);
    if (ids.length === 0) throw new FigmaError('not_found');
  }
  calls += 1;
  const answer = obj(await client.get(`/v1/files/${o.fileKey}/nodes`, { ids: ids.join(',') }));
  const version = typeof answer?.version === 'string' ? answer.version : null;
  const key = `${o.accountId}:${o.fileKey}:${ids.join(',')}:${version ?? ''}`;
  const hit = version != null ? cache.get(key) : undefined;
  if (hit) return { ...hit, calls, cached: true };
  const nodes = obj(answer?.nodes) ?? {};
  const frames = ids.flatMap((id) => {
    const n = obj(nodes[id]);
    return n?.document != null ? [{ id, document: n.document, components: n.components }] : [];
  });
  if (frames.length === 0) throw new FigmaError('not_found');
  const outline = figmaOutline({ fileName: typeof answer?.name === 'string' ? answer.name : null, version, frames });
  calls += 1;
  const images = obj(obj(await client.get(`/v1/images/${o.fileKey}`, { ids: frames.map((f) => f.id).join(','), format: 'png', scale: '1' }))?.images) ?? {};
  const pngs: FigmaFrameRead['pngs'] = [];
  for (const f of frames) {
    const url = images[f.id];
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    // The picture's address is signed: read WITHOUT the token, public addresses only.
    const page = await fetchPage(url, o.pageTransport ?? nodePageTransport, { privateNetwork: false }, PNG_MAX_BYTES).catch(() => null);
    if (page && page.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) pngs.push({ nodeId: f.id, bytes: page.body });
  }
  const result = { outline, pngs, version };
  if (version != null) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return { ...result, calls, cached: false };
}
