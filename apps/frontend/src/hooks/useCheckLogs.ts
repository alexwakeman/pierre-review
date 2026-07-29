import { useInfiniteQuery } from '@tanstack/react-query';
import type { CheckLogsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// A GitHub Actions job log can be many MB, so the viewer reads it as a WINDOW: the first
// page is the TAIL (where a failure almost always is — and it's the useful end for a
// passing job too), and scrolling up pulls the adjacent EARLIER chunk. Each response
// states the window it served, so the next page is simply "the LOG_PAGE_BYTES ending
// where the earliest loaded page began".
//
// React Query keeps pages newest-first (page 0 = the tail, page N = the earliest), so the
// rendered text is the pages REVERSED — see `joinLogPages`.

export const LOG_PAGE_BYTES = 128 * 1024;

type LogPageParam = { startByte: number; endByte: number } | null;

export function useCheckLogs(
  prId: number,
  jobId: number | null,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ['check-logs', prId, jobId],
    initialPageParam: null as LogPageParam,
    queryFn: ({ pageParam }) =>
      api.checkLogs(prId, jobId as number, pageParam ?? undefined),
    getNextPageParam: (lastPage: CheckLogsResponse): LogPageParam => {
      // "Next" means EARLIER: `hasMore` is explicitly "more log exists ABOVE this window".
      if (!lastPage.available || !lastPage.hasMore) return null;
      const end = lastPage.startByte ?? 0;
      if (end <= 0) return null;
      return { startByte: Math.max(0, end - LOG_PAGE_BYTES), endByte: end };
    },
    enabled: enabled && jobId != null,
    staleTime: Infinity, // a finished job's logs are immutable
    gcTime: 5 * 60_000,
  });
}

export interface JoinedLog {
  available: boolean;
  reason?: string;
  text: string;
  // Absolute offsets of the loaded span, and the log's full size when known.
  startByte: number | null;
  endByte: number | null;
  totalBytes: number | null;
  loadedBytes: number | null;
  lines: number;
  // The loaded span is a strict subset of the log (something is missing at either end).
  partial: boolean;
}

// Stitch the loaded pages back into one chronological block. Pages abut exactly (each
// window is line-aligned and the next request ends where the previous began), so a plain
// newline join reproduces the original run of lines with no gap or overlap.
export function joinLogPages(
  pages: CheckLogsResponse[] | undefined,
): JoinedLog | null {
  if (!pages || pages.length === 0) return null;
  const newest = pages[0] as CheckLogsResponse;
  if (!newest.available) {
    return {
      available: false,
      reason: newest.reason,
      text: '',
      startByte: null,
      endByte: null,
      totalBytes: null,
      loadedBytes: null,
      lines: 0,
      partial: false,
    };
  }
  const oldest = pages[pages.length - 1] as CheckLogsResponse;
  const text = [...pages]
    .reverse()
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n');
  const startByte = oldest.startByte;
  const endByte = newest.endByte;
  const totalBytes = newest.totalBytes;
  const loadedBytes =
    startByte != null && endByte != null ? Math.max(0, endByte - startByte) : null;
  return {
    available: true,
    text,
    startByte,
    endByte,
    totalBytes,
    loadedBytes,
    lines: text === '' ? 0 : text.split('\n').length,
    partial:
      (startByte ?? 0) > 0 ||
      (totalBytes != null && endByte != null && endByte < totalBytes),
  };
}

export function formatLogBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
