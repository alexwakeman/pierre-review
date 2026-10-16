import { useCallback, useRef, useState, type DragEvent } from 'react';
import { REFERENCE_DOC_MAX_BYTES, type ReferenceDoc } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import {
  useAddReferenceDocUrl,
  useCancelReferenceDoc,
  useDeleteReferenceDoc,
  useRebuildReferenceDoc,
  useReferenceDocTree,
  useReferenceDocs,
  useUploadReferenceDoc,
} from '../../hooks/useReferenceDocs.js';
import { useMe } from '../../hooks/useTriage.js';
import {
  DOC_UPLOAD_ACCEPT,
  LIBRARY_INDEX_PATH,
  docStageLabel,
  docTreeRows,
  isDocBuilding,
  uploadRefusal,
} from '../../lib/referenceDocs.js';
import { useDocsView, type DocsOpen } from '../../store/docsView.js';
import { useFilters } from '../../store/filters.js';
import { AiRunGate } from '../AiSetup.js';
import { BookIcon, ChevronIcon, UploadIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { DocsChat } from './DocsChat.js';
import { DocsViewer } from './DocsViewer.js';

// THE DOCS RAIL LINE (Activity → Docs, `?activityRepo=docs`; docs/REFERENCE-DOCS.md § The SPA).
// The workspace's reference library: CORE, free, LOCAL ONLY. The rail entry renders only on
// `me.ai.enabled`; inside, `AiRunGate` swaps only the controls that run a model (add, rebuild, ask)
// when the runtime or the Claude credential is missing — reading the library never needs either.
//
//   left    the library: every document with its build status, each expandable into its contents
//   centre  one library file at a time (DocsViewer), every link followed in-app
//   right   the docs chat (DocsChat) — beside the viewer when wide, a second tab when narrow
//
// Build progress is live: one SSE stream per building document (useReferenceDocs), the list polled
// as the fallback.

const MUTED = 'text-gray-500 dark:text-gray-400';
const SMALL_BUTTON = 'text-xs text-sky-700 hover:underline disabled:opacity-50 dark:text-sky-300';
const DEFAULT_OPEN: DocsOpen = { path: LIBRARY_INDEX_PATH, anchor: null, seq: 0 };

const KIND_LABEL: Record<ReferenceDoc['sourceKind'], string> = {
  pdf: 'PDF',
  docx: 'Word',
  text: 'Text',
  markdown: 'Markdown',
  html: 'Web page',
  url: 'Web page',
};

function BuildProgress({ doc }: { doc: ReferenceDoc }): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(doc.progress)));
  const label = docStageLabel(doc.status);
  return (
    <div className="space-y-0.5" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ai-signal">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-ai-signal-fill/15"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Building ${doc.title}: ${label}`}
      >
        <div className="h-full rounded-full bg-ai-signal-fill transition-[width] duration-300 ease-out" style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
    </div>
  );
}

function DocTree({ workspaceId, doc, open, onOpen }: { workspaceId: number; doc: ReferenceDoc; open: DocsOpen; onOpen: (path: string, anchor: string | null) => void }): JSX.Element {
  const tree = useReferenceDocTree(workspaceId, doc.id, true, doc.builtAt);
  if (tree.isPending) return <p className={`py-1 pl-6 text-[11px] ${MUTED}`}>Loading…</p>;
  if (tree.isError) return <p className="py-1 pl-6 text-[11px] text-rose-700 dark:text-rose-400">{tree.error.message}</p>;
  const rows = docTreeRows(tree.data.sections);
  if (rows.length === 0) return <p className={`py-1 pl-6 text-[11px] ${MUTED}`}>No sections.</p>;
  return (
    <ul className="space-y-px py-1" aria-label={`Contents of ${doc.title}`}>
      {rows.map((r) => {
        const indent = { paddingLeft: `${0.75 + r.depth * 0.75}rem` };
        if (r.kind === 'group') {
          return (
            <li key={r.key} style={indent} className="py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-200">
              {r.title}
            </li>
          );
        }
        const anchor = r.kind === 'heading' ? r.anchor : null;
        const on = open.path === r.path && open.anchor === anchor;
        return (
          <li key={r.key} style={indent}>
            <button
              type="button"
              onClick={() => onOpen(r.path, anchor)}
              aria-current={on ? 'true' : undefined}
              title={r.kind === 'section' && r.summary !== '' ? r.summary : undefined}
              className={`block w-full rounded px-1 py-0.5 text-left text-xs ${
                on ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-200' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800/50'
              } ${r.kind === 'heading' ? 'text-[11px] text-gray-600 dark:text-gray-300' : ''}`}
            >
              {r.title}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DocRow({
  workspaceId,
  doc,
  open,
  onOpen,
}: {
  workspaceId: number;
  doc: ReferenceDoc;
  open: DocsOpen;
  onOpen: (path: string, anchor: string | null) => void;
}): JSX.Element {
  const ai = useAiCapabilities();
  const expanded = useDocsView((s) => (s.expanded[workspaceId] ?? []).includes(doc.id));
  const toggle = useDocsView((s) => s.toggleExpanded);
  const rebuild = useRebuildReferenceDoc(workspaceId);
  const cancel = useCancelReferenceDoc(workspaceId);
  const remove = useDeleteReferenceDoc(workspaceId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const building = isDocBuilding(doc.status);
  const contentsPath = `${doc.slug}/CONTENTS.md`;
  const onContents = open.path === contentsPath;
  const error = rebuild.error ?? cancel.error ?? remove.error;

  return (
    <li className="rounded border border-gray-200 dark:border-gray-800">
      <div className="space-y-1 px-2 py-1.5">
        <div className="flex items-start gap-1">
          {doc.available ? (
            <button
              type="button"
              onClick={() => toggle(workspaceId, doc.id)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} the contents of ${doc.title}`}
              className="mt-0.5 shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            >
              <ChevronIcon dir={expanded ? 'down' : 'right'} size={11} />
            </button>
          ) : (
            <span className="mt-0.5 shrink-0 p-0.5 text-gray-500 dark:text-gray-400">
              <BookIcon size={11} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {doc.available ? (
              <button
                type="button"
                onClick={() => onOpen(contentsPath, null)}
                aria-current={onContents ? 'true' : undefined}
                className={`block text-left text-xs font-semibold hover:underline ${onContents ? 'text-sky-800 dark:text-sky-200' : 'text-gray-800 dark:text-gray-100'}`}
              >
                {doc.title}
              </button>
            ) : (
              <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100">{doc.title}</span>
            )}
            <p className={`truncate text-[11px] ${MUTED}`} title={doc.sourceName}>
              {KIND_LABEL[doc.sourceKind]}
              {doc.available && ` · ${doc.sectionCount} section${doc.sectionCount === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        {building && <BuildProgress doc={doc} />}
        {doc.status === 'failed' && (
          <p className="text-[11px] text-rose-700 dark:text-rose-400">
            {doc.error ?? 'The build failed.'}
            {doc.available && ' The last built version is still here.'}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {building ? (
            <button type="button" className={SMALL_BUTTON} disabled={cancel.isPending} onClick={() => cancel.mutate(doc.id)}>
              Cancel
            </button>
          ) : (
            ai.ready && (
              <button type="button" className={SMALL_BUTTON} disabled={rebuild.isPending} onClick={() => rebuild.mutate(doc.id)}>
                {doc.status === 'failed' ? 'Try again' : 'Rebuild'}
              </button>
            )
          )}
          {confirmRemove ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs">
              <span className="text-gray-700 dark:text-gray-200">Remove this document?</span>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(doc.id)}
                className="font-medium text-rose-700 hover:underline disabled:opacity-50 dark:text-rose-400"
              >
                Remove
              </button>
              <button type="button" className={SMALL_BUTTON} onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className={SMALL_BUTTON} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </div>
        {error != null && <p className="text-[11px] text-rose-700 dark:text-rose-400">{error.message}</p>}
      </div>
      {expanded && doc.available && (
        <div className="border-t border-gray-100 dark:border-gray-800">
          <DocTree workspaceId={workspaceId} doc={doc} open={open} onOpen={onOpen} />
        </div>
      )}
    </li>
  );
}

function AddDocs({ workspaceId, maxBytes }: { workspaceId: number; maxBytes: number }): JSX.Element {
  const upload = useUploadReferenceDoc(workspaceId);
  const addUrl = useAddReferenceDocUrl(workspaceId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ name: string; message: string }>>([]);
  const [url, setUrl] = useState('');

  const send = async (files: File[]): Promise<void> => {
    const found: Array<{ name: string; message: string }> = [];
    for (const f of files) {
      const refusal = uploadRefusal(f.name, f.size, maxBytes);
      if (refusal != null) {
        found.push({ name: f.name, message: refusal });
        continue;
      }
      setSending(f.name);
      try {
        await upload.mutateAsync(f);
      } catch (err) {
        found.push({ name: f.name, message: err instanceof Error ? err.message : 'The upload failed.' });
      }
    }
    setSending(null);
    setProblems(found);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0 && sending == null) void send(files);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="docs-drop-zone"
        className={`rounded-lg border border-dashed px-3 py-3 text-center text-xs ${
          dragging ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30' : 'border-gray-300 dark:border-gray-700'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={DOC_UPLOAD_ACCEPT}
          className="hidden"
          aria-label="Choose files to add"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void send(files);
          }}
        />
        {sending != null ? (
          <p className="text-gray-700 dark:text-gray-200">Uploading {sending}…</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 font-medium text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
            >
              <UploadIcon size={12} />
              Choose files
            </button>
            <p className={`mt-1 text-[11px] ${MUTED}`}>or drop PDF, Word, text or markdown files here</p>
          </>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-rose-700 dark:text-rose-400">
          {problems.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              {p.name}: {p.message}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const u = url.trim();
          if (u === '' || addUrl.isPending) return;
          addUrl.mutate(u, { onSuccess: () => setUrl('') });
        }}
      >
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Web page address"
          placeholder="https://…"
          maxLength={2048}
          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
        <button
          type="submit"
          disabled={addUrl.isPending || url.trim() === ''}
          className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          Add web page
        </button>
      </form>
      {addUrl.isError && <p className="text-[11px] text-rose-700 dark:text-rose-400">{addUrl.error.message}</p>}
    </div>
  );
}

function DocsPane({ workspaceId }: { workspaceId: number }): JSX.Element {
  const library = useReferenceDocs(workspaceId);
  const open = useDocsView((s) => s.open[workspaceId]) ?? DEFAULT_OPEN;
  const openPath = useDocsView((s) => s.openPath);
  const narrowPane = useDocsView((s) => s.narrowPane);
  const setNarrowPane = useDocsView((s) => s.setNarrowPane);
  const onOpen = useCallback((path: string, anchor: string | null) => openPath(workspaceId, path, anchor), [openPath, workspaceId]);

  const docs = library.data?.docs ?? [];
  const sorted = [...docs].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const builtCount = docs.filter((d) => d.available).length;
  const maxBytes = library.data?.maxBytes ?? REFERENCE_DOC_MAX_BYTES;

  return (
    <div className="flex h-full min-h-[32rem] flex-col gap-3 lg:flex-row" data-testid="docs-view">
      {/* LEFT: the library */}
      <section aria-label="Library" className="flex min-h-0 flex-col gap-3 lg:w-72 lg:shrink-0">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Docs</h2>
          <InfoButton title="Docs">
            <p>Reference material for this workspace: PDF, Word, text and markdown files, and web pages.</p>
            <p>
              Claude Sonnet turns each one into markdown sections with a contents list, and the library keeps one contents
              page across every document. Claude reads only the sections a question needs.
            </p>
            <p>
              Ask about the docs in the chat. To have Claude Review check stories against them, switch it on in Settings →
              Workspace.
            </p>
            <p>Everything stays on this machine. Building a document runs on your own Claude Code or Anthropic API key.</p>
          </InfoButton>
        </div>
        <AiRunGate>
          <AddDocs workspaceId={workspaceId} maxBytes={maxBytes} />
        </AiRunGate>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {library.isPending ? (
            <p className={`text-xs ${MUTED}`}>Loading…</p>
          ) : library.isError ? (
            <p className="text-xs text-rose-700 dark:text-rose-400">{library.error.message}</p>
          ) : (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => onOpen(LIBRARY_INDEX_PATH, null)}
                aria-current={open.path === LIBRARY_INDEX_PATH ? 'true' : undefined}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs font-semibold ${
                  open.path === LIBRARY_INDEX_PATH
                    ? 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800/50'
                }`}
              >
                <BookIcon size={12} />
                <span className="flex-1">All documents</span>
                <span className="font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">{docs.length}</span>
              </button>
              {sorted.length === 0 ? (
                <p className={`px-2 text-xs ${MUTED}`}>No documents yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {sorted.map((d) => (
                    <DocRow key={d.id} workspaceId={workspaceId} doc={d} open={open} onOpen={onOpen} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      {/* CENTRE + RIGHT: side by side when wide; one at a time, by tab, when narrow */}
      <div className="flex min-h-[28rem] min-w-0 flex-1 flex-col gap-2 lg:min-h-0">
        <div role="tablist" className="flex gap-1 border-b border-gray-200 xl:hidden dark:border-gray-800">
          {(['viewer', 'chat'] as const).map((k) => {
            const on = narrowPane === k;
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setNarrowPane(k)}
                className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                  on
                    ? 'border-gray-300 bg-white text-sky-600 dark:border-gray-700 dark:bg-gray-950 dark:text-sky-300'
                    : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
                }`}
              >
                {k === 'viewer' ? 'Read' : 'Ask'}
              </button>
            );
          })}
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <div className={`min-h-0 min-w-0 flex-1 ${narrowPane === 'viewer' ? 'flex' : 'hidden xl:flex'}`}>
            <DocsViewer workspaceId={workspaceId} open={open} hasDocs={builtCount > 0} onOpen={onOpen} />
          </div>
          <div className={`min-h-0 min-w-0 flex-1 xl:flex-none ${narrowPane === 'chat' ? 'flex' : 'hidden xl:flex'}`}>
            <DocsChat workspaceId={workspaceId} canAsk={builtCount > 0} onOpen={onOpen} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocsView(): JSX.Element | null {
  const me = useMe();
  const ai = useAiCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  if (me.data == null) return null;
  if (!ai.enabled) {
    return (
      <p className={`px-6 py-10 text-center text-sm ${MUTED}`}>
        {ai.cloud ? 'Reference docs run on your machine: npx limn-review' : 'Reference docs need Claude, which is switched off here.'}
      </p>
    );
  }
  if (workspaceId == null) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  return <DocsPane workspaceId={workspaceId} />;
}
