// Activity → Docs: which building documents get a live SSE stream, and how often the list polls.
//
// ⚠ A STREAM HOLDS AN HTTP/1.1 CONNECTION (~6 per origin). Streaming every queued row of a large
// drop starved the uploads and the pane's reads, so only documents the server is working on stream,
// at most MAX_DOC_STREAMS, and trouble is tracked per document.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend referenceDocsStreams
import { describe, expect, it } from 'vitest';
import type { ReferenceDocStatus } from '@pierre-review/shared';
import { MAX_DOC_STREAMS, docsListPollMs, docsToStream } from '../src/lib/referenceDocs.js';

const doc = (id: number, status: ReferenceDocStatus) => ({ id, status });
const none = new Set<number>();

describe('docsToStream', () => {
  it('never streams a queued document', () => {
    expect(docsToStream([doc(1, 'queued'), doc(2, 'queued')], none)).toEqual([]);
  });

  it('streams documents being worked on, capped', () => {
    const docs = [doc(1, 'converting'), doc(2, 'sectioning'), doc(3, 'indexing'), doc(4, 'ready')];
    const ids = docsToStream(docs, none);
    expect(ids.length).toBe(MAX_DOC_STREAMS);
    expect(ids).toEqual([1, 2]);
  });

  it('a large drop opens at most the cap', () => {
    const docs = [doc(1, 'converting'), ...Array.from({ length: 30 }, (_, i) => doc(i + 2, 'queued' as const))];
    expect(docsToStream(docs, none)).toEqual([1]);
  });

  it('does not reopen a document whose stream is in trouble', () => {
    expect(docsToStream([doc(1, 'sectioning'), doc(2, 'converting')], new Set([1]))).toEqual([2]);
  });
});

describe('docsListPollMs', () => {
  it('does not poll when nothing builds', () => {
    expect(docsListPollMs([doc(1, 'ready'), doc(2, 'failed')], none)).toBe(false);
  });

  it('is a 15s safety net while every building document streams', () => {
    expect(docsListPollMs([doc(1, 'sectioning'), doc(2, 'ready')], none)).toBe(15_000);
  });

  it('polls every 5s while a building document is queued (unstreamed)', () => {
    expect(docsListPollMs([doc(1, 'sectioning'), doc(2, 'queued')], none)).toBe(5_000);
  });

  it('polls every 3s while one document is in trouble, whatever the others do', () => {
    expect(docsListPollMs([doc(1, 'sectioning'), doc(2, 'converting')], new Set([1]))).toBe(3_000);
  });

  it('a trouble id for a finished document does not keep fast polling on', () => {
    expect(docsListPollMs([doc(1, 'ready'), doc(2, 'sectioning')], new Set([1]))).toBe(15_000);
  });
});
