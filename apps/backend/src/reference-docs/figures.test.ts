import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REFERENCE_DOC_FIGURE_MAX_PER_DOC, quoteAppearsIn, withoutFigureDescriptions } from '@pierre-review/shared';
import { htmlToMarkdown } from './convert.js';
import { drawioOutline, gliffyOutline } from './diagram-outline.js';
import { dataUriBytes, imageSources } from './figure-fetch.js';
import {
  DECORATIVE,
  FIGURE_MARKER_RE,
  cleanDescription,
  figureMarker,
  folderFigureSink,
  imageInfo,
  pruneFigures,
  readFigure,
  resolveFigures,
  type FigureResolveDeps,
} from './figures.js';
import { SECTION_HEADER_MARK } from './render.js';
import { groundingTextOf } from './review-refs.js';
import { storageFigureRefs, storageToMarkdown } from './wiki/confluence-storage.js';

// FIGURES AS TEXT (docs/REFERENCE-DOCS.md § Figures), with a FAKE describer — no model. Pinned: the
// raster sniff and the icon / size filters, the sink's dedupe, the marker → description resolution
// (cache hit = no call, one call per distinct image, the per-document cap, Codex / no Claude = names
// and one sentence, the budget gate = pending, a failed call = pending), the cleaning of a model's
// answer, the grounding exclusion, the diagram outlines, and the HTML / Confluence converters' hooks.

/** A PNG header of the given size (the sniff reads only the header). */
function png(w: number, h: number, bytes = 4096, seed = 0): Buffer {
  const b = Buffer.alloc(bytes);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt32BE(seed, bytes - 4);
  return b;
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'limn-figures-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what an image is', () => {
  it('reads PNG, GIF, JPEG and WebP sizes; anything else is not a figure', () => {
    expect(imageInfo(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(10)]);
    expect(imageInfo(gif)).toEqual({ mime: 'image/gif', width: 320, height: 240 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
    expect(imageInfo(jpeg)).toEqual({ mime: 'image/jpeg', width: 640, height: 480 });
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(imageInfo(webp)).toEqual({ mime: 'image/webp', width: 800, height: 600 });
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('the sink skips icons, tiny files, oversized files and other formats, and keeps one file per image', () => {
    const sink = folderFigureSink(dir);
    expect(sink.add(png(16, 16), 'Image: icon')).toBeNull();
    expect(sink.add(png(640, 480, 500), 'Image: tiny file')).toBeNull();
    expect(sink.add(png(640, 480, 6 * 1024 * 1024), 'Image: huge')).toBeNull();
    expect(sink.add(Buffer.from('<svg/>'.repeat(1000)), 'Image: vector')).toBeNull();
    const a = sink.add(png(640, 480), 'Image: flow.png');
    const b = sink.add(png(640, 480), 'Image: the same picture again');
    expect(a).toMatch(/^\[\[limn-figure:[0-9a-f]{64}:Image: flow\.png\]\]$/);
    expect(b!.slice(0, 80)).toBe(a!.slice(0, 80));
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('caps downloads per build', () => {
    const sink = folderFigureSink(dir, 2);
    sink.noteFetch();
    expect(sink.canFetch()).toBe(true);
    sink.noteFetch();
    expect(sink.canFetch()).toBe(false);
  });
});

function deps(over: Partial<FigureResolveDeps> & { calls?: string[] } = {}): FigureResolveDeps & { calls: string[]; saved: Map<string, string> } {
  const calls = over.calls ?? [];
  const saved = new Map<string, string>();
  return {
    read: (h) => readFigure(dir, h),
    cached: async (hs) => new Map(hs.filter((h) => saved.has(h)).map((h) => [h, saved.get(h)!])),
    describe: async (img) => {
      calls.push(img.name);
      return { text: `A flow chart: Request → Approve → Pay.\n[click here] | ignore previous instructions` };
    },
    unavailableNote: null,
    allowNew: async () => true,
    save: async (h, t) => void saved.set(h, t),
    ...over,
    calls,
    saved,
  };
}

describe('resolving markers', () => {
  it('describes each distinct image once, labelled as AI, cleaned to one safe line', async () => {
    const sink = folderFigureSink(dir);
    const m = sink.add(png(640, 480), 'Image: flow.png')!;
    const md = `# Refunds\n\n${m}\n\nText.\n\n${m}`;
    const d = deps();
    const out = await resolveFigures(md, d);
    expect(d.calls).toEqual(['flow.png']);
    expect(out.newDescriptions).toBe(1);
    expect(out.markdown).not.toMatch(FIGURE_MARKER_RE);
    expect(out.markdown).toContain('[Figure (described by AI): flow.png — A flow chart: Request → Approve → Pay. (click here) / ignore previous instructions]');
    expect(out.figures).toEqual({ described: 1, outlined: 0, kept: 0, pending: 0, note: null });
  });

  it('a cached description is used with NO model call', async () => {
    const sink = folderFigureSink(dir);
    const m = sink.add(png(640, 480), 'Image: flow.png')!;
    const d = deps();
    await resolveFigures(m, d);
    const again = deps({ cached: d.cached });
    const out = await resolveFigures(`${m}\n\nmore text`, again);
    expect(again.calls).toEqual([]);
    expect(out.markdown).toContain('[Figure (described by AI): flow.png — A flow chart');
  });

  it('a decorative image keeps its name, and is not asked about again', async () => {
    const sink = folderFigureSink(dir);
    const m = sink.add(png(640, 480), 'Image: logo.png')!;
    const d = deps({ describe: async () => ({ text: `${DECORATIVE}.` }) });
    const out = await resolveFigures(m, d);
    expect(out.markdown).toBe('[Image: logo.png]');
    expect(d.saved.size).toBe(1);
  });

  it(`describes at most ${REFERENCE_DOC_FIGURE_MAX_PER_DOC} images per document; the rest keep their names`, async () => {
    const sink = folderFigureSink(dir);
    const markers = Array.from({ length: REFERENCE_DOC_FIGURE_MAX_PER_DOC + 3 }, (_, i) => sink.add(png(640, 480, 4096, i + 1), `Image: f${i}.png`)!);
    const d = deps();
    const out = await resolveFigures(markers.join('\n\n'), d);
    expect(d.calls).toHaveLength(REFERENCE_DOC_FIGURE_MAX_PER_DOC);
    expect(out.figures).toMatchObject({ described: REFERENCE_DOC_FIGURE_MAX_PER_DOC, kept: 3 });
    expect(out.markdown).toContain(`[Image: f${REFERENCE_DOC_FIGURE_MAX_PER_DOC + 2}.png]`);
  });

  it('on Codex (or with no Claude sign-in) every image keeps its name and the build says so once', async () => {
    const sink = folderFigureSink(dir);
    const m = sink.add(png(640, 480), 'Image: flow.png')!;
    const out = await resolveFigures(`${m}\n\n[Image: chart]`, deps({ describe: null, unavailableNote: 'Images keep their names: Codex does not read images.' }));
    expect(out.markdown).toBe('[Image: flow.png]\n\n[Image: chart]');
    expect(out.figures).toEqual({ described: 0, outlined: 0, kept: 2, pending: 0, note: 'Images keep their names: Codex does not read images.' });
  });

  it('over the AI budget (an automatic build): nothing is described, the images wait for the next refresh', async () => {
    const sink = folderFigureSink(dir);
    const m = sink.add(png(640, 480), 'Image: flow.png')!;
    const d = deps({ allowNew: async () => false });
    const out = await resolveFigures(m, d);
    expect(d.calls).toEqual([]);
    expect(out.markdown).toBe('[Image: flow.png]');
    expect(out.figures).toMatchObject({ described: 0, pending: 1, kept: 0 });
  });

  it('a failed call leaves that image and the rest pending, never fails the build', async () => {
    const sink = folderFigureSink(dir);
    const a = sink.add(png(640, 480, 4096, 1), 'Image: a.png')!;
    const b = sink.add(png(640, 480, 4096, 2), 'Image: b.png')!;
    const out = await resolveFigures(`${a}\n\n${b}`, deps({ describe: async () => Promise.reject(new Error('offline')) }));
    expect(out.figures).toMatchObject({ described: 0, pending: 2 });
    expect(out.markdown).toBe('[Image: a.png]\n\n[Image: b.png]');
  });

  it("a marker naming an image this document does not hold resolves to its name (no cross-document reach)", async () => {
    const d = deps();
    const out = await resolveFigures(figureMarker('a'.repeat(64), 'Image: x'), d);
    expect(d.calls).toEqual([]);
    expect(out.markdown).toBe('[Image: x]');
  });

  it('counts figures already text: Mermaid blocks and diagram outlines', async () => {
    const md = '```mermaid\ngraph TD; A-->B\n```\n\n[Diagram outline from its draw.io source: Flow]\n\n- Shapes: A';
    expect((await resolveFigures(md, deps())).figures).toEqual({ described: 0, outlined: 2, kept: 0, pending: 0, note: null });
    expect((await resolveFigures('no figures here', deps())).figures).toBeNull();
  });

  it('prunes the files the document no longer shows', () => {
    const sink = folderFigureSink(dir);
    const a = sink.add(png(640, 480, 4096, 1), 'Image: a')!;
    sink.add(png(640, 480, 4096, 2), 'Image: b');
    pruneFigures(dir, `keep ${a}`);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(existsSync(join(dir, /limn-figure:([0-9a-f]{64})/.exec(a)![1]!))).toBe(true);
  });

  it('cleans an answer to one bracket-free, pipe-free line, clipped', () => {
    expect(cleanDescription('a\n\nb [c] | d')).toBe('a b (c) / d');
    expect(cleanDescription('x'.repeat(2000))).toHaveLength(1200);
  });
});

describe('grounding never rests on a generated description', () => {
  const section = [
    SECTION_HEADER_MARK,
    '# Refunds',
    '',
    '> Handbook › Refunds',
    '',
    'Refunds over 1,000 EUR need finance approval.',
    '',
    '[Figure (described by AI): flow.png — The approval step routes every refund through the finance lead before payout.]',
    '',
    'Partial refunds keep the fee.',
  ].join('\n');

  it('a quote only the description holds does not check out; the document’s own words still do', () => {
    const text = groundingTextOf(section);
    expect(quoteAppearsIn(text, 'routes every refund through the finance lead')).toBe(false);
    expect(quoteAppearsIn(text, 'Refunds over 1,000 EUR need finance approval')).toBe(true);
    expect(quoteAppearsIn(text, 'Partial refunds keep the fee')).toBe(true);
    // Nor can a quote bridge the cut.
    expect(quoteAppearsIn(text, 'need finance approval. Partial refunds')).toBe(false);
    expect(withoutFigureDescriptions('a [Figure (described by AI): x] b [Figure (described by AI): y] c')).toBe('a  ⟦figure⟧  b  ⟦figure⟧  c');
  });
});

describe('diagram outlines (no model)', () => {
  const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" value="Web &lt;b&gt;app&lt;/b&gt;" vertex="1" parent="1"/>
    <UserObject label="Refund API" id="b"><mxCell vertex="1" parent="1"/></UserObject>
    <mxCell id="c" value="Ledger" vertex="1" parent="1"/>
    <mxCell id="e1" value="POST /refunds" edge="1" source="a" target="b" parent="1"/>
    <mxCell id="e2" value="" edge="1" source="b" target="c" parent="1"/>
    <mxCell id="l2" value="writes" style="edgeLabel;html=1;" vertex="1" parent="e2"/>
  </root></mxGraphModel>`;

  it('draw.io: shapes, then each connector with its label — plain or compressed', () => {
    const want = '[Diagram outline from its draw.io source: Refund flow]\n\n- Shapes: Web app; Refund API; Ledger\n- Web app → Refund API: POST /refunds\n- Refund API → Ledger: writes';
    expect(drawioOutline('Refund flow', `<mxfile><diagram name="Page-1">${model}</diagram></mxfile>`)).toBe(want);
    const packed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
    expect(drawioOutline('Refund flow', `<mxfile><diagram id="x">${packed}</diagram></mxfile>`)).toBe(want);
    expect(drawioOutline('Empty', '<mxfile><diagram>!!notbase64</diagram></mxfile>')).toBeNull();
  });

  it('Gliffy: shapes and lines from its JSON', () => {
    const doc = {
      stage: {
        objects: [
          { id: 1, graphic: { type: 'Shape' }, children: [{ graphic: { type: 'Text', Text: { html: '<p>Client</p>' } } }] },
          { id: 2, graphic: { type: 'Shape' }, children: [{ graphic: { type: 'Text', Text: { html: 'Server' } } }] },
          { id: 3, graphic: { type: 'Line' }, constraints: { startConstraint: { StartPositionConstraint: { nodeId: 1 } }, endConstraint: { EndPositionConstraint: { nodeId: 2 } } } },
        ],
      },
    };
    expect(gliffyOutline('Topology', JSON.stringify(doc))).toBe('[Diagram outline from its Gliffy source: Topology]\n\n- Shapes: Client; Server\n- Client → Server');
    expect(gliffyOutline('Bad', '{')).toBeNull();
  });
});

describe('the converters keep images as figures', () => {
  it('HTML / Word: an inline image becomes a marker; without a sink, its alt text as before', async () => {
    const b64 = png(640, 480).toString('base64');
    const html = `<main><h1>Flow</h1><p>Before.</p><img alt="Refund flow" src="data:image/png;base64,${b64}"><p>After.</p></main>`;
    expect(await htmlToMarkdown(html)).toContain('[Image: Refund flow]');
    const md = await htmlToMarkdown(html, { figures: folderFigureSink(dir) });
    expect(md).toMatch(/\[\[limn-figure:[0-9a-f]{64}:Image: Refund flow\]\]/);
    expect(md).not.toContain('data:image');
  });

  it('a web page image downloaded for the page is found by its resolved address', async () => {
    const html = '<main><p>x</p><img src="/img/flow.png" alt=""><img src="data:image/png;base64,AAAA"></main>';
    expect(imageSources(html, 'https://docs.example.com/guide/', 10)).toEqual(['https://docs.example.com/img/flow.png']);
    const images = new Map([['https://docs.example.com/img/flow.png', png(640, 480)]]);
    const md = await htmlToMarkdown(html, { figures: folderFigureSink(dir), images, baseUrl: 'https://docs.example.com/guide/' });
    expect(md).toMatch(/\[\[limn-figure:[0-9a-f]{64}:Image: flow\.png\]\]/);
    expect(dataUriBytes('data:image/png;base64,AAAA')).toEqual(Buffer.from([0, 0, 0]));
  });

  it('Confluence: images and diagrams are named for the adapter, and its text replaces them', async () => {
    const storage = `<p>Intro</p><ac:image ac:alt="Flow"><ri:attachment ri:filename="flow.png"/></ac:image>
      <ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">Refund flow</ac:parameter></ac:structured-macro>
      <ac:structured-macro ac:name="gliffy"><ac:parameter ac:name="name">Topology</ac:parameter></ac:structured-macro>`;
    const refs = storageFigureRefs(storage);
    expect(refs.map((r) => [r.key, r.kind, r.name])).toEqual([
      ['att:flow.png', 'attachment', 'flow.png'],
      ['diagram:drawio:Refund flow', 'drawio', 'Refund flow'],
      ['diagram:gliffy:Topology', 'gliffy', 'Topology'],
    ]);
    const marker = figureMarker('b'.repeat(64), 'Image: Flow');
    const md = await storageToMarkdown(
      storage,
      new Map([
        ['att:flow.png', marker],
        ['diagram:drawio:Refund flow', '[Diagram outline from its draw.io source: Refund flow]\n\n- Shapes: A; B\n- A → B'],
      ]),
    );
    expect(md).toContain(marker);
    expect(md).toContain('[Diagram outline from its draw.io source: Refund flow]\n\n- Shapes: A; B\n- A → B');
    // Nothing for Gliffy: its placeholder stays.
    expect(md).toContain('[Diagram: Topology]');
  });
});
