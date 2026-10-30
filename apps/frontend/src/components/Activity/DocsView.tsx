import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  REFERENCE_DOC_MAX_BYTES,
  WIKI_PROVIDER_NAMES,
  wikiScopeWords,
  wikiUnreachableWords,
  type ReferenceDoc,
  type WikiProviderId,
} from '@pierre-review/shared';
import { formatDate, relativeTime } from '../../lib/ui.js';
import { aiReadyFor, useAiCapabilities, useAiProvider, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import {
  useCancelReferenceDoc,
  useDeleteReferenceDoc,
  useRebuildReferenceDoc,
  useRefreshReferenceDoc,
  useReferenceDocTree,
  useReferenceDocs,
  useUploadReferenceDoc,
} from '../../hooks/useReferenceDocs.js';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useResizablePane } from '../../hooks/useResizablePane.js';
import { useMe } from '../../hooks/useTriage.js';
import { DOCS_CHAT_W, DOCS_LIBRARY_STRIP_W, DOCS_LIBRARY_W, docsPaneBounds } from '../../lib/docsLayout.js';
import {
  DOC_UPLOAD_ACCEPT,
  LIBRARY_INDEX_PATH,
  docStageLabel,
  docTreeBranchKeys,
  docTreeNodes,
  docTreeRows,
  docTreeTrail,
  isDocBuilding,
  slugOfLibraryPath,
  type DocTreeNode,
  uploadRefusal,
} from '../../lib/referenceDocs.js';
import { useDocsView, type DocsOpen } from '../../store/docsView.js';
import { useFilters } from '../../store/filters.js';
import { AiRunGate } from '../AiSetup.js';
import {
  BookIcon,
  ChevronIcon,
  CollapseAllIcon,
  ConfluenceIcon,
  EllipsisIcon,
  ExpandAllIcon,
  ExternalLinkIcon,
  NotionIcon,
  OctocatIcon,
  PlusIcon,
  RefreshIcon,
  SparkleIcon,
  TrashIcon,
  UploadIcon,
  WarningIcon,
} from '../Icons.js';
import { Button, IconButton, Menu, PageHeader, Tabs, cx, FOCUS_RING, useRegisterCommands, type Command, type MenuEntry } from '../ui/index.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { DocsAddWizard } from './DocsAddWizard.js';
import { InfoButton } from '../InfoModal.js';
import { DocsChat } from './DocsChat.js';
import { DocsViewer } from './DocsViewer.js';
import { aiCredentialWords, aiModelWords, aiRunLabel } from '@pierre-review/shared';

// THE DOCS RAIL LINE (Activity → Docs, `?activityRepo=docs`; docs/REFERENCE-DOCS.md § The SPA).
// The workspace's reference library: CORE, free, LOCAL ONLY. The rail entry renders only on
// `me.ai.enabled`; inside, `AiRunGate` swaps only the controls that run a model (add, rebuild, ask)
// when the runtime or the Claude credential is missing — reading the library never needs either.
//
//   left    the library: every document with its build status, each expandable into its contents
//   centre  one library file at a time (DocsViewer), every link followed in-app
//   right   the docs chat (DocsChat) — beside the viewer when wide, a second tab when narrow
//
// WIDE LAYOUT (lg+): the library can be COLLAPSED to a slim strip (its header's chevron), and the
// library | viewer | chat widths are DRAGGED on two separators (useResizablePane; ceilings from
// lib/docsLayout.ts so the viewer keeps its minimum). Both are per-browser localStorage prefs,
// never the store or the URL. Narrow: the columns stack and the Read / Ask tabs stay as they were.
//
// Build progress is live: an SSE stream per document being built — never a queued one, at most
// MAX_DOC_STREAMS (useReferenceDocs) — the list polled as the fallback.

const MUTED = 'text-ui-mute';
const DEFAULT_OPEN: DocsOpen = { path: LIBRARY_INDEX_PATH, anchor: null, quote: null, seq: 0 };
const LIBRARY_W_KEY = 'pierre:docsLibraryWidth';
const CHAT_W_KEY = 'pierre:docsChatWidth';
const LIBRARY_COLLAPSED_KEY = 'pierre:docsLibraryCollapsed';
const SEPARATOR =
  'mx-1 w-1 shrink-0 cursor-col-resize touch-none rounded-full bg-transparent transition-colors hover:bg-ui-accent focus-visible:bg-ui-accent focus-visible:outline-none';
const COLLAPSE_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10';
/** A tree row's disclosure chevron: 24px, 40px on touch. */
const TREE_TOGGLE =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10';

const KIND_LABEL: Record<ReferenceDoc['sourceKind'], string> = {
  pdf: 'PDF',
  docx: 'Word',
  text: 'Text',
  markdown: 'Markdown',
  html: 'Web page',
  url: 'Web page',
  wiki: 'Wiki',
};

/** The source words on a document's line: the wiki's own name for a wiki tree. */
const sourceLabel = (doc: ReferenceDoc): string => (doc.wiki ? WIKI_PROVIDER_NAMES[doc.wiki.provider] : KIND_LABEL[doc.sourceKind]);

/** A wiki's mark (Confluence, Notion), in the current ink. */
function WikiMark({ provider, size, className }: { provider: WikiProviderId; size: number; className?: string }): JSX.Element {
  if (provider === 'github') return <OctocatIcon size={size} className={className} aria-hidden />;
  return provider === 'notion' ? <NotionIcon size={size} className={className} aria-hidden /> : <ConfluenceIcon size={size} className={className} aria-hidden />;
}

/**
 * The figures line (docs/REFERENCE-DOCS.md § Figures): how many images Claude described, and the one
 * sentence when it could not describe them here (Codex, no sign-in). Nothing when the build met none.
 */
function FiguresLine({ doc }: { doc: ReferenceDoc }): JSX.Element | null {
  const f = doc.figures;
  if (!f || !doc.available) return null;
  const parts = [
    f.described > 0 ? `${f.described} figure${f.described === 1 ? '' : 's'} described by AI` : null,
    f.outlined > 0 ? `${f.outlined} diagram${f.outlined === 1 ? '' : 's'} read from source` : null,
    f.pending > 0 ? `${f.pending} waiting for the next refresh` : null,
  ].filter(Boolean);
  if (parts.length === 0 && !f.note) return null;
  return (
    <p className={`text-meta ${MUTED}`} data-testid="doc-figures">
      {parts.join(' · ')}
      {parts.length > 0 && f.note ? '. ' : ''}
      {f.note}
    </p>
  );
}

/**
 * A wiki document's freshness line (docs/REFERENCE-DOCS.md § Wiki sources): when Limn last asked the
 * wiki and when a page last changed, or — when the wiki cannot be reached — since when, and why. The
 * last built version stays readable either way.
 */
function WikiStatus({ doc }: { doc: ReferenceDoc }): JSX.Element | null {
  const w = doc.wiki;
  if (!w) return null;
  const name = WIKI_PROVIDER_NAMES[w.provider];
  if (w.unreachableSince && w.unreachableReason) {
    return (
      <p className="text-meta text-ui-danger" data-testid="wiki-unreachable">
        Can&rsquo;t reach {w.provider === 'github' ? 'this folder on' : 'this page in'} {name} since {formatDate(w.unreachableSince)}. {wikiUnreachableWords(w.provider, w.unreachableReason)}
      </p>
    );
  }
  const parts = [
    wikiScopeWords(w.scope, w.rootTitle),
    w.lastCheckedAt ? `Checked ${relativeTime(w.lastCheckedAt)}` : null,
    w.lastChangedAt ? `last edited ${formatDate(w.lastChangedAt)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className={`text-meta ${MUTED}`} title={w.rootUrl}>
      {parts.join(' · ')}
    </p>
  );
}

function BuildProgress({ doc }: { doc: ReferenceDoc }): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(doc.progress)));
  // The server's own words for the step ("Crawling 6 of 25", "Summarising sections (3 of 12)").
  const label = doc.stage ?? docStageLabel(doc.status);
  return (
    <div className="space-y-0.5" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-meta text-ai-signal">
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

// One document's contents, as a COLLAPSED TREE: only the top-level chapters show at first, each
// row with rows under it carries its own disclosure button (`aria-expanded`), and "Expand all" /
// "Collapse all" sit above. The open set is local to this mount — closing the document forgets it.
function DocTree({ workspaceId, doc, open, onOpen }: { workspaceId: number; doc: ReferenceDoc; open: DocsOpen; onOpen: (path: string, anchor: string | null) => void }): JSX.Element {
  const tree = useReferenceDocTree(workspaceId, doc.id, true, doc.builtAt);
  const nodes = useMemo(() => (tree.data ? docTreeNodes(docTreeRows(tree.data.sections)) : []), [tree.data]);
  const branchKeys = useMemo(() => docTreeBranchKeys(nodes), [nodes]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // REVEAL: the open file's row — its branches opened, scrolled into view, and (opened from a citation
  // outside the list) marked for a moment. Keyed on the open's `seq`, so every open reveals once.
  const trail = useMemo(() => docTreeTrail(nodes, open.path, open.anchor), [nodes, open.path, open.anchor]);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const revealedSeq = useRef<number | null>(null);
  useEffect(() => {
    if (trail == null || revealedSeq.current === open.seq) return;
    revealedSeq.current = open.seq;
    if (trail.ancestors.some((k) => !expanded.has(k))) setExpanded((prev) => new Set([...prev, ...trail.ancestors]));
    if (open.reveal) setFlash(trail.key);
  }, [trail, open.seq, open.reveal, expanded]);
  // Scrolled ONCE per open, as soon as the row is rendered (its branches open a render later) — never
  // again when the reader opens or closes another branch.
  const scrolledSeq = useRef<number | null>(null);
  useEffect(() => {
    if (trail == null || scrolledSeq.current === open.seq) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(trail.key)}"]`);
    if (!el) return;
    scrolledSeq.current = open.seq;
    el.scrollIntoView({ block: 'nearest' });
  }, [trail, open.seq, expanded]);
  useEffect(() => {
    if (flash == null) return;
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);
  if (tree.isPending) return <p className={`py-1 pl-6 text-meta ${MUTED}`}>Loading…</p>;
  if (tree.isError) return <p className="py-1 pl-6 text-meta text-ui-danger">{tree.error.message}</p>;
  if (nodes.length === 0) return <p className={`py-1 pl-6 text-meta ${MUTED}`}>No sections.</p>;
  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allOpen = branchKeys.every((k) => expanded.has(k));
  return (
    <div className="py-1">
      {branchKeys.length > 0 && (
        <div className="flex justify-end gap-0.5 px-1.5 pb-0.5" data-testid="doc-tree-controls">
          <button
            type="button"
            onClick={() => setExpanded(new Set(branchKeys))}
            disabled={allOpen}
            aria-label={`Expand all of ${doc.title}`}
            title="Expand all"
            className={`${COLLAPSE_BUTTON} disabled:opacity-40`}
          >
            <ExpandAllIcon size={13} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(new Set())}
            disabled={expanded.size === 0}
            aria-label={`Collapse all of ${doc.title}`}
            title="Collapse all"
            className={`${COLLAPSE_BUTTON} disabled:opacity-40`}
          >
            <CollapseAllIcon size={13} />
          </button>
        </div>
      )}
      <ul ref={listRef} className="space-y-px" aria-label={`Contents of ${doc.title}`} data-testid="doc-tree">
        {nodes.map((n) => (
          <DocTreeItem key={n.row.key} node={n} level={0} expanded={expanded} onToggle={toggle} open={open} onOpen={onOpen} flash={flash} />
        ))}
      </ul>
    </div>
  );
}

function DocTreeItem({
  node,
  level,
  expanded,
  onToggle,
  open,
  onOpen,
  flash,
}: {
  node: DocTreeNode;
  level: number;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  open: DocsOpen;
  onOpen: (path: string, anchor: string | null) => void;
  /** The row a citation just revealed: marked for a moment. */
  flash: string | null;
}): JSX.Element {
  const r = node.row;
  const hasChildren = node.children.length > 0;
  const isOpen = hasChildren && expanded.has(r.key);
  const indent = { paddingLeft: `${0.25 + level * 0.75}rem` };
  const anchor = r.kind === 'heading' ? r.anchor : null;
  const on = r.kind !== 'group' && open.path === r.path && open.anchor === anchor;
  const titleClass = 'block min-w-0 flex-1 py-1 text-left text-meta font-medium text-ui-mute';
  return (
    <li>
      <div
        style={indent}
        data-tree-key={r.key}
        data-revealed={flash === r.key ? 'true' : undefined}
        className={cx('flex items-center gap-0.5 rounded-ui motion-safe:transition-colors motion-safe:duration-700', flash === r.key && 'bg-ui-accent/15')}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(r.key)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${r.title}`}
            className={TREE_TOGGLE}
          >
            <ChevronIcon dir={isOpen ? 'down' : 'right'} size={10} />
          </button>
        ) : (
          <span className="w-6 shrink-0 touch:w-10" aria-hidden="true" />
        )}
        {r.kind === 'group' ? (
          hasChildren ? (
            // A heading with no text of its own: its title opens and closes it as well (the chevron
            // beside it is the keyboard control, so this one stays out of the tab order).
            <button type="button" onClick={() => onToggle(r.key)} tabIndex={-1} className={titleClass}>
              {r.title}
            </button>
          ) : (
            <span className={titleClass}>{r.title}</span>
          )
        ) : (
          <button
            type="button"
            onClick={() => onOpen(r.path, anchor)}
            aria-current={on ? 'true' : undefined}
            title={r.kind === 'section' && r.summary !== '' ? r.summary : undefined}
            className={cx('block min-w-0 flex-1 rounded-ui px-1.5 py-1 text-left touch:min-h-10', r.kind === 'heading' ? 'text-meta' : 'text-body', on ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-ink hover:bg-ui-hover', FOCUS_RING)}
          >
            {r.title}
          </button>
        )}
      </div>
      {isOpen && (
        <ul className="space-y-px">
          {node.children.map((c) => (
            <DocTreeItem key={c.row.key} node={c} level={level + 1} expanded={expanded} onToggle={onToggle} open={open} onOpen={onOpen} flash={flash} />
          ))}
        </ul>
      )}
    </li>
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
  const setExpanded = useDocsView((s) => s.setExpanded);
  const rebuild = useRebuildReferenceDoc(workspaceId);
  const refresh = useRefreshReferenceDoc(workspaceId);
  const cancel = useCancelReferenceDoc(workspaceId);
  const remove = useDeleteReferenceDoc(workspaceId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const building = isDocBuilding(doc.status);
  const contentsPath = `${doc.slug}/CONTENTS.md`;
  const onContents = open.path === contentsPath;
  // THE ROW ON SHOW: the document whose contents or a section of it is open in the viewer. Its row
  // opens up to carry the facts and the actions (docs/redesign/DESIGN.md § 1 — one line per item,
  // detail where the selection is). A row that BLOCKS (Confluence unreachable, a failed build) or is
  // building shows that line whatever is selected.
  const current = open.path.startsWith(`${doc.slug}/`);
  const failed = doc.status === 'failed';
  const unreachable = doc.wiki?.unreachableSince != null && doc.wiki.unreachableReason != null;
  const error = rebuild.error ?? refresh.error ?? cancel.error ?? remove.error;
  // Only the build's own control (Cancel), a failure's retry and the remove confirmation stay in the
  // row; Refresh, Rebuild and Remove live in the document's "…" menu.
  const showActions = failed || building || confirmRemove;
  const canBuild = aiReadyFor(ai, 'docs_build');
  const source = safeExternalUrl(doc.wiki?.rootUrl ?? doc.sourceUrl ?? null);
  const menuItems: MenuEntry[] = [
    ...(canBuild && doc.wiki && doc.available && !building
      ? [{ id: 'refresh', label: 'Refresh now', icon: <RefreshIcon size={13} />, onSelect: () => refresh.mutate(doc.id) }]
      : []),
    ...(canBuild && !building ? [{ id: 'rebuild', label: 'Rebuild', icon: <SparkleIcon size={13} />, onSelect: () => rebuild.mutate(doc.id) }] : []),
    ...(source ? [{ id: 'source', label: 'Open the source', icon: <ExternalLinkIcon size={13} />, onSelect: () => window.open(source, '_blank', 'noopener,noreferrer') }] : []),
    { separator: true as const, id: 'sep' },
    { id: 'remove', label: 'Remove…', icon: <TrashIcon size={13} />, danger: true, onSelect: () => setConfirmRemove(true) },
  ];
  const meta = [
    sourceLabel(doc),
    doc.crawl?.pages != null ? `${doc.crawl.pages.length} page${doc.crawl.pages.length === 1 ? '' : 's'}` : null,
    doc.wiki?.pageCount != null ? `${doc.wiki.pageCount} page${doc.wiki.pageCount === 1 ? '' : 's'}` : null,
    doc.available ? `${doc.sectionCount} section${doc.sectionCount === 1 ? '' : 's'}` : null,
    doc.available && doc.model ? aiRunLabel(doc.provider ?? null, doc.model) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <div className={cx('rounded-ui', current ? 'bg-ui-sel' : 'hover:bg-ui-hover')}>
        <div className="flex items-start gap-0.5 pl-1 pr-2">
          {doc.available ? (
            <button
              type="button"
              onClick={() => toggle(workspaceId, doc.id)}
              data-testid="doc-row-toggle"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} the contents of ${doc.title}`}
              className={cx(TREE_TOGGLE, 'mt-1.5')}
            >
              <ChevronIcon dir={expanded ? 'down' : 'right'} size={10} />
            </button>
          ) : (
            <span className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center text-ui-faint" aria-hidden="true">
              {doc.wiki ? <WikiMark provider={doc.wiki.provider} size={12} /> : <BookIcon size={12} />}
            </span>
          )}
          <div className="min-w-0 flex-1 py-1.5">
            {doc.available ? (
              <button
                type="button"
                // Opening a document expands its contents and closes any other (an accordion).
                onClick={() => {
                  onOpen(contentsPath, null);
                  setExpanded(workspaceId, doc.id, true);
                }}
                aria-current={onContents ? 'true' : undefined}
                aria-expanded={expanded}
                className={cx('block w-full min-w-0 truncate rounded-ui text-left text-body font-medium text-ui-ink touch:min-h-10', FOCUS_RING)}
              >
                {doc.title}
              </button>
            ) : (
              <span className="block truncate text-body font-medium text-ui-ink">{doc.title}</span>
            )}
            <p className="flex min-w-0 items-center gap-1 text-meta text-ui-mute" title={`${meta}\n${doc.sourceName}`}>
              {doc.wiki && <WikiMark provider={doc.wiki.provider} size={11} className="shrink-0" />}
              <span className="truncate">{meta}</span>
            </p>
          </div>
          {(unreachable || failed) && !building && (
            <span className="mt-2 shrink-0 text-ui-danger" title={failed ? 'The build failed' : 'Can’t reach this page'}>
              <WarningIcon size={13} aria-hidden />
            </span>
          )}
          <Menu
            label={`Actions for ${doc.title}`}
            align="end"
            items={menuItems}
            className="mt-1"
            trigger={(p) => <IconButton {...p} size="sm" label={`More actions for ${doc.title}`} icon={<EllipsisIcon size={14} />} className="mt-1 shrink-0" />}
          />
        </div>

        <div className="space-y-1.5 pb-2 pl-8 pr-2 empty:hidden">
          {!building && (unreachable || current) && <WikiStatus doc={doc} />}
          {!building && current && <FiguresLine doc={doc} />}
          {building && <BuildProgress doc={doc} />}
          {failed && (
            <p className="text-meta text-ui-danger">
              {doc.error ?? 'The build failed.'}
              {doc.available && ' The last built version is still here.'}
            </p>
          )}
          {showActions && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {building ? (
                <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(doc.id)}>
                  Cancel
                </Button>
              ) : (
                failed &&
                canBuild && (
                  <Button size="sm" disabled={rebuild.isPending} onClick={() => rebuild.mutate(doc.id)}>
                    Try again
                  </Button>
                )
              )}
              {confirmRemove && (
                <span className="inline-flex flex-wrap items-center gap-1.5 text-meta">
                  <span className="text-ui-ink">Remove this document?</span>
                  <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(doc.id)}>
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </Button>
                </span>
              )}
            </div>
          )}
          {error != null && <p className="text-meta text-ui-danger">{error.message}</p>}
        </div>
      </div>
      {expanded && doc.available && (
        <div className="pb-1 pl-3">
          <DocTree workspaceId={workspaceId} doc={doc} open={open} onOpen={onOpen} />
        </div>
      )}
    </li>
  );
}

// The drop zone and file picker. Web pages, wikis and repositories come in through the "+" (the
// add-documents wizard, DocsAddWizard.tsx).
function AddDocs({ workspaceId, maxBytes }: { workspaceId: number; maxBytes: number }): JSX.Element {
  // Codex cannot read PDF pages (the build refuses one on Codex): say so BEFORE the upload.
  const onCodex = useMe().data?.ai.provider === 'codex';
  const upload = useUploadReferenceDoc(workspaceId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ name: string; message: string }>>([]);

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
        className={cx(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-ui border border-dashed px-2.5 py-2 text-body',
          dragging ? 'border-ui-accent bg-ui-sel' : 'border-ui-line',
        )}
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
          <p className="text-ui-ink">Uploading {sending}…</p>
        ) : (
          <>
            <button
              type="button"
              data-ai-run
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <UploadIcon size={12} />
              Choose files
            </button>
            <p className={`min-w-0 flex-1 text-meta ${MUTED}`}>
              {onCodex
                ? 'or drop Word, text or markdown files here. Codex cannot read PDFs.'
                : 'or drop PDF, Word, text or markdown files here'}
            </p>
          </>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-meta text-ui-danger">
          {problems.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              {p.name}: {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocsPane({ workspaceId }: { workspaceId: number }): JSX.Element {
  const library = useReferenceDocs(workspaceId);
  const aiProvider = useAiProvider();
  const aiName = useAiProviderName();
  const open = useDocsView((s) => s.open[workspaceId]) ?? DEFAULT_OPEN;
  const openPath = useDocsView((s) => s.openPath);
  const narrowPane = useDocsView((s) => s.narrowPane);
  const ai = useAiCapabilities();
  const [adding, setAdding] = useState(false);
  const setNarrowPane = useDocsView((s) => s.setNarrowPane);
  const onOpen = useCallback(
    (path: string, anchor: string | null, quote: string | null = null) => openPath(workspaceId, path, anchor, quote),
    [openPath, workspaceId],
  );

  // A DEEP LINK (`&doc=…&section=…`, lib/docReferences.ts — a review's reference opened in a new tab):
  // opened ONCE, here, where the workspace is known; its document's contents are expanded when the
  // list arrives.
  const pending = useDocsView((s) => s.pendingDeepLink);
  const seatDeepLink = useDocsView((s) => s.seatDeepLink);
  const setExpanded = useDocsView((s) => s.setExpanded);
  const expandSlug = useRef<string | null>(null);
  useEffect(() => {
    if (pending == null) return;
    openPath(workspaceId, pending.path, pending.anchor, pending.quote, true);
    expandSlug.current = pending.slug;
    seatDeepLink(null);
  }, [pending, openPath, seatDeepLink, workspaceId]);
  useEffect(() => {
    const slug = expandSlug.current;
    if (slug == null || library.data == null) return;
    const doc = library.data.docs.find((d) => d.slug === slug);
    if (doc != null) setExpanded(workspaceId, doc.id, true);
    expandSlug.current = null;
  }, [library.data, pending, setExpanded, workspaceId]);

  // REVEAL: whatever opens a document's file (a citation, a link followed in the viewer) expands that
  // document in the list — closing any other — and its tree opens the branch (DocTree).
  const expandedIds = useDocsView((s) => s.expanded[workspaceId]);
  const revealedSeq = useRef<number | null>(null);
  useEffect(() => {
    if (library.data == null || revealedSeq.current === open.seq) return;
    revealedSeq.current = open.seq;
    const slug = slugOfLibraryPath(open.path);
    const doc = slug == null ? null : library.data.docs.find((d) => d.slug === slug && d.available);
    if (doc != null && !(expandedIds ?? []).includes(doc.id)) setExpanded(workspaceId, doc.id, true);
  }, [library.data, open.seq, open.path, expandedIds, setExpanded, workspaceId]);

  const docs = library.data?.docs ?? [];
  const sorted = [...docs].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const builtCount = docs.filter((d) => d.available).length;
  const maxBytes = library.data?.maxBytes ?? REFERENCE_DOC_MAX_BYTES;

  // Layout: which columns sit side by side (Tailwind's lg / xl), the row's measured width, and the
  // two dragged widths bounded by it. Each ceiling reads the OTHER column's width.
  const wide = useMediaQuery('(min-width: 1024px)');
  const chatBeside = useMediaQuery('(min-width: 1280px)');
  const [storedCollapsed, setCollapsed] = useLocalStorage<boolean>(LIBRARY_COLLAPSED_KEY, false);
  const collapsed = wide && storedCollapsed === true; // stacked, the list always shows in full
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowW, setRowW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el == null) return;
    const measure = (): void => setRowW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [widths, setWidths] = useState<{ lib: number; chat: number }>({ lib: DOCS_LIBRARY_W.default, chat: DOCS_CHAT_W.default });
  const bounds = docsPaneBounds({
    rowWidth: wide ? rowW : null,
    libraryWidth: collapsed ? null : widths.lib,
    chatWidth: chatBeside ? widths.chat : null,
  });
  const lib = useResizablePane({
    storageKey: LIBRARY_W_KEY,
    defaultWidth: DOCS_LIBRARY_W.default,
    minWidth: DOCS_LIBRARY_W.min,
    maxWidth: bounds.libraryMax,
    label: 'Resize the document list',
  });
  const chat = useResizablePane({
    storageKey: CHAT_W_KEY,
    defaultWidth: DOCS_CHAT_W.default,
    minWidth: DOCS_CHAT_W.min,
    maxWidth: bounds.chatMax,
    label: 'Resize the chat',
    side: 'right',
  });
  useEffect(() => {
    if (widths.lib !== lib.width || widths.chat !== chat.width) setWidths({ lib: lib.width, chat: chat.width });
  }, [lib.width, chat.width, widths]);

  // NARROW PANES (DESIGN.md § 6): below lg the library, the viewer and the chat share ONE column, one
  // at a time, picked by the header's tabs; lg–xl keeps the library beside a Read / Ask pair; xl shows
  // all three. The pane on screen is DERIVED (a stored 'library' reads as Read once the library sits
  // beside it) — never written back, so the reader's own choice survives a resize.
  const pane: 'library' | 'viewer' | 'chat' = narrowPane === 'library' && wide ? 'viewer' : narrowPane;
  const paneTabs = useMemo(
    () => [
      { id: 'library' as const, label: 'Library', count: docs.length, hidden: wide },
      { id: 'viewer' as const, label: 'Read' },
      { id: 'chat' as const, label: 'Ask' },
    ],
    [docs.length, wide],
  );

  // ⌘K: every document of this library, "Ask about these docs" and "Add a document", while Docs is open.
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'docs:ask',
        group: 'Actions',
        title: 'Ask about these docs',
        icon: <SparkleIcon size={14} />,
        keywords: ['docs', 'chat', 'question'],
        run: () => {
          setNarrowPane('chat');
          requestAnimationFrame(() => document.getElementById('docs-chat-question')?.focus());
        },
      },
      {
        id: 'docs:add',
        group: 'Actions',
        title: 'Add documents to Docs',
        icon: <PlusIcon size={14} />,
        keywords: ['upload', 'web page', 'confluence', 'notion', 'github', 'repository', 'wiki'],
        run: () => setAdding(true),
      },
      {
        id: 'docs:index',
        group: 'Go to',
        title: 'Docs: all documents',
        icon: <BookIcon size={14} />,
        run: () => onOpen(LIBRARY_INDEX_PATH, null),
      },
      ...sorted
        .filter((d) => d.available)
        .map((d) => ({
          id: `docs:open:${d.id}`,
          group: 'Go to' as const,
          title: `Docs: ${d.title}`,
          hint: sourceLabel(d),
          icon: d.wiki ? <WikiMark provider={d.wiki.provider} size={14} /> : <BookIcon size={14} />,
          run: () => onOpen(`${d.slug}/CONTENTS.md`, null),
        })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library.data, onOpen, setNarrowPane],
  );
  useRegisterCommands('docs', commands);

  const docsInfo = (
    <InfoButton title="Docs">
      <p>
        Reference material for this workspace: PDF, Word, text and markdown files, web pages, Confluence and Notion
        wikis, and the documents in a GitHub repository. Press + to add a source.
      </p>
      <p>
        {aiModelWords(aiProvider, 'Sonnet')} turns each one into markdown sections with a contents list, and the library keeps one contents
        page across every document. {aiName} reads only the sections a question needs.
      </p>
      <p>
        Ask about the docs in the chat. To have AI Review check stories against them, switch it on in Settings →
        Docs.
      </p>
      <p>Everything stays on this machine. Building a document runs on {aiCredentialWords(aiProvider)}.</p>
      <p>Drag the bars between the columns to resize them (or focus one and use the arrow keys). Double-click a bar to reset it.</p>
    </InfoButton>
  );

  return (
    <div className="flex h-full min-h-[32rem] flex-col" data-testid="docs-view">
      {adding && <DocsAddWizard workspaceId={workspaceId} onClose={() => setAdding(false)} />}
      {/* THE PAGE HEADER: the title, its ⓘ, the count — and, while the panes share a column, their tabs. */}
      <PageHeader
        inset={false}
        title="Docs"
        info={
          <>
            {docsInfo}
            {library.data != null && (
              <span className="ml-1 text-meta tabular-nums text-ui-mute">
                {docs.length} document{docs.length === 1 ? '' : 's'}
              </span>
            )}
          </>
        }
        actions={
          <Tabs
            tabs={paneTabs}
            value={pane}
            onChange={(k) => setNarrowPane(k)}
            label="Docs panes"
            className="w-full xl:hidden sm:w-auto"
          />
        }
      />

      <div ref={rowRef} className="flex min-h-0 flex-1">
        {/* LEFT: the library — or, collapsed, a slim strip with the expand control and the count */}
        {collapsed ? (
          <section
            aria-label="Library"
            style={{ width: DOCS_LIBRARY_STRIP_W }}
            className="flex shrink-0 flex-col items-center gap-2 rounded-ui bg-ui-surface py-2"
          >
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-expanded={false}
              aria-label={`Show the document list (${docs.length} document${docs.length === 1 ? '' : 's'})`}
              title="Show the document list"
              className={COLLAPSE_BUTTON}
            >
              <ChevronIcon dir="right" size={12} />
            </button>
            <span className="text-ui-faint" aria-hidden="true">
              <BookIcon size={14} />
            </span>
            <span className="text-meta tabular-nums text-ui-mute" aria-hidden="true">
              {docs.length}
            </span>
          </section>
        ) : (
          <section
            ref={lib.paneRef}
            aria-label="Library"
            style={wide ? { width: lib.width } : undefined}
            className={cx(
              'min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-ui bg-ui-surface p-2 lg:flex lg:flex-none lg:shrink-0',
              pane === 'library' ? 'flex' : 'hidden',
            )}
          >
            <div className="flex min-h-7 items-center gap-1 px-1.5 pt-1">
              <h2 className="text-body font-semibold text-ui-ink">Library</h2>
              {aiReadyFor(ai, 'docs_build') && (
                <IconButton
                  size="sm"
                  label="Add documents"
                  icon={<PlusIcon size={13} />}
                  onClick={() => setAdding(true)}
                  data-testid="docs-add"
                  className={wide ? undefined : 'ml-auto'}
                />
              )}
              {wide && (
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  aria-expanded={true}
                  aria-label="Hide the document list"
                  title="Hide the document list"
                  className={`ml-auto ${COLLAPSE_BUTTON}`}
                >
                  <ChevronIcon dir="left" size={12} />
                </button>
              )}
            </div>
            <div className="px-1.5">
              <AiRunGate kind="docs_build">
                <AddDocs workspaceId={workspaceId} maxBytes={maxBytes} />
              </AiRunGate>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {library.isPending ? (
                <p className="px-2 text-meta text-ui-mute">Loading…</p>
              ) : library.isError ? (
                <p className="px-2 text-meta text-ui-danger">{library.error.message}</p>
              ) : (
                <div className="space-y-px">
                  <button
                    type="button"
                    onClick={() => onOpen(LIBRARY_INDEX_PATH, null)}
                    aria-current={open.path === LIBRARY_INDEX_PATH ? 'true' : undefined}
                    className={cx(
                      'flex h-8 w-full items-center gap-2 rounded-ui px-2 text-left text-body font-medium touch:h-11',
                      open.path === LIBRARY_INDEX_PATH ? 'bg-ui-sel text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
                      FOCUS_RING,
                    )}
                  >
                    <BookIcon size={12} className="text-ui-mute" />
                    <span className="flex-1">All documents</span>
                    <span className="text-meta tabular-nums text-ui-mute">{docs.length}</span>
                  </button>
                  {sorted.length === 0 ? (
                    <p className="px-2 py-2 text-meta text-ui-mute">No documents yet.</p>
                  ) : (
                    <ul className="space-y-px">
                      {sorted.map((d) => (
                        <DocRow key={d.id} workspaceId={workspaceId} doc={d} open={open} onOpen={onOpen} />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
        {wide && !collapsed && <div {...lib.separatorProps} className={SEPARATOR} />}

        {/* CENTRE + RIGHT: side by side at xl; one at a time, by the header's tabs, below. */}
        <div className={cx('min-h-0 min-w-0 flex-1 lg:flex', pane === 'library' ? 'hidden' : 'flex')}>
          <div className={cx('min-h-0 min-w-0 flex-1', pane === 'viewer' ? 'flex' : 'hidden xl:flex')}>
            <DocsViewer workspaceId={workspaceId} open={open} hasDocs={builtCount > 0} onOpen={onOpen} />
          </div>
          {chatBeside && <div {...chat.separatorProps} className={SEPARATOR} />}
          <div
            ref={chat.paneRef}
            style={chatBeside ? { width: chat.width } : undefined}
            className={cx('min-h-0 min-w-0 flex-1 xl:flex-none', pane === 'chat' ? 'flex' : 'hidden xl:flex')}
          >
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
      <p className={`px-6 py-10 text-center text-body ${MUTED}`}>
        Reference docs need AI, which is switched off here.
      </p>
    );
  }
  if (workspaceId == null) return <p className={`text-body ${MUTED}`}>Loading…</p>;
  return <DocsPane workspaceId={workspaceId} />;
}
