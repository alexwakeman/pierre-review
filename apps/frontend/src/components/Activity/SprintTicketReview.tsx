import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  STORY_ISSUE_BY_ID,
  STORY_RULE_BY_ID,
  sprintCurrentAssessmentBodyOf,
  storyBlockerPhrase,
  type SprintFinding,
  type SprintTicketRow,
  type StoryBlocker,
} from '@pierre-review/shared';
import { sprintFindingMarkdown } from '../../lib/copy.js';
import { rehypeSoftBreaks, rehypeStoryHighlights, storyAnchors, type StoryAnchor } from '../../lib/storyHighlights.js';
import {
  applyAllSuggestions,
  fieldEditable,
  findQuoteInMarkdown,
  findingDraftField,
  rehypeRevisions,
  revisionMarkdown,
  type ApplyAllFinding,
  type ApplyAllProposal,
  type DraftField,
} from '../../lib/ticketDraft.js';
import { rehypeTicketLinks, type TicketLinkOptions } from '../../lib/ticketLinks.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { wordDiff } from '../../lib/wordDiff.js';
import { ChevronIcon, EyeIcon, PencilIcon, SparkleIcon, UndoIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Markdown, type RehypePlugins } from '../Markdown.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { DiffText } from './SprintDiffText.js';
import { SprintDraftBar, SprintProposals } from './SprintUpdatePanel.js';
import {
  STORY_ISSUE_PILL_CLASS,
  findingSnippet,
  groupSprintFindings,
  proposedCriteriaDraft,
  sprintCriteriaShown,
  sprintFindingBlock,
  sprintTicketLinkOptions,
} from './sprintModel.js';
import { useTicketDraft, type TicketDraftApi } from './useTicketDraft.js';

// THE OPENED TICKET, REVIEWED LIKE A PULL REQUEST — AND EDITED BEFORE IT IS SENT (Reports → This sprint).
//
//   TOP    the draft bar (`SprintDraftBar`): the ONE "Update in <tracker>" (enabled when the draft
//          differs), Discard, and the confirm dialog that writes each changed field.
//   LEFT   the DRAFT of the ticket's text (`useTicketDraft`; it starts as the ticket's own): the
//          description, then its criteria when they live in a field of their own (editable) or apart
//          from the description (read-only — `sprintCriteriaShown`, never shown twice). Preview renders
//          Markdown with every anchored finding's quote as a yellow mark (`lib/storyHighlights.ts`) and
//          every word the draft added as a dashed-yellow revision (`lib/ticketDraft.ts`); Edit swaps a
//          field for a plain Markdown textarea. A field cut on the wire is not editable.
//   RIGHT  "Apply all suggestions" (one undoable step: proposals, then every quote still in the text),
//          then every finding (in the text / replaced / not in the text). A
//          selected finding is a thread: Original (the quote), Suggested (a word diff), the detail, what
//          it waits on, and Replace — which swaps that occurrence in the draft, in place.
//   BELOW  the proposals of a current run (`SprintProposals`), each with "Apply to draft".
//
// ⚠ A finding is "in the text" only when a mark for it is IN THE DOM — read after render, never assumed
//   from `quote` — or, for a field being edited, when its quote is found in that field's Markdown.
// ⚠ NOTHING IS WRITTEN FROM HERE: Replace, Edit and Apply change the draft only. The tracker is written
//   by the dialog's Confirm alone.

const MUTED = 'text-gray-500 dark:text-gray-400';

type Block = 'title' | 'description' | 'criteria';

export function ClaudeMark(): JSX.Element {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[11px] text-ai-ink">
      <SparkleIcon size={10} className="text-ai-signal" />
      Claude
    </span>
  );
}

export function IssuePill({ finding }: { finding: Pick<SprintFinding, 'issue'> }): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${STORY_ISSUE_PILL_CLASS[finding.issue]}`}
    >
      {STORY_ISSUE_BY_ID[finding.issue].label}
    </span>
  );
}

/** Escapes Markdown so a title renders as its own characters. */
function plainMarkdown(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, '\\$1');
}

function useHighlightPlugins(anchors: StoryAnchor[], revisions: boolean, links: TicketLinkOptions | null = null): RehypePlugins {
  const sig = anchors.map((a) => `${a.key}=${a.ids.join(',')}:${a.quote}`).join('\n');
  const linkSig =
    links == null ? '' : `${links.site.root}|${links.selfKey}|${links.related.map((r) => `${r.key}:${r.title ?? ''}`).join(',')}`;
  return useMemo(
    () =>
      [
        ...(revisions ? [rehypeRevisions] : []),
        rehypeSoftBreaks,
        [rehypeStoryHighlights, { anchors }],
        // Last: ticket links split text nodes, which must not disturb the highlights' matching.
        ...(links != null ? [[rehypeTicketLinks, links] as const] : []),
      ] as RehypePlugins,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, revisions, linkSig],
  );
}

export function SprintTicketReview({ ticket: t, workspaceId }: { ticket: SprintTicketRow; workspaceId: number }): JSX.Element {
  const d = useTicketDraft(t, workspaceId);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [anchored, setAnchored] = useState<string>('');
  const [hover, setHover] = useState<{
    ids: string[];
    top: number;
    left: number;
  } | null>(null);
  const [editing, setEditing] = useState<Record<DraftField, boolean>>({
    description: false,
    criteria: false,
  });
  const textRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const criteriaEditable = d.draft.text.criteria != null;
  // Criteria shown apart from the description, read-only (no field of their own to edit).
  const criteriaReadOnly = criteriaEditable ? null : sprintCriteriaShown(t);
  const criteriaApart = criteriaEditable || criteriaReadOnly != null;

  const byBlock = useMemo(() => {
    const out: Record<Block, StoryAnchor[]> = {
      title: [],
      description: [],
      criteria: [],
    };
    for (const b of ['title', 'description', 'criteria'] as const) {
      out[b] = storyAnchors(t.findings.filter((f) => sprintFindingBlock(f, criteriaApart) === b)).map((a) => ({
        ...a,
        key: `${b[0]}${a.key}`,
      }));
    }
    return out;
  }, [t.findings, criteriaApart]);
  const links = useMemo(() => sprintTicketLinkOptions(t), [t]);
  const titlePlugins = useHighlightPlugins(byBlock.title, false);
  const descriptionPlugins = useHighlightPlugins(byBlock.description, true, links);
  const criteriaPlugins = useHighlightPlugins(byBlock.criteria, criteriaEditable, links);
  const findingById = useMemo(() => new Map(t.findings.map((f) => [f.id, f])), [t.findings]);
  const fieldOf = useCallback(
    (f: SprintFinding): DraftField | null => findingDraftField(f, t, criteriaReadOnly != null),
    [t, criteriaReadOnly],
  );

  // "Apply all suggestions": every proposal of a CURRENT run, then every finding's suggestion
  // (`applyAllSuggestions` — proposals first; a field a proposal rewrote takes no quote-replace).
  const applyInputs = useMemo(() => {
    const body = sprintCurrentAssessmentBodyOf(t);
    const proposals: ApplyAllProposal[] = [];
    const desc = body?.revisedDescription ?? null;
    if (desc != null && desc.trim() !== '') proposals.push({ field: 'description', build: () => desc });
    const revised = body?.revisedCriteria ?? [];
    if (revised.length > 0) {
      proposals.push({
        field: criteriaEditable ? 'criteria' : 'description',
        build: (x) => proposedCriteriaDraft(x, revised).text,
      });
    }
    const findings: ApplyAllFinding[] = t.findings.map((f) => ({
      id: f.id,
      field: fieldOf(f),
      quote: f.quote,
      suggestion: f.suggestion,
    }));
    return {
      findings,
      proposals,
      any: proposals.length > 0 || findings.some((f) => f.suggestion != null && f.suggestion.trim() !== ''),
    };
  }, [t, fieldOf, criteriaEditable]);
  const editableField = useCallback((f: DraftField) => fieldEditable(t, f) && !d.moved, [t, d.moved]);
  const applyAllCount = useMemo(
    () => applyAllSuggestions(d.draft, applyInputs.findings, applyInputs.proposals, editableField).applied,
    [d.draft, applyInputs, editableField],
  );

  // After every render: which findings have a mark, and which marks are selected.
  useLayoutEffect(() => {
    const root = textRef.current;
    if (root == null) return;
    const ids = new Set<string>();
    for (const m of Array.from(root.querySelectorAll<HTMLElement>('mark[data-findings]'))) {
      const own = (m.dataset.findings ?? '').split(' ').filter((x) => x !== '');
      own.forEach((x) => ids.add(x));
      m.classList.toggle('story-mark-selected', selected != null && own.some((x) => selected.includes(x)));
    }
    const sig = [...ids].sort().join(' ');
    if (sig !== anchored) setAnchored(sig);
  });
  const anchoredIds = useMemo(() => {
    const ids = new Set(anchored.split(' ').filter((x) => x !== ''));
    // A field in Edit has no marks; its findings stay "in the text" while their quote is.
    for (const f of t.findings) {
      const field = fieldOf(f);
      const text = field != null ? d.draft.text[field] : null;
      if (field != null && editing[field] && text != null && f.quote != null && findQuoteInMarkdown(text, f.quote) != null)
        ids.add(f.id);
    }
    return ids;
  }, [anchored, t.findings, fieldOf, editing, d.draft.text]);

  const markOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest('mark[data-findings]') as HTMLElement | null) : null;
  const idsOf = (m: HTMLElement): string[] => (m.dataset.findings ?? '').split(' ').filter((x) => findingById.has(x));

  const showPopover = useCallback(
    (m: HTMLElement) => {
      const root = textRef.current;
      if (root == null) return;
      const r = m.getBoundingClientRect();
      const c = root.getBoundingClientRect();
      const width = Math.min(256, c.width);
      setHover({
        ids: idsOf(m),
        top: r.bottom - c.top + 4,
        left: Math.max(0, Math.min(r.left - c.left, c.width - width)),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findingById],
  );

  // Stacked (below md) the thread sits under the text: bring it into view.
  const selectMark = (m: HTMLElement): void => {
    const ids = idsOf(m);
    if (ids.length === 0) return;
    setSelected(ids);
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches) {
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({
          block: 'start',
          behavior: 'smooth',
        }),
      );
    }
  };
  const onClick = (e: MouseEvent): void => {
    const m = markOf(e.target);
    if (m != null) selectMark(m);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const m = markOf(e.target);
    if (m == null) return;
    e.preventDefault();
    selectMark(m);
  };

  const pick = (id: string): void => {
    setSelected([id]);
    const m = textRef.current?.querySelector<HTMLElement>(`mark[data-findings~="${CSS.escape(id)}"]`);
    m?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const titleAnchored = byBlock.title.length > 0;
  const fieldProps = (field: DraftField) => ({
    field,
    draft: d,
    editable: fieldEditable(t, field) && !d.moved,
    truncated:
      field === 'description' ? t.replaceBases.description.truncated : (t.replaceBases.acceptanceCriteria?.truncated ?? false),
    editing: editing[field],
    onToggle: () => setEditing((e) => ({ ...e, [field]: !e[field] })),
  });

  return (
    <div className="space-y-3">
      <SprintDraftBar ticket={t} workspaceId={workspaceId} draft={d} />
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div
          ref={textRef}
          className="relative min-w-0 space-y-3 text-gray-800 dark:text-gray-100"
          data-testid="sprint-ticket-text"
          onClick={onClick}
          onKeyDown={onKeyDown}
          onMouseOver={(e) => {
            const m = markOf(e.target);
            if (m != null) showPopover(m);
          }}
          onMouseOut={(e) => {
            if (markOf(e.target) != null && markOf(e.relatedTarget) == null) setHover(null);
          }}
          onFocus={(e) => {
            const m = markOf(e.target);
            if (m != null) showPopover(m);
          }}
          onBlur={() => setHover(null)}
        >
          {titleAnchored && (
            <div className="text-sm font-semibold">
              <Markdown rehypeExtra={titlePlugins}>{plainMarkdown(t.title)}</Markdown>
            </div>
          )}
          <DraftFieldBlock
            {...fieldProps('description')}
            label="Description"
            plugins={descriptionPlugins}
            empty="No description."
          />
          {criteriaEditable ? (
            <DraftFieldBlock
              {...fieldProps('criteria')}
              label={t.acField?.name ?? 'Acceptance criteria'}
              plugins={criteriaPlugins}
              empty="No criteria."
            />
          ) : (
            criteriaReadOnly != null && (
              <FieldFrame
                label={t.acField?.name ?? 'Acceptance criteria'}
                testId="sprint-criteria-readonly"
                body={
                  <div className={FIELD_BOX} data-testid="sprint-field-preview">
                    <Markdown rehypeExtra={criteriaPlugins} ticketLinks>
                      {criteriaReadOnly.kind === 'field'
                        ? criteriaReadOnly.markdown
                        : criteriaReadOnly.items.map((c, i) => `${i + 1}. ${c}`).join('\n')}
                    </Markdown>
                  </div>
                }
              />
            )
          )}
          {hover != null && hover.ids.length > 0 && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-20 w-64 max-w-full space-y-1.5 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
              style={{ top: hover.top, left: hover.left }}
            >
              {hover.ids.map((id) => {
                const f = findingById.get(id);
                if (f == null) return null;
                return (
                  <div key={id} className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <IssuePill finding={f} />
                      <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">
                        {STORY_RULE_BY_ID[f.rule].label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-700 dark:text-gray-200">{STORY_RULE_BY_ID[f.rule].hover}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <FindingsPanel
          panelRef={panelRef}
          ticket={t}
          draft={d}
          fieldOf={fieldOf}
          anchoredIds={anchoredIds}
          selected={
            selected != null ? selected.map((id) => findingById.get(id)).filter((f): f is SprintFinding => f != null) : null
          }
          onPick={pick}
          onBack={() => setSelected(null)}
          applyAll={
            applyInputs.any
              ? {
                  count: applyAllCount,
                  run: () => d.applyAll(applyInputs.findings, applyInputs.proposals, editableField),
                }
              : null
          }
        />
      </div>
      <SprintProposals ticket={t} draft={d} />
    </div>
  );
}

function DraftFieldBlock({
  field,
  label,
  draft: d,
  editable,
  truncated,
  editing,
  onToggle,
  plugins,
  empty,
}: {
  field: DraftField;
  label: string;
  draft: TicketDraftApi;
  editable: boolean;
  truncated: boolean;
  editing: boolean;
  onToggle: () => void;
  plugins: RehypePlugins;
  empty: string;
}): JSX.Element {
  const text = d.draft.text[field] ?? '';
  const base = d.draft.base[field] ?? '';
  const markdown = useMemo(() => revisionMarkdown(base, text), [base, text]);
  const inEdit = editing && editable;
  return (
    <FieldFrame
      label={label}
      testId={`sprint-draft-${field}`}
      note={truncated ? 'Too long to edit here.' : null}
      action={
        editable ? (
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
          >
            {inEdit ? <EyeIcon size={11} /> : <PencilIcon size={11} />}
            {inEdit ? 'Preview' : 'Edit'}
          </button>
        ) : null
      }
      body={
        inEdit ? (
          <DraftTextarea label={label} value={text} onChange={(v) => d.setField(field, v)} />
        ) : (
          <div className={FIELD_BOX} data-testid="sprint-field-preview">
            {text.trim() !== '' ? (
              <Markdown rehypeExtra={plugins} ticketLinks>
                {markdown}
              </Markdown>
            ) : (
              <p className={`text-xs ${MUTED}`}>{empty}</p>
            )}
          </div>
        )
      }
    />
  );
}

/** One text field: its heading row (label, a note, an action) above a box of the ONE fixed height —
 *  the description and the criteria, editable or not, preview or editor, all line up. */
function FieldFrame({
  label,
  testId,
  note = null,
  action = null,
  body,
}: {
  label: string;
  testId: string;
  note?: string | null;
  action?: JSX.Element | null;
  body: JSX.Element;
}): JSX.Element {
  return (
    <section className="space-y-1" data-testid={testId}>
      <div className="flex min-h-[22px] flex-wrap items-center gap-2">
        <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">{label}</h5>
        {note != null && <span className={`text-xs ${MUTED}`}>{note}</span>}
        {action}
      </div>
      {body}
    </section>
  );
}

/** The ONE field height (24rem), shared by every preview box and the Markdown editor; each scrolls
 *  inside it. */
const FIELD_HEIGHT = 'h-96';
const FIELD_BOX = `${FIELD_HEIGHT} overflow-y-auto rounded border border-gray-200 p-2 dark:border-gray-800`;

function DraftTextarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <textarea
      aria-label={`${label} (Markdown)`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck
      className={`block ${FIELD_HEIGHT} w-full resize-none overflow-y-auto rounded border border-gray-300 bg-white p-2 font-mono text-xs leading-5 text-gray-800 focus:border-sky-500 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100`}
    />
  );
}

function FindingsPanel({
  panelRef,
  ticket: t,
  draft: d,
  fieldOf,
  anchoredIds,
  selected,
  onPick,
  onBack,
  applyAll,
}: {
  panelRef: RefObject<HTMLElement>;
  ticket: SprintTicketRow;
  draft: TicketDraftApi;
  fieldOf: (f: SprintFinding) => DraftField | null;
  anchoredIds: Set<string>;
  selected: SprintFinding[] | null;
  onPick: (id: string) => void;
  onBack: () => void;
  /** null when the ticket has no suggestion at all. */
  applyAll: { count: number; run: () => void } | null;
}): JSX.Element {
  const replaced = new Set(d.draft.replaced);
  const inText = t.findings.filter((f) => anchoredIds.has(f.id) && !replaced.has(f.id));
  const done = t.findings.filter((f) => replaced.has(f.id));
  const notInText = t.findings.filter((f) => !anchoredIds.has(f.id) && !replaced.has(f.id));

  return (
    <aside
      ref={panelRef}
      className="min-w-0 scroll-mt-2 space-y-3 md:sticky md:top-2 md:self-start"
      data-testid="sprint-findings"
    >
      {applyAll != null && (
        <div className="flex flex-wrap items-center gap-2" data-testid="sprint-apply-all">
          <button
            type="button"
            disabled={applyAll.count === 0}
            onClick={applyAll.run}
            className="rounded border border-sky-600 bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            Apply all suggestions
          </button>
          {d.lastApplyAll != null && (
            <>
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Applied {d.lastApplyAll.applied} to the draft.
              </span>
              <button
                type="button"
                onClick={d.undoApplyAll}
                className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
              >
                <UndoIcon size={11} />
                Undo
              </button>
            </>
          )}
          <InfoButton title="Apply all suggestions">
            <p>
              Puts every suggestion into your draft in one step: a proposed description or criteria list replaces that whole
              field, then each highlighted passage still in the text is replaced with Claude’s wording.
            </p>
            <p>A field replaced by a proposal takes no further replacements. Undo puts the draft back as it was.</p>
            <p>Nothing is sent to the tracker until you press Update and confirm.</p>
          </InfoButton>
        </div>
      )}
      {selected != null && selected.length > 0 ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-300"
          >
            <ChevronIcon dir="left" size={11} />
            All findings
          </button>
          {selected.map((f) => (
            <FindingThread key={f.id} ticket={t} finding={f} field={fieldOf(f)} draft={d} />
          ))}
        </div>
      ) : t.findings.length === 0 ? (
        <p className={`text-xs ${MUTED}`}>Nothing flagged.</p>
      ) : (
        <>
          {inText.length > 0 && <FindingRows findings={inText} onPick={onPick} />}
          {done.length > 0 && (
            <div className="space-y-1">
              <h5 className={`text-[11px] font-semibold ${MUTED}`}>Replaced</h5>
              <FindingRows findings={done} onPick={onPick} />
            </div>
          )}
          {notInText.length > 0 && (
            <div className="space-y-1">
              <h5 className={`text-[11px] font-semibold ${MUTED}`}>Not in the text</h5>
              <FindingRows findings={notInText} onPick={onPick} />
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/** The panel's rows: a rule met more than once is ONE row with a count, opened to list each finding
 *  (`groupSprintFindings`); every finding stays pickable on its own. */
function FindingRows({ findings, onPick }: { findings: SprintFinding[]; onPick: (id: string) => void }): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <ul className="space-y-1">
      {groupSprintFindings(findings).map((row) =>
        row.kind === 'one' ? (
          <FindingRow key={row.finding.id} finding={row.finding} onPick={onPick} />
        ) : (
          <li key={row.key} className="space-y-1" data-testid="sprint-finding-group">
            <button
              type="button"
              aria-expanded={open.has(row.key)}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.key)) next.delete(row.key);
                  else next.add(row.key);
                  return next;
                })
              }
              className="flex w-full items-center gap-1.5 rounded border border-gray-200 px-2 py-1.5 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-900"
            >
              <IssuePill finding={row} />
              <span className="min-w-0 flex-1 text-xs text-gray-800 dark:text-gray-100">
                <span className="font-semibold">{row.label}</span>
                <span className={MUTED}> · {row.findings.length}</span>
              </span>
              <ChevronIcon dir={open.has(row.key) ? 'down' : 'right'} size={11} />
            </button>
            {open.has(row.key) && (
              <ul className="space-y-1 pl-3">
                {row.findings.map((f) => (
                  <FindingRow key={f.id} finding={f} onPick={onPick} />
                ))}
              </ul>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function FindingRow({ finding: f, onPick }: { finding: SprintFinding; onPick: (id: string) => void }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(f.id)}
        className="flex w-full items-start gap-1.5 rounded border border-gray-200 px-2 py-1.5 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-900"
      >
        <IssuePill finding={f} />
        <span className="min-w-0 flex-1 text-xs text-gray-800 dark:text-gray-100">
          <span className="font-semibold">{f.brief}</span>
          {f.source === 'claude' && <ClaudeMark />}
          {f.detail.trim() !== '' && <span className={`block ${MUTED}`}>{findingSnippet(f.detail)}</span>}
        </span>
      </button>
    </li>
  );
}

function FindingThread({
  ticket: t,
  finding: f,
  field,
  draft: d,
}: {
  ticket: SprintTicketRow;
  finding: SprintFinding;
  field: DraftField | null;
  draft: TicketDraftApi;
}): JSX.Element {
  const rule = STORY_RULE_BY_ID[f.rule];
  const suggestion = f.suggestion != null && f.suggestion.trim() !== '' ? f.suggestion : null;
  const quote = f.quote != null && f.quote.trim() !== '' ? f.quote : null;
  const replaced = d.draft.replaced.includes(f.id);
  const text = field != null ? d.draft.text[field] : null;
  const found = quote != null && text != null && findQuoteInMarkdown(text, quote) != null;
  const canReplace = suggestion != null && quote != null && field != null && fieldEditable(t, field) && !d.moved && found;
  const undo = d.lastReplace?.findingId === f.id ? d.lastReplace : null;
  return (
    <article
      className="space-y-2 rounded-md border border-gray-200 p-2.5 dark:border-gray-800"
      data-testid="sprint-finding-thread"
    >
      <header className="flex flex-wrap items-center gap-1.5">
        <IssuePill finding={f} />
        <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">{rule.label}</span>
        {f.source === 'claude' && <ClaudeMark />}
        <SprintCopyButton markdown={sprintFindingMarkdown(f)} what="this finding" className="ml-auto" />
      </header>
      {f.blocker != null ? (
        <p className="text-xs text-gray-800 dark:text-gray-100">
          Waits on <BlockerText blocker={f.blocker} />
        </p>
      ) : (
        <p className="text-xs text-gray-800 dark:text-gray-100">{f.detail.trim() !== '' ? f.detail : rule.hover}</p>
      )}
      {quote != null && (
        <div className="space-y-0.5">
          <div className={`text-[11px] font-medium ${MUTED}`}>Original</div>
          <p className="whitespace-pre-wrap rounded bg-gray-50 p-1.5 text-xs [overflow-wrap:anywhere] text-gray-800 dark:bg-gray-900 dark:text-gray-100">
            {quote}
          </p>
        </div>
      )}
      {suggestion != null && (
        <div className="space-y-0.5">
          <div className={`text-[11px] font-medium ${MUTED}`}>Suggested</div>
          <p className="whitespace-pre-wrap rounded bg-gray-50 p-1.5 text-xs [overflow-wrap:anywhere] text-gray-800 dark:bg-gray-900 dark:text-gray-100">
            <DiffText parts={quote != null ? wordDiff(quote, suggestion) : [{ kind: 'added', text: suggestion }]} />
          </p>
        </div>
      )}
      {(canReplace || replaced) && (
        <div className="flex flex-wrap items-center gap-2">
          {replaced ? (
            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Replaced in the draft.</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (field != null && quote != null && suggestion != null) d.replaceFinding(field, f.id, quote, suggestion);
              }}
              className="rounded border border-sky-600 bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700"
            >
              Replace
            </button>
          )}
          {undo != null && (
            <button
              type="button"
              onClick={d.undoReplace}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
            >
              <UndoIcon size={11} />
              Undo
            </button>
          )}
        </div>
      )}
      {quote != null && field != null && !found && !replaced && <p className={`text-xs ${MUTED}`}>No longer in the text.</p>}
      {f.ref != null && (
        <p className={`text-[11px] ${MUTED}`}>
          <code className="font-mono">{f.ref.path}</code> in {f.ref.repo}
        </p>
      )}
    </article>
  );
}

/** A blocker phrase with its ticket key as a tracker link when the URL is safe. */
function BlockerText({ blocker: b }: { blocker: StoryBlocker }): JSX.Element {
  const phrase = storyBlockerPhrase(b);
  const href = safeExternalUrl(b.url);
  if (b.ticketKey == null || href == null || !phrase.startsWith(b.ticketKey)) return <>{phrase}</>;
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer" className="font-mono text-sky-700 hover:underline dark:text-sky-300">
        {b.ticketKey}
      </a>
      {phrase.slice(b.ticketKey.length)}
    </>
  );
}
