import { inflateRawSync } from 'node:zlib';

// A DIAGRAM FROM ITS OWN SOURCE, NO MODEL (docs/REFERENCE-DOCS.md § Figures). A draw.io or Gliffy diagram
// stored as a Confluence attachment is a file of shapes and connectors; this turns it into a
// DETERMINISTIC text outline — its labelled shapes, then each connector as "A → B: label" — so the
// library carries what the diagram says without a vision call, and the same file always gives the same
// text (so an unchanged diagram never changes a section's hash).
//
// ⚠ The file is a stranger's: every scan is a forward indexOf walk over a bounded window, the inflated
// size is capped, and the outline is capped too.

export const OUTLINE_MAX_SHAPES = 200;
export const OUTLINE_MAX_EDGES = 300;
const MAX_XML_CHARS = 5 * 1024 * 1024;
const LABEL_MAX = 160;

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#(\d{1,6});/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&amp;/g, '&');

/** A shape's label: HTML (escaped once in the attribute) → plain words on one line, no brackets. */
export function labelText(raw: string): string {
  const once = decodeEntities(raw);
  // Strip tags with a forward walk (no regex over a stranger's text with nested quantifiers).
  let out = '';
  let i = 0;
  while (i < once.length) {
    const lt = once.indexOf('<', i);
    if (lt < 0) {
      out += once.slice(i);
      break;
    }
    out += once.slice(i, lt);
    const gt = once.indexOf('>', lt);
    if (gt < 0) break;
    const tag = once.slice(lt + 1, Math.min(gt, lt + 12)).toLowerCase();
    if (/^(?:br|\/div|\/p|\/li)\b/.test(tag)) out += ' ';
    i = gt + 1;
  }
  return decodeEntities(out)
    .replace(/[[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX);
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = m[2] ?? m[3] ?? '';
  return out;
}

interface Shape {
  id: string;
  label: string;
}
interface Edge {
  source: string | null;
  target: string | null;
  label: string;
}

/** The outline's text (shared by both formats). Null when the diagram names nothing. */
export function renderOutline(kind: string, name: string, shapes: Shape[], edges: Edge[]): string | null {
  const byId = new Map(shapes.map((s) => [s.id, s.label]));
  const named = shapes.filter((s) => s.label !== '');
  const lines: string[] = [];
  const seenLabels = new Set<string>();
  const shapeList: string[] = [];
  for (const s of named) {
    if (seenLabels.has(s.label)) continue;
    seenLabels.add(s.label);
    shapeList.push(s.label);
    if (shapeList.length >= OUTLINE_MAX_SHAPES) break;
  }
  if (shapeList.length > 0) lines.push(`- Shapes: ${shapeList.join('; ')}`);
  let n = 0;
  for (const e of edges) {
    const a = e.source ? byId.get(e.source) || '' : '';
    const b = e.target ? byId.get(e.target) || '' : '';
    if (!a && !b && !e.label) continue;
    if (n++ >= OUTLINE_MAX_EDGES) break;
    lines.push(`- ${a || '(unlabelled)'} → ${b || '(unlabelled)'}${e.label ? `: ${e.label}` : ''}`);
  }
  if (lines.length === 0) return null;
  const title = labelText(name) || 'untitled';
  return `[Diagram outline from its ${kind} source: ${title}]\n\n${lines.join('\n')}`;
}

/** The XML of each page of a draw.io file (compressed pages inflated), in order. */
export function drawioPages(file: string): string[] {
  const text = file.length > MAX_XML_CHARS ? file.slice(0, MAX_XML_CHARS) : file;
  if (!text.includes('<mxfile')) return text.includes('<mxGraphModel') ? [text] : [];
  const out: string[] = [];
  let at = text.indexOf('<diagram');
  while (at >= 0 && out.length < 10) {
    const open = text.indexOf('>', at);
    if (open < 0) break;
    const close = text.indexOf('</diagram>', open);
    const inner = text.slice(open + 1, close < 0 ? text.length : close).trim();
    if (inner.startsWith('<')) out.push(inner);
    else if (inner !== '') {
      try {
        const raw = inflateRawSync(Buffer.from(inner, 'base64'), { maxOutputLength: MAX_XML_CHARS }).toString('utf8');
        let xml = raw;
        try {
          xml = decodeURIComponent(raw);
        } catch {
          /* already plain */
        }
        if (xml.includes('<mxGraphModel')) out.push(xml);
      } catch {
        /* an unreadable page */
      }
    }
    if (close < 0) break;
    at = text.indexOf('<diagram', close + 10);
  }
  return out;
}

/** A draw.io file → its outline, or null when it holds no labelled shape or connector. */
export function drawioOutline(name: string, file: string): string | null {
  const shapes: Shape[] = [];
  const edges: Array<Edge & { id: string }> = [];
  const edgeLabels = new Map<string, string[]>();
  const edgeIds = new Set<string>();
  for (const xml of drawioPages(file)) {
    let wrapper: { id: string; label: string } | null = null;
    let at = xml.indexOf('<');
    while (at >= 0) {
      const end = xml.indexOf('>', at);
      if (end < 0) break;
      const tag = xml.slice(at + 1, Math.min(end, at + 1 + 16_384));
      const nameEnd = tag.search(/[\s/>]|$/);
      const tagName = tag.slice(0, nameEnd);
      if (tagName === 'UserObject' || tagName === 'object') {
        const a = attrsOf(tag);
        wrapper = { id: a['id'] ?? '', label: labelText(a['label'] ?? a['value'] ?? '') };
      } else if (tagName === 'mxCell') {
        const a = attrsOf(tag);
        const id = wrapper?.id || a['id'] || '';
        const label = wrapper ? wrapper.label : labelText(a['value'] ?? '');
        wrapper = null;
        if (a['edge'] === '1') {
          edgeIds.add(id);
          edges.push({ id, source: a['source'] ?? null, target: a['target'] ?? null, label });
        } else if (a['vertex'] === '1') {
          const parent = a['parent'] ?? '';
          if (/\bedgeLabel\b/.test(a['style'] ?? '') || edgeIds.has(parent)) {
            if (label) (edgeLabels.get(parent) ?? edgeLabels.set(parent, []).get(parent)!).push(label);
          } else shapes.push({ id, label });
        }
        if (shapes.length > OUTLINE_MAX_SHAPES * 5 || edges.length > OUTLINE_MAX_EDGES * 5) break;
      }
      at = xml.indexOf('<', end);
    }
  }
  // Labels drawn on a connector (a child cell of the edge) join its own value.
  edges.forEach((e) => {
    const extra = edgeLabels.get(e.id) ?? [];
    if (extra.length > 0) e.label = [e.label, ...extra].filter(Boolean).join(' ').slice(0, LABEL_MAX);
  });
  return renderOutline('draw.io', name, shapes, edges);
}

/** A Gliffy file (JSON) → its outline, or null. */
export function gliffyOutline(name: string, file: string): string | null {
  if (file.length > MAX_XML_CHARS) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(file);
  } catch {
    return null;
  }
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
  const textOf = (o: Obj): string => {
    const g = obj(o.graphic);
    const t = obj(g?.Text);
    if (typeof t?.html === 'string') return labelText(t.html);
    for (const c of Array.isArray(o.children) ? o.children : []) {
      const co = obj(c);
      const cg = obj(co?.graphic);
      if (co && cg?.type === 'Text') {
        const ct = obj(cg.Text);
        if (typeof ct?.html === 'string') return labelText(ct.html);
      }
    }
    return '';
  };
  const shapes: Shape[] = [];
  const edges: Edge[] = [];
  const stack: unknown[] = [...((Array.isArray(obj(obj(doc)?.stage)?.objects) ? (obj(obj(doc)!.stage)!.objects as unknown[]) : []) as unknown[])];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    visited += 1;
    const o = obj(stack.pop());
    if (!o) continue;
    const g = obj(o.graphic);
    const id = o.id != null ? String(o.id) : '';
    if (g?.type === 'Line') {
      const c = obj(o.constraints);
      const s = obj(obj(c?.startConstraint)?.StartPositionConstraint)?.nodeId;
      const e = obj(obj(c?.endConstraint)?.EndPositionConstraint)?.nodeId;
      edges.push({ source: s != null ? String(s) : null, target: e != null ? String(e) : null, label: textOf(o) });
      continue;
    }
    if (g?.type !== 'Text') shapes.push({ id, label: textOf(o) });
    else if (id) shapes.push({ id, label: textOf(o) });
    for (const c of Array.isArray(o.children) ? o.children : []) {
      const co = obj(c);
      if (co && obj(co.graphic)?.type !== 'Text') stack.push(co);
    }
  }
  return renderOutline('Gliffy', name, shapes.reverse(), edges.reverse());
}
