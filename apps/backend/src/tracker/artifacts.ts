import { createHash } from 'node:crypto';

// WHAT A TICKET ATTACHES OR LINKS — the manifest behind `ensemble-ticket` (docs/SANDBOX.md § The ticket
// relay; plan: docs/IMPLEMENT-UI-PLAN.md § 2). PURE: every input is tracker text or tracker JSON, which
// is UNTRUSTED, so the scanner is LINEAR (indexOf, bounded windows, no nested quantifiers) and every
// input is capped first.
//
// ⚠ IDENTITY IS NEVER A SIGNED ADDRESS. Notion's file addresses expire within the hour and Atlassian's
// media addresses are signed in their query, so an artifact's `id` comes from a stable fact: the
// attachment's own id, or the link with its query and fragment cut (a Figma link keeps its `node-id`).

export type TicketArtifactKind = 'figma' | 'image' | 'diagram' | 'json' | 'pdf' | 'file' | 'link';
export type TicketArtifactSource = 'attachment' | 'description' | 'comment';

/** One entry as the agent sees it (`.limn/ticket/manifest.json`). */
export interface TicketArtifact {
  /** The host's handle: `a-<10 hex>` (an attachment) or `l-<10 hex>` (a link). */
  id: string;
  kind: TicketArtifactKind;
  source: TicketArtifactSource;
  name: string;
  /** A link's address (https only). null for an attachment: it is fetched by `get`. */
  url: string | null;
  mime?: string;
  size?: number;
  figma?: { fileKey: string; nodeId: string | null };
  /** `get` can fetch it (an attachment the host can read). A link is opened by the agent through the proxy. */
  fetchable: boolean;
}

/** What the host keeps beside an entry: where to fetch it from. Never shown to the agent. */
export type ArtifactFetch = { kind: 'jira_attachment'; contentUrl: string } | { kind: 'none' };

export interface ManifestEntry {
  artifact: TicketArtifact;
  fetch: ArtifactFetch;
}

/** One attachment as a reader returns it (provider-neutral). */
export interface TicketAttachment {
  id: string;
  filename: string;
  mime: string | null;
  size: number | null;
  fetch: ArtifactFetch;
}

export const MANIFEST_MAX_ENTRIES = 100;
export const LINKS_MAX_PER_TEXT = 60;
/** Text past this is not scanned (a hostile description cannot make the scan slow). */
export const LINK_SCAN_MAX_CHARS = 200_000;
const URL_MAX_CHARS = 2_048;
const NAME_MAX_CHARS = 120;

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** A file name that is safe as one path segment: letters, digits, `.`, `_`, `-`; ≤ 80 characters. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return cleaned === '' ? 'file' : cleaned;
}

function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const t = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t.length > NAME_MAX_CHARS ? `${t.slice(0, NAME_MAX_CHARS - 1)}…` : t;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** A kind from a file's name and type. */
export function kindOfFile(filename: string, mime: string | null): TicketArtifactKind {
  const m = (mime ?? '').toLowerCase();
  const f = filename.toLowerCase();
  if (f.endsWith('.drawio') || f.endsWith('.drawio.xml') || f.endsWith('.gliffy')) return 'diagram';
  if (m.startsWith('image/') || IMAGE_EXT.test(f)) return 'image';
  if (m === 'application/json' || f.endsWith('.json')) return 'json';
  if (m === 'application/pdf' || f.endsWith('.pdf')) return 'pdf';
  return 'file';
}

const FIGMA_PATH = /^\/(file|design|proto|board)\/([A-Za-z0-9]{10,128})(?:\/([^/]{0,200}))?/;

/** The parts of a link that say what it is. null: not an https address. */
export function classifyLink(raw: string): { url: string; stable: string; kind: TicketArtifactKind; name: string; figma?: { fileKey: string; nodeId: string | null } } | null {
  if (raw.length > URL_MAX_CHARS) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'figma.com' || host === 'www.figma.com') {
    const m = FIGMA_PATH.exec(path);
    if (m) {
      const fileKey = m[2]!;
      // Figma links write a node id `12-34`; the API names it `12:34`.
      const rawNode = u.searchParams.get('node-id');
      const nodeId = rawNode != null && /^\d{1,12}[-:]\d{1,12}$/.test(rawNode) ? rawNode.replace('-', ':') : null;
      let title = '';
      try {
        title = decodeURIComponent(m[3] ?? '').replace(/-/g, ' ');
      } catch {
        title = '';
      }
      return {
        url: u.href,
        stable: `figma:${fileKey}:${nodeId ?? ''}`,
        kind: 'figma',
        name: cleanName(`Figma: ${title.trim() || fileKey}${nodeId ? ` (frame ${nodeId})` : ''}`),
        figma: { fileKey, nodeId },
      };
    }
  }
  const stable = `${host}${path}`;
  const last = path.split('/').filter(Boolean).pop() ?? '';
  let name = host;
  try {
    name = last !== '' ? decodeURIComponent(last) : host;
  } catch {
    name = last || host;
  }
  let kind: TicketArtifactKind = 'link';
  if ((host === 'github.com' && path.startsWith('/user-attachments/assets/')) || host === 'user-images.githubusercontent.com' || host === 'private-user-images.githubusercontent.com') kind = 'image';
  else if (last !== '') {
    const k = kindOfFile(last, null);
    if (k !== 'file') kind = k;
  }
  return { url: u.href, stable, kind, name: cleanName(name) };
}

// The characters that end an address in prose or markdown.
const END_CHARS = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>', ')', ']', '|', '`', '{', '}', '\\']);
const TRAILING = /[.,;:!?*_~]+$/;

/** Every `https://` address in a text, in order, once each, at most `cap`. LINEAR. */
export function linksInText(text: string, cap = LINKS_MAX_PER_TEXT): string[] {
  const t = text.length > LINK_SCAN_MAX_CHARS ? text.slice(0, LINK_SCAN_MAX_CHARS) : text;
  const out: string[] = [];
  const seen = new Set<string>();
  let at = t.indexOf('https://');
  while (at >= 0 && out.length < cap) {
    let end = at + 8;
    const limit = Math.min(t.length, at + URL_MAX_CHARS);
    while (end < limit && !END_CHARS.has(t[end]!)) end++;
    const raw = t.slice(at, end).replace(TRAILING, '');
    if (raw.length > 8 && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
    at = t.indexOf('https://', end);
  }
  return out;
}

/** Jira's `fields.attachment` → attachments (defensive: the body is a stranger's JSON). */
export function jiraAttachmentsOf(raw: unknown): TicketAttachment[] {
  const fields = raw != null && typeof raw === 'object' ? (raw as { fields?: unknown }).fields : null;
  const list = fields != null && typeof fields === 'object' ? (fields as { attachment?: unknown }).attachment : null;
  if (!Array.isArray(list)) return [];
  const out: TicketAttachment[] = [];
  for (const a of list.slice(0, MANIFEST_MAX_ENTRIES)) {
    if (a == null || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : null;
    const filename = typeof o.filename === 'string' ? o.filename : null;
    const content = typeof o.content === 'string' ? o.content : null;
    if (id == null || !/^[0-9A-Za-z_-]{1,40}$/.test(id) || filename == null || content == null) continue;
    out.push({
      id,
      filename,
      mime: typeof o.mimeType === 'string' ? o.mimeType : null,
      size: typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : null,
      fetch: { kind: 'jira_attachment', contentUrl: content },
    });
  }
  return out;
}

/**
 * THE MANIFEST: attachments first (in the tracker's order), then the links in the description, then the
 * links in the comments. One entry per stable id; at most MANIFEST_MAX_ENTRIES.
 */
export function buildManifest(input: {
  provider: string;
  attachments: readonly TicketAttachment[];
  description: string;
  comments: string | null;
}): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const seen = new Set<string>();
  const push = (e: ManifestEntry): void => {
    if (out.length >= MANIFEST_MAX_ENTRIES || seen.has(e.artifact.id)) return;
    seen.add(e.artifact.id);
    out.push(e);
  };
  for (const a of input.attachments) {
    const mime = a.mime ?? undefined;
    push({
      artifact: {
        id: `a-${shortHash(`${input.provider}:attachment:${a.id}`)}`,
        kind: kindOfFile(a.filename, a.mime),
        source: 'attachment',
        name: cleanName(a.filename),
        url: null,
        ...(mime ? { mime } : {}),
        ...(a.size != null ? { size: a.size } : {}),
        fetchable: a.fetch.kind !== 'none',
      },
      fetch: a.fetch,
    });
  }
  const links = (text: string, source: TicketArtifactSource): void => {
    for (const raw of linksInText(text)) {
      const c = classifyLink(raw);
      if (c == null) continue;
      push({
        artifact: {
          id: `l-${shortHash(c.stable)}`,
          kind: c.kind,
          source,
          name: c.name,
          url: c.url,
          ...(c.figma ? { figma: c.figma } : {}),
          fetchable: false,
        },
        fetch: { kind: 'none' },
      });
    }
  };
  links(input.description, 'description');
  if (input.comments) links(input.comments, 'comment');
  return out;
}

const KIND_WORD: Record<TicketArtifactKind, string> = {
  figma: 'Figma',
  image: 'image',
  diagram: 'diagram',
  json: 'JSON',
  pdf: 'PDF',
  file: 'file',
  link: 'link',
};

function sizeText(n: number | undefined): string {
  if (n == null) return '';
  if (n < 1024) return ` · ${n} B`;
  if (n < 1024 * 1024) return ` · ${Math.round(n / 1024)} KB`;
  return ` · ${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The manifest as plain text (`ensemble-ticket list`). */
export function manifestText(entries: readonly ManifestEntry[]): string {
  if (entries.length === 0) return 'The ticket has no attachments or links.\n';
  const lines = entries.map(({ artifact: a }) => {
    const how = a.fetchable ? `ensemble-ticket get ${a.id}` : a.url != null ? a.url : 'not readable here';
    return `${a.id}  ${KIND_WORD[a.kind]} · ${a.source}${sizeText(a.size)} · ${a.name}\n      ${how}`;
  });
  return `${lines.join('\n')}\n`;
}
