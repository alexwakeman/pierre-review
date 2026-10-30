// REFERENCE DOCS IN A REVIEW (docs/REFERENCE-DOCS.md § Use in reviews): the passages a Claude Review,
// a ticket review (Story check) or This Sprint's "Check against code" used from the workspace's
// reference library, and a finding's own citations. Every reference was checked by the server (its
// link names a built section, its quote is in that section), so the list is drawn as stored.
//
//   DocReferenceList        the compact list: verdict chip, "Document › Section" link, quote, note
//   DocReferencesSection    the Claude Review tab's section shell around it
//   DocCitationLinks        a finding's "Reference: Document › Section" links
//   DocLink                 one library link (also the story docs check, Activity/StoryDocsAlignment.tsx)
//
// Every link opens the section in Activity → Docs: a click seats it in-app (store/openDocs.ts), and the
// href is a real deep link (lib/docReferences.ts) for a new tab. A link whose target has a checked
// `quote` (a reference, a story-docs point, a finding's borrowed quote) highlights it there. All text is PLAIN TEXT — a quote is the
// document's words, never markdown to render.
import type { MouseEvent, ReactNode } from 'react';
import {
  REVIEW_DOC_VERDICT_LABEL,
  type ReferenceDocCitation,
  type ReviewDocReference,
  type ReviewDocVerdict,
} from '@pierre-review/shared';
import { borrowedQuote, docsDeepLink } from '../lib/docReferences.js';
import { citationLabel } from '../lib/referenceDocs.js';
import { REVIEW_CHIP, REVIEW_META } from '../lib/reviewStyles.js';
import { openDocsSection } from '../store/openDocs.js';
import { BookIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';

const VERDICT_TONE: Record<ReviewDocVerdict, string> = {
  contradicts: 'bg-ui-danger/10 text-ui-danger',
  supports: 'bg-ui-raise text-ui-success',
  context: 'bg-ui-raise text-ui-ink',
};

// The SPA's base path: '/app/' in the app, '/demo/' in the static demo.
const SPA_BASE = import.meta.env.BASE_URL;

/**
 * One library link. ⚠ The workspace is the one whose library the SERVER checked this against
 * (`target.workspaceId`), never the reader's selected workspace: a PR opened from search, a pinned tab
 * or a deep link may belong to another workspace, whose library has other documents under the same
 * slugs. A reference stored before the field existed has no workspace, and is shown as a plain label.
 */
export function DocLink({ target, children }: { target: ReferenceDocCitation; children: ReactNode }): JSX.Element {
  const workspaceId = target.workspaceId ?? null;
  if (workspaceId == null) {
    return (
      <span className="inline-flex items-center gap-1 break-words text-left text-meta text-ui-ink">
        <BookIcon size={12} />
        {children}
      </span>
    );
  }
  const href = docsDeepLink(SPA_BASE, workspaceId, target);
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    // A plain click opens it in-app; a modified click (new tab / window) follows the deep link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openDocsSection(workspaceId, target.path, target.anchor, target.quote ?? null);
  };
  return (
    <a
      href={href}
      onClick={onClick}
      className="hit inline-flex items-center gap-1 break-words text-left text-meta text-ui-ink hover:underline"
    >
      <BookIcon size={12} />
      {children}
    </a>
  );
}

/** The compact list of references. Nothing at all when there are none. */
export function DocReferenceList({ references }: { references: readonly ReviewDocReference[] }): JSX.Element | null {
  if (references.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {references.map((r, i) => (
        <li key={`${r.path}#${r.anchor ?? ''}-${i}`} className="rounded-ui border border-ui-line px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${REVIEW_CHIP} ${VERDICT_TONE[r.verdict]}`}>{REVIEW_DOC_VERDICT_LABEL[r.verdict]}</span>
            <DocLink target={r}>
              {citationLabel(r)}
            </DocLink>
            {r.about != null && <span className={REVIEW_META}>{r.about}</span>}
          </div>
          <blockquote className="mt-1 border-l-2 border-ui-line pl-2 text-meta italic text-ui-ink">
            {r.quote}
          </blockquote>
          {r.note !== '' && <p className="mt-1 text-meta text-ui-ink">{r.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Counts by verdict, for a section header ("1 contradicts · 2 support"). */
export function docReferenceCounts(references: readonly ReviewDocReference[]): string {
  const n = (v: ReviewDocVerdict): number => references.filter((r) => r.verdict === v).length;
  const parts: string[] = [];
  if (n('contradicts') > 0) parts.push(`${n('contradicts')} contradict${n('contradicts') === 1 ? 's' : ''}`);
  if (n('supports') > 0) parts.push(`${n('supports')} support${n('supports') === 1 ? 's' : ''}`);
  if (n('context') > 0) parts.push(`${n('context')} context`);
  return parts.join(' · ');
}

/** `by`: the provider that ran the review these references came from (default Claude). */
export function DocReferencesInfo({ by = 'Claude' }: { by?: string } = {}): JSX.Element {
  return (
    <InfoButton title="Reference docs">
      <p>
        {by} read the workspace's reference library (Activity → Docs) and checked the work against it. Each entry is a
        passage it relied on.
      </p>
      <p>
        <strong>Contradicts</strong>: the story or the code goes against the passage. <strong>Supports</strong>: they do what
        it says. <strong>Context</strong>: it explains, but decides nothing.
      </p>
      <p>Every link and quote was checked against the library before it was saved; anything that did not match was left out.</p>
      <p>Switch this on or off in Settings → Docs.</p>
    </InfoButton>
  );
}

/**
 * The Claude Review tab's "Reference docs" section. Absent when the run did not read the library
 * (`null`); a run that read it and used nothing says so in one line.
 */
export function DocReferencesSection({
  references,
  by,
}: {
  references: readonly ReviewDocReference[] | null | undefined;
  /** The provider that ran the review ('Claude' | 'Codex'); default Claude. */
  by?: string;
}): JSX.Element | null {
  if (references == null) return null;
  const counts = docReferenceCounts(references);
  return (
    <ReviewSection
      title="Reference docs"
      pills={counts !== '' ? <SectionCount>{counts}</SectionCount> : undefined}
      info={<DocReferencesInfo by={by} />}
    >
      {references.length > 0 ? (
        <DocReferenceList references={references} />
      ) : (
        <p className={REVIEW_META}>Nothing in the library bears on this change.</p>
      )}
    </ReviewSection>
  );
}

/** A compact block for the ticket review and the sprint check: a small heading, then the list. */
export function DocReferencesBlock({ references }: { references: readonly ReviewDocReference[] | null | undefined }): JSX.Element | null {
  if (references == null || references.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h4 className="text-meta font-semibold text-ui-ink">Reference docs</h4>
        <DocReferencesInfo />
      </div>
      <DocReferenceList references={references} />
    </div>
  );
}

/**
 * A finding's library citations: "Reference: Document › Section". Nothing when it has none. A citation
 * borrows the quote of the run's ONE matching reference (`borrowedQuote`), else opens at its anchor.
 */
export function DocCitationLinks({
  citations,
  references,
}: {
  citations: readonly ReferenceDocCitation[] | undefined;
  /** The same run's references, whose quotes a citation may borrow. */
  references?: readonly ReviewDocReference[] | null;
}): JSX.Element | null {
  if (citations == null || citations.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
      <span className={REVIEW_META}>Reference:</span>
      {citations.map((c) => (
        <DocLink key={`${c.path}#${c.anchor ?? ''}`} target={{ ...c, quote: borrowedQuote(c, references) ?? undefined }}>
          {citationLabel(c)}
        </DocLink>
      ))}
    </div>
  );
}
