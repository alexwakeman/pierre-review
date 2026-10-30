import {
  REFERENCE_DOC_WIKI_MAX_PAGES,
  type GithubDocsFolder,
  type WikiPreflightResponse,
  type WikiProviderId,
} from '@pierre-review/shared';

// THE ADD-DOCUMENTS WIZARD, AS DATA (docs/REFERENCE-DOCS.md § The SPA → Adding). Which steps each
// source type walks, and the review step's one sentence. `components/Activity/DocsAddWizard.tsx`
// renders it; `test/docsWizard.test.ts` pins it.

export type DocsSourceType = 'web' | 'confluence' | 'notion' | 'github';

export type DocsWizardStep = 'type' | 'address' | 'connection' | 'page' | 'repo' | 'folder' | 'review';

/** Every step a source type walks, in order. The first is always the type, the last the review. */
export const DOCS_WIZARD_STEPS: Record<DocsSourceType, readonly DocsWizardStep[]> = {
  web: ['type', 'address', 'review'],
  confluence: ['type', 'connection', 'page', 'review'],
  notion: ['type', 'connection', 'page', 'review'],
  github: ['type', 'repo', 'folder', 'review'],
};

export const DOCS_SOURCE_LABEL: Record<DocsSourceType, string> = {
  web: 'Web page or site',
  confluence: 'Confluence',
  notion: 'Notion',
  github: 'GitHub repository',
};

/** The wiki a source type reads, or null (a web page). */
export const wikiOfType = (t: DocsSourceType): WikiProviderId | null => (t === 'confluence' || t === 'notion' ? t : t === 'github' ? 'github' : null);

/** The step after `step` for `type`, or null at the review. */
export function nextStep(type: DocsSourceType, step: DocsWizardStep): DocsWizardStep | null {
  const steps = DOCS_WIZARD_STEPS[type];
  const i = steps.indexOf(step);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1]! : null;
}

/** The step before `step` for `type`, or null at the first. */
export function previousStep(type: DocsSourceType, step: DocsWizardStep): DocsWizardStep | null {
  const steps = DOCS_WIZARD_STEPS[type];
  const i = steps.indexOf(step);
  return i > 0 ? steps[i - 1]! : null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "This will add 12 pages from Payments handbook." — the wiki review's one sentence. */
export function wikiReviewSentence(p: Pick<WikiPreflightResponse, 'pageCount' | 'rootTitle' | 'scope'>): string {
  const from = p.scope.kind === 'space' ? `the whole ${p.scope.name || p.rootTitle} wiki` : p.rootTitle;
  return `This will add ${plural(p.pageCount, 'page')} from ${from}.`;
}

/** The wiki review's second line when the tree is larger than one document holds; null otherwise. */
export function wikiOverCapSentence(p: Pick<WikiPreflightResponse, 'more'>): string | null {
  return p.more ? `Only the first ${REFERENCE_DOC_WIKI_MAX_PAGES} pages fit in one document. Add the rest as separate sections.` : null;
}

/** "This will add 9 documents from acme/handbook/docs." — the repository review's sentence. */
export function githubReviewSentence(repo: string, folder: GithubDocsFolder): string {
  const n = Math.min(folder.docs, REFERENCE_DOC_WIKI_MAX_PAGES);
  return `This will add ${plural(n, 'document')} from ${repo}${folder.path ? `/${folder.path}` : ''}.`;
}

/** A folder's line in the picker: "Whole repository · 12" / "docs · 9". */
export const folderLabel = (f: GithubDocsFolder): string => (f.path === '' ? 'Whole repository' : f.path);
