import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { DECK_GROUND, hexChannels } from './deckColors.js';
import { DECK_H, DECK_W, type Deck, type DeckPrimitive, type DeckTextMetrics, type DeckWeight } from './deckModel.js';

// THE PDF RENDERER (Reports → Download report). ⚠ THE ONLY IMPORTER OF pdf-lib AND @pdf-lib/fontkit,
// and it is loaded by dynamic import() only (vite.config.ts puts them in the `pdf` chunk), so the app
// never downloads them until the reader presses Download.
//
// It draws what deckModel.ts placed, nothing more: real selectable text in an embedded Inter subset
// (TTF; never WOFF2, which fontkit's subsetter cannot read; never the standard-14 fonts, which cannot
// encode "→" or "Łukasz"), tables as text, charts as vector paths. No images. A white ground on every
// page whatever the app's colour scheme.
//
// ⚠ Metadata never names a person: title "AI adoption report — <workspace>", author and creator
// "Ensemble", language en-GB.

export interface DeckFonts {
  regular: ArrayBuffer | Uint8Array;
  semibold: ArrayBuffer | Uint8Array;
}

export interface DeckPdf {
  /** Measure and check text with the embedded fonts (deckModel's injected metrics). */
  metrics: DeckTextMetrics;
  /** Draw the deck and return the PDF bytes. */
  render(deck: Deck): Promise<Uint8Array>;
}

const colorCache = new Map<string, RGB>();
function color(hex: string): RGB {
  let c = colorCache.get(hex);
  if (c == null) {
    const [r, g, b] = hexChannels(hex);
    c = rgb(r, g, b);
    colorCache.set(hex, c);
  }
  return c;
}

/** Open a PDF with the two fonts embedded, ready to measure and then draw a deck. */
export async function openDeckPdf(fonts: DeckFonts): Promise<DeckPdf> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts.regular, { subset: true });
  const semibold = await doc.embedFont(fonts.semibold, { subset: true });
  const semiboldSet = new Set(semibold.getCharacterSet());
  const drawable = new Set(regular.getCharacterSet().filter((cp) => semiboldSet.has(cp)));
  const font = (w: DeckWeight): PDFFont => (w === 'semibold' ? semibold : regular);

  const metrics: DeckTextMetrics = {
    width: (text, size, weight) => (text === '' ? 0 : font(weight).widthOfTextAtSize(text, size)),
    canDraw: (text) => {
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (!drawable.has(cp)) return false;
      }
      return true;
    },
  };

  const draw = (page: PDFPage, p: DeckPrimitive): void => {
    switch (p.kind) {
      case 'text': {
        const f = font(p.weight);
        const w = f.widthOfTextAtSize(p.text, p.size);
        const x = p.align === 'right' ? p.x - w : p.align === 'center' ? p.x - w / 2 : p.x;
        page.drawText(p.text, { x, y: DECK_H - p.y, size: p.size, font: f, color: color(p.color) });
        return;
      }
      case 'rect':
        page.drawRectangle({
          x: p.x,
          y: DECK_H - p.y - p.h,
          width: p.w,
          height: p.h,
          color: p.fill != null ? color(p.fill) : undefined,
          borderColor: p.stroke != null ? color(p.stroke) : undefined,
          borderWidth: p.stroke != null ? (p.strokeWidth ?? 1) : 0,
        });
        return;
      case 'line':
        page.drawLine({
          start: { x: p.x1, y: DECK_H - p.y1 },
          end: { x: p.x2, y: DECK_H - p.y2 },
          thickness: p.width,
          color: color(p.color),
          dashArray: p.dash,
        });
        return;
      case 'path':
        // drawSvgPath's origin is the top-left of the path's own space, y down: the deck's space.
        page.drawSvgPath(p.d, {
          x: 0,
          y: DECK_H,
          color: p.fill != null ? color(p.fill) : undefined,
          borderColor: p.stroke != null ? color(p.stroke) : undefined,
          borderWidth: p.stroke != null ? (p.width ?? 1) : undefined,
          borderDashArray: p.dash,
        });
        return;
      case 'circle':
        page.drawCircle({ x: p.cx, y: DECK_H - p.cy, size: p.r, color: color(p.fill) });
        return;
    }
  };

  return {
    metrics,
    async render(deck) {
      for (const d of deck.pages) {
        const page = doc.addPage([DECK_W, DECK_H]);
        page.drawRectangle({ x: 0, y: 0, width: DECK_W, height: DECK_H, color: color(DECK_GROUND) });
        for (const p of d.primitives) draw(page, p);
      }
      doc.setTitle(deck.title, { showInWindowTitleBar: true });
      doc.setAuthor('Ensemble');
      doc.setCreator('Ensemble');
      doc.setProducer('Ensemble');
      doc.setLanguage('en-GB');
      const now = new Date();
      doc.setCreationDate(now);
      doc.setModificationDate(now);
      return doc.save();
    },
  };
}
