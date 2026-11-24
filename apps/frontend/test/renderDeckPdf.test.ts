import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, type PDFPage } from 'pdf-lib';
import { buildDeck, type Deck } from '../src/components/Activity/report/deckModel.js';
import { openDeckPdf } from '../src/components/Activity/report/renderDeckPdf.js';
import { makeReport } from './adoptionReportFixture.js';

// REPORTS → DOWNLOAD REPORT, the PDF (renderDeckPdf.ts). pdf-lib runs in Node: the subset Inter TTFs
// are read from disk, the deck is drawn, and the bytes are loaded back and checked: page count and
// size, the metadata, no image anywhere, and the text is REAL text (decoded through the fonts'
// ToUnicode maps, the way a viewer's copy and search do).

const FONTS = join(__dirname, '..', 'src', 'fonts');
const fonts = { regular: readFileSync(join(FONTS, 'inter-regular.ttf')), semibold: readFileSync(join(FONTS, 'inter-semibold.ttf')) };

async function make(): Promise<{ deck: Deck; bytes: Uint8Array }> {
  const pdf = await openDeckPdf(fonts);
  const deck = buildDeck(makeReport(), {}, { preparedFor: 'Northwind board, Łódź', generatedOn: new Date('2026-11-23T10:00:00Z') }, pdf.metrics);
  return { deck, bytes: await pdf.render(deck) };
}

function streamBytes(doc: PDFDocument, obj: unknown): Uint8Array[] {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (o instanceof PDFRawStream) return [decodePDFRawStream(o).decode()];
  if (o instanceof PDFArray) return o.asArray().flatMap((x) => streamBytes(doc, x));
  return [];
}

/** The page's text: each `<hex> Tj` mapped through its font's ToUnicode CMap. */
function pageText(doc: PDFDocument, page: PDFPage): string {
  const fontsDict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  const cmaps = new Map<string, Map<string, string>>();
  for (const [name, ref] of fontsDict?.entries() ?? []) {
    const font = doc.context.lookup(ref, PDFDict);
    const cmapSrc = new TextDecoder().decode(streamBytes(doc, font.get(PDFName.of('ToUnicode')))[0]!);
    const map = new Map<string, string>();
    for (const m of cmapSrc.matchAll(/<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]+)>/g)) {
      const units = m[2]!.match(/.{4}/g)!.map((h) => Number.parseInt(h, 16));
      map.set(m[1]!.toLowerCase(), String.fromCharCode(...units));
    }
    cmaps.set(name.asString().slice(1), map);
  }
  const content = streamBytes(doc, page.node.Contents()).map((b) => new TextDecoder('latin1').decode(b)).join('\n');
  let current: Map<string, string> | undefined;
  const out: string[] = [];
  for (const m of content.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj/g)) {
    if (m[1] != null) current = cmaps.get(m[1]);
    else if (m[2] != null && current != null) out.push((m[2].match(/.{4}/g) ?? []).map((g) => current!.get(g.toLowerCase()) ?? '�').join(''));
  }
  return out.join('\n');
}

describe('renderDeckPdf', () => {
  it('writes one 960 × 540 page per deck page, with the title and no person in the metadata', async () => {
    const { deck, bytes } = await make();
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(deck.pages.length);
    for (const p of doc.getPages()) expect([p.getWidth(), p.getHeight()]).toEqual([960, 540]);
    expect(doc.getTitle()).toBe('AI adoption report — Acme Platform');
    expect(doc.getAuthor()).toBe('Ensemble');
    expect(doc.getCreator()).toBe('Ensemble');
    expect(doc.getProducer()).toBe('Ensemble');
  });

  it('holds no image: every chart is vector paths, every word is text', async () => {
    const { bytes } = await make();
    const doc = await PDFDocument.load(bytes);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      expect(dict?.get(PDFName.of('Subtype'))?.toString()).not.toBe('/Image');
    }
  });

  it('the text is real, extractable text, Latin Extended included', async () => {
    const { bytes } = await make();
    const doc = await PDFDocument.load(bytes);
    const all = doc.getPages().map((p) => pageText(doc, p)).join('\n');
    expect(all).toContain('AI adoption report');
    expect(all).toContain('How widely AI is used');
    expect(all).toContain('Prepared for Northwind board, Łódź');
    expect(all).toContain('AI was involved in 34% of merged PRs');
    expect(all).toContain('10 of 15 people merged a PR with AI involved');
    expect(all).not.toContain('�');
  });
});
