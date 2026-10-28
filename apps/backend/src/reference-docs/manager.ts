import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReferenceDocCrawl,
  type ReferenceDocSourceKind,
  type ReferenceDocStatus,
  type ReferenceDocStreamEvent,
} from '@pierre-review/shared';
import { CodexNotInstalledError } from '../ai/codex/home.js';
import { providerName } from '../ai/prompt-tools.js';
import { activeProviderId } from '../ai/provider-setting.js';
import { AiRuntimeMissingError } from '../ai/runtime.js';
import { config } from '../config.js';
import type { AgentContext } from '../review/agent-context.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../review/claude-review/manager.js';
import { pickReviewNonce } from '../review/claude-review/prompts.js';
import { outstanding, type BuildMode } from './build-judge.js';
import { ConverterMissingError, convertToMarkdown, htmlToMarkdown, pdfPageCount, sniffFetched, sniffUpload, type SniffResult } from './convert.js';
import { CrawlRefusal, bundleCrawlMarkdown, crawlSite, type BundlePage } from './crawl.js';
import { makeLinkRanker } from './crawl-rank.js';
import { installDocFolder, readSource, saveSource, writeIndex } from './library.js';
import { claimWorkspaceDir, loadDocsOwner } from './owner.js';
import { stagingRoot, workspaceDocsDir } from './paths.js';
import { BUILD_PDF_SYSTEM_PROMPT, buildPdfPrompt, buildSectionsPrompt, buildSectionsSystemPrompt } from './prompts.js';
import { draftsFromWritten, renderDocFolder, trimTitle } from './assemble.js';
import { sectionFileNames, validateDocFolder } from './render.js';
import { DocumentTooLongError, MAX_SECTIONS, splitMarkdown, type DraftSection } from './split.js';
import { crawlOf, getDocRow, markDocFailed, patchDoc, saveDocBuilt, type DocRow, type Telemetry } from './store.js';
import { UrlFetchError, fetchPage, type FetchedPage } from './url-fetch.js';

// THE REFERENCE-DOCS BUILD QUEUE (docs/REFERENCE-DOCS.md § The build). One Sonnet 5 agent run per
// document, and:
//
//   ONE BUILD AT A TIME PER ACCOUNT. The rest wait FIFO (an upload of five files builds them in turn).
//   THE SHARED REVIEW SLOTS. A build is a peer of the review queue (`registerReviewSlotPeer`): it
//            starts only while a REVIEW_CONCURRENCY slot is free and no PR-review click is waiting,
//            so a long PDF never starves a review someone just asked for.
//   PROGRESS is a stage + a percentage, persisted on the row (throttled) and pushed to every open
//            `GET /api/docs/:id/stream` through the in-process bus below.
//
// THE PIPELINE (`runBuild`):
//   converting  read the stored source (a URL is fetched again, under the guard); work out its kind;
//               a PDF over DOCS_PDF_MAX_PAGES is refused before any model runs.
//   sectioning  'sections' mode (text, markdown, Word, HTML): the server converts and SPLITS the text
//               (split.ts) and the agent records a summary per section. 'pdf' mode: the agent reads
//               the PDF natively, writes the sections and records them.
//   indexing    the server renders CONTENTS.md and every section's header, checks the folder
//               (render.ts `validateDocFolder`), moves it into the library in one rename and rewrites
//               INDEX.md from the rows.
// A failure leaves the last built version in place and readable. The staging folder is always removed.

interface Job {
  ctx: AgentContext;
  accountId: number;
  workspaceId: number;
  docId: number;
}

const lane: Job[] = [];
const runningByAccount = new Map<number, Job>();
const controllers = new Map<number, AbortController>();
const listeners = new Map<number, Set<(e: ReferenceDocStreamEvent) => void>>();

registerReviewSlotPeer({ inFlight: () => runningByAccount.size, pump: () => pump() });

export function subscribeDocBuild(docId: number, fn: (e: ReferenceDocStreamEvent) => void): () => void {
  let set = listeners.get(docId);
  if (!set) {
    set = new Set();
    listeners.set(docId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(docId);
  };
}

function publish(e: ReferenceDocStreamEvent): void {
  for (const fn of listeners.get(e.docId) ?? []) {
    try {
      fn(e);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Is a build of this document queued or running in this process? */
export function buildHeld(docId: number): boolean {
  return lane.some((j) => j.docId === docId) || [...runningByAccount.values()].some((j) => j.docId === docId);
}

/** Queue a document whose row is already `queued`. */
export function enqueueBuild(ctx: AgentContext, accountId: number, workspaceId: number, docId: number): void {
  if (!AGENTIC_AI_ENABLED || buildHeld(docId)) return;
  lane.push({ ctx, accountId, workspaceId, docId });
  publish({ type: 'progress', docId, status: 'queued', progress: 0, stage: 'Waiting to start' });
  pump();
}

/** Stop a queued or running build. A running one ends at its next step; the old version stays. */
export async function cancelBuild(accountId: number, docId: number): Promise<boolean> {
  const idx = lane.findIndex((j) => j.docId === docId && j.accountId === accountId);
  if (idx >= 0) {
    lane.splice(idx, 1);
    await markDocFailed(accountId, docId, 'Cancelled.');
    publish({ type: 'done', docId, status: 'failed', error: 'Cancelled.' });
    return true;
  }
  const running = runningByAccount.get(accountId);
  if (running?.docId === docId) {
    controllers.get(docId)?.abort();
    return true;
  }
  return false;
}

function pump(): void {
  for (let i = 0; i < lane.length; ) {
    if (!reviewSlotFree() || reviewLaneWaiting().manual) return;
    const job = lane[i]!;
    if (runningByAccount.has(job.accountId)) {
      i += 1;
      continue;
    }
    lane.splice(i, 1);
    launch(job);
  }
}

function launch(job: Job): void {
  runningByAccount.set(job.accountId, job);
  const controller = new AbortController();
  controllers.set(job.docId, controller);
  void runBuild(job, controller)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      job.ctx.log.warn(`reference doc ${job.docId} build failed: ${message}`);
      await markDocFailed(job.accountId, job.docId, 'The build stopped unexpectedly.').catch(() => {});
      publish({ type: 'done', docId: job.docId, status: 'failed', error: 'The build stopped unexpectedly.' });
    })
    .finally(() => {
      runningByAccount.delete(job.accountId);
      controllers.delete(job.docId);
      pump();
      pumpReviewLane();
    });
}

// ---- progress ----

function progressReporter(accountId: number, docId: number) {
  let lastWrite = 0;
  let lastPct = -1;
  let lastStage: string | null = null;
  let lastStatus: ReferenceDocStatus | null = null;
  return (status: ReferenceDocStatus, pct: number, stage: string, force = false): void => {
    const progress = Math.max(0, Math.min(100, Math.round(pct)));
    publish({ type: 'progress', docId, status, progress, stage });
    const now = Date.now();
    const changed = status !== lastStatus || stage !== lastStage || progress !== lastPct;
    if (!changed) return;
    if (!force && status === lastStatus && now - lastWrite < 1500) return;
    lastWrite = now;
    lastPct = progress;
    lastStage = stage;
    lastStatus = status;
    void patchDoc(accountId, docId, { status, progress, stage }).catch(() => {});
  };
}

// ---- the pipeline ----

class BuildRefusal extends Error {}

interface SourceRead {
  body: Buffer;
  sniff: Extract<SniffResult, { ok: true }>;
  /** Set when the document is a crawl: what it read, to store once the build succeeds. */
  crawl?: { stored: ReferenceDocCrawl; costUsd: number };
}

type Report = ReturnType<typeof progressReporter>;

/** A fetched single page → its kind, stored as the source. */
function singlePage(row: DocRow, page: FetchedPage): SourceRead {
  const sniff = sniffFetched(page.body, page.contentType, page.url);
  if (!sniff.ok) throw new BuildRefusal(sniff.message);
  saveSource(row.accountId, row.workspaceId, row.slug, page.body, sniff.ext);
  return { body: page.body, sniff };
}

/**
 * "Follow links" (docs/REFERENCE-DOCS.md § Following links): crawl the site from the stored address
 * (crawl.ts, every request through the guarded `fetchPage`), then bundle the pages into ONE markdown
 * source — a chapter per page — that the ordinary 'sections' pipeline splits and summarises.
 */
async function crawlSource(job: Job, row: DocRow, crawl: ReferenceDocCrawl, report: Report, signal: AbortSignal): Promise<SourceRead> {
  const { ctx, accountId } = job;
  const { cheapComplete } = await import('../review/llm.js');
  const ranker = makeLinkRanker({
    complete: (o) => cheapComplete(o),
    onUsage: (u) =>
      ctx
        .recordAiUsage({ accountId, seam: 'summary', feature: 'docs_crawl_rank', ...u })
        .catch(() => {}),
  });
  let outcome;
  try {
    outcome = await crawlSite(
      row.sourceUrl!,
      crawl.depth,
      {
        fetch: (url, maxBytes) => fetchPage(url, undefined, undefined, maxBytes),
        rank: async (req) => {
          try {
            return await ranker(req);
          } catch (err) {
            ctx.log.warn(`reference doc ${job.docId}: link ranking failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new CrawlRefusal(
              // ⚠ A missing Codex is an AiRuntimeMissingError too: its own sentence names its remedy.
              err instanceof CodexNotInstalledError
                ? `No links were followed. ${err.message}`
                : err instanceof AiRuntimeMissingError
                ? 'Claude is not set up here, so no links were followed. Press "Set up AI", then rebuild.'
                : `${providerName()} could not be reached to choose which links to follow.`,
            );
          }
        },
        signal,
        onProgress: (read, max) => report('converting', 3 + (5 * read) / max, `Crawling ${read} of ${max}`),
      },
      crawl.maxPages,
    );
  } catch (err) {
    if (err instanceof CrawlRefusal) throw new BuildRefusal(err.message);
    if (err instanceof UrlFetchError) throw new BuildRefusal(err.message);
    throw err;
  }
  if (outcome.kind === 'single') return singlePage(row, outcome.page);
  report('converting', 8, 'Converting pages to markdown', true);
  const bundled: BundlePage[] = [];
  for (const p of outcome.pages) {
    if (signal.aborted) throw new BuildRefusal('Cancelled.');
    bundled.push({ url: p.url, title: p.title, markdown: await htmlToMarkdown(p.html) });
  }
  const body = Buffer.from(bundleCrawlMarkdown(bundled), 'utf8');
  saveSource(row.accountId, row.workspaceId, row.slug, body, 'md');
  return {
    body,
    sniff: { ok: true, kind: 'markdown', ext: 'md' },
    crawl: {
      stored: { ...crawl, pages: outcome.pages.map((p) => ({ url: p.url, title: p.title, depth: p.depth })), skipped: outcome.skipped },
      costUsd: outcome.costUsd,
    },
  };
}

/** The document's bytes and their kind. A URL is fetched again; anything else reads the stored source. */
async function readSourceFor(job: Job, row: DocRow, report: Report, signal: AbortSignal): Promise<SourceRead> {
  if (row.sourceKind === 'url') {
    if (!row.sourceUrl) throw new BuildRefusal('This document has no address to read.');
    const crawl = crawlOf(row.crawl);
    if (crawl) return crawlSource(job, row, crawl, report, signal);
    let page;
    try {
      page = await fetchPage(row.sourceUrl);
    } catch (err) {
      throw new BuildRefusal(err instanceof UrlFetchError ? err.message : 'The page could not be read.');
    }
    return singlePage(row, page);
  }
  const src = readSource(row.accountId, row.workspaceId, row.slug);
  if (!src) throw new BuildRefusal('The uploaded file is missing. Remove this document and upload it again.');
  const sniff = sniffUpload(src.body, `${row.sourceName}.${src.ext}`);
  if (!sniff.ok) throw new BuildRefusal(sniff.message);
  return { body: src.body, sniff };
}

async function runBuild(job: Job, controller: AbortController): Promise<void> {
  const { ctx, accountId, docId } = job;
  const report = progressReporter(accountId, docId);
  const row = await getDocRow(accountId, docId);
  if (!row) return;
  const finishFailed = async (message: string, t: Telemetry = {}): Promise<void> => {
    await markDocFailed(accountId, docId, message, t);
    publish({ type: 'done', docId, status: 'failed', error: message });
  };
  await patchDoc(accountId, docId, { buildStartedAt: new Date(), error: null });
  report('converting', 3, row.sourceKind === 'url' ? 'Reading the page' : 'Reading the file', true);

  await loadDocsOwner().catch(() => null);
  claimWorkspaceDir(workspaceDocsDir(accountId, row.workspaceId));
  const staging = join(stagingRoot(accountId, row.workspaceId), `${row.slug}-${docId}-${Date.now().toString(36)}`);
  const sectionsDir = join(staging, 'sections');
  try {
    mkdirSync(sectionsDir, { recursive: true });
    const { body, sniff, crawl: crawled } = await readSourceFor(job, row, report, controller.signal);
    const effective: Exclude<ReferenceDocSourceKind, 'url'> = sniff.kind;
    let mode: BuildMode;
    let drafts: DraftSection[] = [];
    let names: string[] = [];
    let convertedTitle: string | null = null;
    let pageCount: number | null = null;

    if (effective === 'pdf') {
      // ⚠ A PDF is read through Claude's own Read tool: Codex cannot read one (reference-docs/agent.ts).
      // Refused before anything is written or run — free.
      if (activeProviderId() === 'codex') {
        const { CODEX_PDF_MESSAGE } = await import('./agent.js');
        throw new BuildRefusal(CODEX_PDF_MESSAGE);
      }
      mode = 'pdf';
      pageCount = pdfPageCount(body);
      if (pageCount != null && pageCount > config.docsPdfMaxPages) {
        throw new BuildRefusal(`This PDF has ${pageCount} pages. The limit is ${config.docsPdfMaxPages}.`);
      }
      writeFileSync(join(staging, 'source.pdf'), body);
      await patchDoc(accountId, docId, { byteSize: body.length, pageCount });
    } else {
      mode = 'sections';
      report('converting', 8, 'Converting to markdown', true);
      const converted = await convertToMarkdown(effective, body);
      convertedTitle = converted.title;
      if (converted.markdown.trim() === '') throw new BuildRefusal('No text could be read from this file.');
      drafts = splitMarkdown(converted.markdown, trimTitle(convertedTitle ?? row.title) || 'Introduction');
      if (drafts.length === 0) throw new BuildRefusal('No text could be read from this file.');
      names = sectionFileNames(drafts.map((d) => d.title));
      drafts.forEach((d, i) => {
        const crumb = d.trail.length > 0 ? `> ${d.trail.join(' › ')}\n\n` : '';
        writeFileSync(join(sectionsDir, names[i]!), `# ${d.title}\n\n${crumb}${d.body}\n`);
      });
      await patchDoc(accountId, docId, { byteSize: body.length });
      // The folder check, run on the server's own split BEFORE the paid run: whatever it would refuse
      // here it would refuse after the agent too, so a refusal costs nothing. Removed before the agent
      // starts (its cwd is `staging`).
      const precheckDir = join(staging, 'precheck', row.slug);
      renderDocFolder(
        precheckDir,
        { slug: row.slug, title: trimTitle(convertedTitle ?? row.title) || row.title, summary: '', sourceLabel: row.sourceUrl ?? row.sourceName },
        drafts.map((d) => ({ ...d, summary: '' })),
      );
      const pre = validateDocFolder(precheckDir);
      rmSync(join(staging, 'precheck'), { recursive: true, force: true });
      if (!pre.ok) {
        ctx.log.warn(`reference doc ${docId}: pre-build folder check failed: ${pre.problems.slice(0, 5).join(' | ')}`);
        throw new BuildRefusal(`This document could not be split into sections: ${pre.problems[0]}`);
      }
    }
    if (controller.signal.aborted) throw new BuildRefusal('Cancelled.');

    // ---- the agent ----
    report('sectioning', mode === 'pdf' ? 12 : 20, mode === 'pdf' ? 'Reading the PDF' : 'Summarising sections', true);
    const promptDoc = { title: row.title, sourceName: row.sourceUrl ?? row.sourceName, sourceKind: effective };
    const nonce = pickReviewNonce([row.title, row.sourceName, row.sourceUrl ?? '', ...drafts.map((d) => [...d.trail, d.title].join(' '))]);
    const { runBuildAgent } = await import('./agent.js');
    const res = await runBuildAgent({
      mode,
      cwd: staging,
      sectionsDir,
      expected: names,
      systemPrompt: mode === 'pdf' ? BUILD_PDF_SYSTEM_PROMPT : buildSectionsSystemPrompt(),
      prompt: mode === 'pdf' ? buildPdfPrompt(promptDoc, pageCount, nonce) : buildSectionsPrompt(promptDoc, drafts, names, nonce),
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: controller,
      // Codex records its own ledger row from this (its model, US$ 0 on a ChatGPT login, its tokens).
      usageRecord: { accountId, seam: 'agent', feature: 'reference_docs_build' },
      onProgress: (p) => {
        if (mode === 'sections') {
          const frac = p.expected > 0 ? p.recorded / p.expected : 0;
          report('sectioning', 20 + 65 * frac, `Summarising sections (${p.recorded} of ${p.expected})`);
        } else if (pageCount != null && pageCount > 0) {
          const frac = Math.min(1, p.pagesRead / pageCount);
          report(
            'sectioning',
            12 + 70 * frac,
            p.pagesRead > 0 ? `Writing sections (page ${Math.min(p.pagesRead, pageCount)} of ${pageCount})` : 'Reading the PDF',
          );
        } else {
          report('sectioning', Math.min(80, 12 + p.written * 2), p.written > 0 ? `Writing sections (${p.written} written)` : 'Reading the PDF');
        }
      },
    });
    const crawlCost = crawled?.costUsd ?? 0;
    const telemetry: Telemetry = {
      costUsd: res.costUsd != null || crawlCost > 0 ? (res.costUsd ?? 0) + crawlCost : null,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
      // What ran the build (provider + model id).
      provider: res.provider,
      model: res.model,
    };
    // A Codex run's row is already written (by its provider, as Codex): never a second, Claude-named one.
    if (res.provider !== 'codex' && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'agent',
          feature: 'reference_docs_build',
          model: 'claude-sonnet-5',
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
        })
        .catch(() => {});
    }
    if (res.aborted) return await finishFailed('Cancelled.', telemetry);
    if (res.finish == null) return await finishFailed(res.failureReason ?? `${providerName(res.provider)} did not finish the document.`, telemetry);

    // ---- indexing ----
    report('indexing', 90, 'Building the contents', true);
    let finalDrafts: Array<DraftSection & { summary: string }>;
    if (mode === 'sections') {
      finalDrafts = drafts.map((d, i) => {
        const rec = res.state.recorded.get(names[i]!);
        return { ...d, title: rec?.title ? trimTitle(rec.title) : d.title, summary: rec?.summary ?? '' };
      });
    } else {
      const order = [...res.state.order, ...outstanding(res.state, readdirMd(sectionsDir))];
      finalDrafts = draftsFromWritten(order, res.state.recorded, (f) => readFileSync(join(sectionsDir, f), 'utf8'));
    }
    if (finalDrafts.length === 0) return await finishFailed(`${providerName(res.provider)} wrote no sections.`, telemetry);
    if (finalDrafts.length > MAX_SECTIONS) {
      return await finishFailed(`This document is too long: ${finalDrafts.length} sections, and the limit is ${MAX_SECTIONS}.`, telemetry);
    }
    const title = trimTitle(res.finish.title ?? convertedTitle ?? row.title) || row.title;
    const outDir = join(staging, 'out', row.slug);
    const entries = renderDocFolder(
      outDir,
      { slug: row.slug, title, summary: res.finish.summary, sourceLabel: row.sourceUrl ?? row.sourceName },
      finalDrafts,
    );
    const v = validateDocFolder(outDir);
    if (!v.ok) {
      ctx.log.warn(`reference doc ${docId}: folder check failed: ${v.problems.slice(0, 5).join(' | ')}`);
      return await finishFailed(`The built document did not pass its checks: ${v.problems[0]}`, telemetry);
    }
    // Removed while it built: put nothing on disk.
    if ((await getDocRow(accountId, docId)) == null) return;
    installDocFolder(accountId, row.workspaceId, row.slug, outDir);
    await saveDocBuilt(accountId, docId, { title, summary: res.finish.summary, topics: res.finish.topics, sections: entries }, telemetry);
    if (crawled) await patchDoc(accountId, docId, { crawl: crawled.stored });
    await writeIndex(accountId, row.workspaceId);
    publish({ type: 'done', docId, status: 'ready', error: null });
  } catch (err) {
    const message =
      err instanceof BuildRefusal || err instanceof ConverterMissingError || err instanceof DocumentTooLongError
        ? err.message
        : null;
    if (message == null) throw err;
    await finishFailed(message);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function readdirMd(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

/** Test seam: the lane, in order. */
export function _docsLaneForTest(): number[] {
  return lane.map((j) => j.docId);
}
