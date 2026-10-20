import { useEffect, useRef, useState } from 'react';
import {
  skipToken,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ReferenceDoc,
  ReferenceDocMutationResponse,
  ReferenceDocStreamEvent,
  ReferenceDocsChatBody,
  ReferenceDocsChatResponse,
  ReferenceDocsConversationResponse,
  ReferenceDocsResponse,
  ReferenceDocsSettings,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { docsListPollMs, docsToStream, isDocBuilding } from '../lib/referenceDocs.js';
import { useDocsView } from '../store/docsView.js';

// ACTIVITY → DOCS, the server half (docs/REFERENCE-DOCS.md § The SPA). Every key carries the
// workspace id; none of these is persisted (main.tsx's dehydrate allowlist does not name them).

export const referenceDocsKey = (workspaceId: number | null) => ['reference-docs', workspaceId] as const;
const treeKey = (workspaceId: number | null, docId: number | null) => ['reference-docs-tree', workspaceId, docId] as const;
const sectionKey = (workspaceId: number | null, path: string | null) => ['reference-docs-section', workspaceId, path] as const;
const conversationsKey = (workspaceId: number | null) => ['reference-docs-chats', workspaceId] as const;
export const docsConversationKey = (workspaceId: number, conversationId: string) =>
  ['reference-docs-chat', workspaceId, conversationId] as const;
const settingsKey = (workspaceId: number | null) => ['reference-docs-settings', workspaceId] as const;
// ⚠ ONE MUTATION KEY PER WORKSPACE, shared by every mount: the server answers one question per
// account at a time, and a per-mount `isPending` resets on a tab switch mid-answer (a second BILLED POST).
export const docsChatAskKey = (workspaceId: number) => ['reference-docs-chat-ask', workspaceId] as const;

/** Re-read everything a build or a removal can change. */
function invalidateLibrary(qc: QueryClient, workspaceId: number): void {
  void qc.invalidateQueries({ queryKey: referenceDocsKey(workspaceId) });
  void qc.invalidateQueries({ queryKey: ['reference-docs-tree', workspaceId] });
  void qc.invalidateQueries({ queryKey: ['reference-docs-section', workspaceId] });
}

function patchDoc(qc: QueryClient, workspaceId: number, docId: number, patch: Partial<ReferenceDoc>): void {
  qc.setQueryData<ReferenceDocsResponse>(referenceDocsKey(workspaceId), (prev) =>
    prev ? { ...prev, docs: prev.docs.map((d) => (d.id === docId ? { ...d, ...patch } : d)) } : prev,
  );
}

/**
 * The library list, with LIVE build progress: an SSE stream per document the server is ACTUALLY
 * building (`GET /api/docs/:id/stream`, never a `queued` one, at most `MAX_DOC_STREAMS`) patches its
 * row in place, and the list is polled as the fallback (`docsListPollMs`).
 * ⚠ TROUBLE IS PER DOCUMENT: a stream that fails or ends without `done` puts ITS id in `trouble`
 * (the list then polls every 3s for it) and the id leaves the set when the document stops building —
 * one shared flag let a later healthy stream clear an earlier failure, or one failure keep fast
 * polling on for every later build.
 */
export function useReferenceDocs(workspaceId: number | null) {
  const qc = useQueryClient();
  const [trouble, setTrouble] = useState<ReadonlySet<number>>(() => new Set());
  const query = useQuery<ReferenceDocsResponse>({
    queryKey: referenceDocsKey(workspaceId),
    queryFn: workspaceId != null ? () => api.referenceDocs(workspaceId) : skipToken,
    refetchInterval: (q) => docsListPollMs(q.state.data?.docs ?? [], trouble),
  });

  const docs = query.data?.docs ?? [];
  const buildingKey = docs
    .filter((d) => isDocBuilding(d.status))
    .map((d) => d.id)
    .join(',');
  const streamKey = docsToStream(docs, trouble).join(',');
  const streams = useRef(new Map<number, AbortController>());

  // An id leaves `trouble` once its document is no longer building (ready, failed, removed).
  useEffect(() => {
    const ids = new Set(buildingKey === '' ? [] : buildingKey.split(',').map(Number));
    setTrouble((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [buildingKey]);

  useEffect(() => {
    if (workspaceId == null) return;
    const ids = streamKey === '' ? [] : streamKey.split(',').map(Number);
    const open = streams.current;
    for (const [id, ctl] of open) {
      if (!ids.includes(id)) {
        ctl.abort();
        open.delete(id);
      }
    }
    const markTrouble = (id: number): void =>
      setTrouble((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
    for (const id of ids) {
      if (open.has(id)) continue;
      const ctl = new AbortController();
      open.set(id, ctl);
      let sawDone = false;
      void sseStream<ReferenceDocStreamEvent>(`/api/docs/${id}/stream`, {
        signal: ctl.signal,
        onEvent: (e) => {
          if (e.type === 'done') {
            sawDone = true;
            patchDoc(qc, workspaceId, id, { status: e.status, error: e.error, progress: e.status === 'ready' ? 100 : 0, stage: null });
            invalidateLibrary(qc, workspaceId);
          } else {
            patchDoc(qc, workspaceId, id, { status: e.status, progress: e.progress, stage: e.stage });
          }
        },
      })
        // A stream that ends with no `done` (a restart, a dropped socket) hands THIS document over to
        // fast polling.
        .then(() => {
          if (!sawDone && !ctl.signal.aborted) markTrouble(id);
        })
        .catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === 'AbortError') && !ctl.signal.aborted) markTrouble(id);
        })
        .finally(() => {
          if (open.get(id) === ctl) open.delete(id);
        });
    }
  }, [streamKey, workspaceId, qc]);

  // Close every stream when the pane goes away (or the workspace changes).
  useEffect(() => {
    const open = streams.current;
    return () => {
      for (const ctl of open.values()) ctl.abort();
      open.clear();
    };
  }, [workspaceId]);

  return query;
}

/** One document's contents tree. Fetched only while it is expanded. */
export function useReferenceDocTree(workspaceId: number | null, docId: number, enabled: boolean, builtAt: string | null) {
  return useQuery({
    // `builtAt` in the key: a rebuild that lands shows its new tree at once.
    queryKey: [...treeKey(workspaceId, docId), builtAt],
    queryFn: enabled && workspaceId != null ? () => api.referenceDocTree(workspaceId, docId) : skipToken,
    staleTime: 60_000,
  });
}

/** One library file (INDEX.md, a CONTENTS.md or a section). */
export function useReferenceDocSection(workspaceId: number | null, path: string | null) {
  return useQuery({
    queryKey: sectionKey(workspaceId, path),
    queryFn: workspaceId != null && path != null ? () => api.referenceDocSection(workspaceId, path) : skipToken,
    staleTime: 60_000,
    retry: false,
  });
}

function useLibraryMutation<V>(workspaceId: number | null, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, V>({
    mutationFn: fn,
    onSuccess: (data) => {
      if (workspaceId == null) return;
      // Seat the new / requeued row at once, so its progress bar (and its stream) start now.
      const doc = (data as Partial<ReferenceDocMutationResponse> | undefined)?.doc;
      if (doc != null) {
        qc.setQueryData<ReferenceDocsResponse>(referenceDocsKey(workspaceId), (prev) =>
          prev
            ? {
                ...prev,
                docs: prev.docs.some((d) => d.id === doc.id)
                  ? prev.docs.map((d) => (d.id === doc.id ? doc : d))
                  : [...prev.docs, doc],
              }
            : prev,
        );
      }
      invalidateLibrary(qc, workspaceId);
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

export function useUploadReferenceDoc(workspaceId: number | null) {
  return useLibraryMutation(workspaceId, (file: File) => api.uploadReferenceDoc(workspaceId!, file));
}
export function useAddReferenceDocUrl(workspaceId: number | null) {
  return useLibraryMutation(workspaceId, (v: { url: string; crawlDepth: number | null }) =>
    api.addReferenceDocUrl(workspaceId!, v.url, v.crawlDepth),
  );
}
export function useRebuildReferenceDoc(workspaceId: number | null) {
  return useLibraryMutation(workspaceId, (docId: number) => api.rebuildReferenceDoc(docId));
}
export function useCancelReferenceDoc(workspaceId: number | null) {
  return useLibraryMutation(workspaceId, (docId: number) => api.cancelReferenceDoc(docId));
}
export function useDeleteReferenceDoc(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: (docId) => api.deleteReferenceDoc(docId),
    onSuccess: (_d, docId) => {
      if (workspaceId == null) return;
      qc.setQueryData<ReferenceDocsResponse>(referenceDocsKey(workspaceId), (prev) =>
        prev ? { ...prev, docs: prev.docs.filter((d) => d.id !== docId) } : prev,
      );
      useDocsView.getState().setExpanded(workspaceId, docId, false);
      invalidateLibrary(qc, workspaceId);
    },
  });
}

// ---- the chat ----

export function useDocsConversations(workspaceId: number | null) {
  return useQuery({
    queryKey: conversationsKey(workspaceId),
    queryFn: workspaceId != null ? () => api.referenceDocsConversations(workspaceId) : skipToken,
    staleTime: 30_000,
  });
}

export function useDocsConversation(workspaceId: number | null, conversationId: string | null) {
  return useQuery<ReferenceDocsConversationResponse>({
    queryKey: workspaceId != null && conversationId != null ? docsConversationKey(workspaceId, conversationId) : ['reference-docs-chat', 'none'],
    queryFn: workspaceId != null && conversationId != null ? () => api.referenceDocsConversation(workspaceId, conversationId) : skipToken,
    staleTime: 60_000,
    retry: false,
  });
}

export function useDocsChatBusy(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: workspaceId != null ? docsChatAskKey(workspaceId) : ['reference-docs-chat-ask', 'none'] }) > 0;
}

/** The question being answered in `conversationId` (null = a new conversation), if any. */
export function useDocsChatPendingQuestion(workspaceId: number | null, conversationId: string | null): string | null {
  const pending = useMutationState({
    filters: { mutationKey: workspaceId != null ? docsChatAskKey(workspaceId) : ['reference-docs-chat-ask', 'none'], status: 'pending' },
    select: (m) => m.state.variables as ReferenceDocsChatBody | undefined,
  });
  const mine = pending.find((v) => (v?.conversationId ?? null) === conversationId);
  return mine?.question ?? null;
}

/**
 * Ask one question. ⚠ THE COMPLETED TURN IS WRITTEN INTO THE CACHE HERE, AT THE HOOK LEVEL — never
 * in a mutate() callback, which dies with its observer when the pane closes mid-answer and would
 * lose an answer that was already billed and stored. A NEW conversation's id is seated here too
 * (only while the reader is still on "new"), so the answer is on screen when they come back.
 */
export function useAskDocs(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<ReferenceDocsChatResponse, Error, ReferenceDocsChatBody>({
    mutationKey: workspaceId != null ? docsChatAskKey(workspaceId) : ['reference-docs-chat-ask', 'none'],
    mutationFn: (body) => api.askReferenceDocs({ ...body, workspaceId: workspaceId ?? undefined }),
    onSuccess: (data, variables) => {
      const key = docsConversationKey(data.workspaceId, data.conversationId);
      qc.setQueryData<ReferenceDocsConversationResponse>(key, (prev) => {
        const fresh = [data.question, data.answer];
        return prev
          ? { ...prev, messages: [...prev.messages.filter((m) => !fresh.some((n) => n.id === m.id)), ...fresh] }
          : { workspaceId: data.workspaceId, conversationId: data.conversationId, messages: fresh };
      });
      if ((variables.conversationId ?? null) == null) {
        const view = useDocsView.getState();
        if ((view.conversation[data.workspaceId] ?? null) == null) view.setConversation(data.workspaceId, data.conversationId);
      }
      void qc.invalidateQueries({ queryKey: conversationsKey(data.workspaceId) });
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

export function useDeleteDocsConversation(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (conversationId) => api.deleteReferenceDocsConversation(workspaceId!, conversationId),
    onSuccess: (_d, conversationId) => {
      if (workspaceId == null) return;
      qc.removeQueries({ queryKey: docsConversationKey(workspaceId, conversationId) });
      const view = useDocsView.getState();
      if (view.conversation[workspaceId] === conversationId) view.setConversation(workspaceId, null);
      void qc.invalidateQueries({ queryKey: conversationsKey(workspaceId) });
    },
  });
}

// ---- Settings → Workspace: "Use reference docs in Claude Review" ----

export function useReferenceDocsSettings(workspaceId: number | null) {
  return useQuery<ReferenceDocsSettings>({
    queryKey: settingsKey(workspaceId),
    queryFn: workspaceId != null ? () => api.referenceDocsSettings(workspaceId) : skipToken,
  });
}

export function useSetReferenceDocsSettings(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<ReferenceDocsSettings, Error, boolean>({
    mutationFn: (docsInReview) => api.setReferenceDocsSettings(workspaceId!, docsInReview),
    onSuccess: (resp) => {
      qc.setQueryData(settingsKey(resp.workspaceId), resp);
      qc.setQueryData<ReferenceDocsResponse>(referenceDocsKey(resp.workspaceId), (prev) =>
        prev ? { ...prev, docsInReview: resp.docsInReview } : prev,
      );
    },
  });
}
