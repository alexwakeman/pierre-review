import {
  ADOPTION_COMMENTARY_SLIDES,
  type AdoptionCommentaryResponse,
  type AdoptionCommentarySlide,
  type AiAdoptionReport,
} from '@pierre-review/shared';
import { ApiError, api } from '../../../api/client.js';
import regularUrl from '../../../fonts/inter-regular.ttf?url';
import semiboldUrl from '../../../fonts/inter-semibold.ttf?url';
import { buildDeck, commentaryFromResponse, deckFigureFormatter, reportFileName, type DeckCommentary } from './deckModel.js';

// MAKE THE REPORT (Reports → Download report; docs/AI-ADOPTION-REPORT.md § The UI). On the reader's
// press, never on mount: fetch the figures → (AI ticked) one commentary call per slide, in turn →
// draw the slides → build the PDF. Every stage reports real progress; ONE AbortSignal cancels it all.
//
// ⚠ A commentary call that does not come back 'ai' (404 AI off, 503 no credential, 502, a refusal,
//   a network error) ⇒ that slide's template wording. NEVER RETRIED. After a 404 / 503 / 429 the same
//   answer would come back for every slide, so the remaining slides use the template without a call.
// ⚠ Only the slide id and the report's `generatedAt` go to the server; the server holds the figures.
//   Names, logins, repos and "Prepared for" never leave this function.

export interface ReportProgress {
  /** 0..100. */
  pct: number;
  /** One plain line: "Fetching figures", "Writing commentary · slide 2 of 8"… */
  stage: string;
}

export interface BuildReportOptions {
  workspaceId: number;
  preparedFor: string;
  /** The reader ticked "Write commentary with AI" (and the gate showed it). */
  aiCommentary: boolean;
  signal: AbortSignal;
  onProgress: (p: ReportProgress) => void;
}

export interface BuiltReport {
  blob: Blob;
  filename: string;
  /** Commentary slides AI wrote, of `commentarySlides` (0 when AI was not ticked). */
  aiWritten: number;
  commentarySlides: number;
  aiRequested: boolean;
}

/** The stage ranges (docs/AI-ADOPTION-REPORT.md § The UI). */
export const REPORT_STAGES = {
  fetch: [0, 15],
  commentary: [15, 85],
  draw: [85, 95],
  build: [95, 100],
} as const;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The report was cancelled.', 'AbortError');
}

/**
 * Let the browser paint the stage just reported. Without it the stages after the figures arrive run
 * back to back in one task, React batches them, and the bar jumps from 0 to the end. A frame, or
 * 50 ms when the tab is hidden (no frames there).
 */
function nextPaint(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(done, 0));
    setTimeout(done, 50);
  }).then(() => throwIfAborted(signal));
}

async function fontBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('The report font could not be loaded.');
  return res.arrayBuffer();
}

/** One slide's commentary call: the answer, or null for "use the template" (and whether to stop). */
async function askCommentary(
  report: AiAdoptionReport,
  slide: AdoptionCommentarySlide,
  signal: AbortSignal,
): Promise<{ res: AdoptionCommentaryResponse | null; stop: boolean }> {
  try {
    const res = await api.adoptionCommentary({ workspaceId: report.workspaceId, slide, generatedAt: report.generatedAt }, { signal });
    return { res, stop: false };
  } catch (e) {
    if (signal.aborted) throw e;
    const status = e instanceof ApiError ? e.status : 0;
    return { res: null, stop: status === 404 || status === 503 || status === 429 };
  }
}

/** Fetch, write, draw and build. Throws an AbortError when cancelled. */
export async function buildReport(o: BuildReportOptions): Promise<BuiltReport> {
  const { signal, onProgress } = o;
  onProgress({ pct: REPORT_STAGES.fetch[0], stage: 'Fetching figures' });
  // The renderer and the fonts load in parallel with the figures (all three on this press only).
  const pdfModule = import('./renderDeckPdf.js');
  const fonts = Promise.all([fontBytes(regularUrl, signal), fontBytes(semiboldUrl, signal)]);
  // Neither may reject unobserved while the figures are still loading.
  pdfModule.catch(() => undefined);
  fonts.catch(() => undefined);
  const report = await api.aiAdoptionReport(o.workspaceId, { signal });
  throwIfAborted(signal);
  onProgress({ pct: REPORT_STAGES.fetch[1], stage: 'Fetching figures' });
  await nextPaint(signal);

  const fmt = deckFigureFormatter;
  const commentary: DeckCommentary = {};
  const slides = ADOPTION_COMMENTARY_SLIDES;
  const [c0, c1] = REPORT_STAGES.commentary;
  let stopped = !o.aiCommentary;
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    let res: AdoptionCommentaryResponse | null = null;
    if (!stopped) {
      onProgress({ pct: Math.round(c0 + ((c1 - c0) * i) / slides.length), stage: `Writing commentary · slide ${i + 1} of ${slides.length}` });
      const got = await askCommentary(report, slide, signal);
      throwIfAborted(signal);
      res = got.res;
      stopped = got.stop;
    }
    commentary[slide] = commentaryFromResponse(report, slide, res, fmt);
  }
  if (o.aiCommentary) onProgress({ pct: c1, stage: `Writing commentary · slide ${slides.length} of ${slides.length}` });

  onProgress({ pct: REPORT_STAGES.draw[0], stage: 'Drawing slides' });
  await nextPaint(signal);
  const [{ openDeckPdf }, [regular, semibold]] = await Promise.all([pdfModule, fonts]);
  throwIfAborted(signal);
  const pdf = await openDeckPdf({ regular, semibold });
  const generatedOn = new Date();
  const deck = buildDeck(report, commentary, { preparedFor: o.preparedFor, generatedOn }, pdf.metrics, fmt);
  throwIfAborted(signal);

  onProgress({ pct: REPORT_STAGES.build[0], stage: 'Building the PDF' });
  await nextPaint(signal);
  const bytes = await pdf.render(deck);
  throwIfAborted(signal);
  onProgress({ pct: REPORT_STAGES.build[1], stage: 'Building the PDF' });
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    filename: reportFileName(report.workspaceName, generatedOn),
    aiWritten: deck.aiWritten,
    commentarySlides: deck.commentarySlides,
    aiRequested: o.aiCommentary,
  };
}

/** The done line: what happened, in one sentence. With AI not asked for, nothing about AI. */
export function doneLine(b: Pick<BuiltReport, 'aiWritten' | 'commentarySlides' | 'aiRequested' | 'filename'>): string {
  if (!b.aiRequested) return `Saved ${b.filename}.`;
  const n = b.commentarySlides;
  if (b.aiWritten >= n) return `Saved. AI wrote all ${n} commentaries.`;
  if (b.aiWritten === 0) return 'Saved. AI wrote none of the commentaries; they use the standard wording.';
  const rest = n - b.aiWritten;
  return `Saved. AI wrote ${b.aiWritten} of ${n} commentaries; ${rest} ${rest === 1 ? 'uses' : 'use'} the standard wording.`;
}
