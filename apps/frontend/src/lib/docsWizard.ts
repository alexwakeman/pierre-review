import {
  REFERENCE_DOC_WIKI_MAX_PAGES,
  isRepoDocsUnreadableShown,
  repoDocsUnreadableReasonText,
  type GithubDocsFolder,
  type RepoDocsOffer,
  type RepoDocsUnreadable,
  type WikiPreflightResponse,
  type WikiProviderId,
} from '@pierre-review/shared';

// THE ADD-DOCUMENTS WIZARD, AS DATA (docs/REFERENCE-DOCS.md § The SPA → Adding). Which steps each
// source type walks, and the review step's one sentence. `components/Activity/DocsAddWizard.tsx`
// renders it; `test/docsWizard.test.ts` pins it.

export type DocsSourceType = 'upload' | 'web' | 'confluence' | 'notion' | 'github' | 'repos';

export type DocsWizardStep = 'type' | 'files' | 'address' | 'connection' | 'page' | 'repo' | 'folder' | 'folders' | 'review';

/**
 * Every step a source type walks, in order (the type list shows them in this order). The first is
 * always the type. The last is the review — except an upload, whose files step IS the action: a
 * chosen or dropped file is sent at once, as the old "Choose files" box did.
 */
export const DOCS_WIZARD_STEPS: Record<DocsSourceType, readonly DocsWizardStep[]> = {
  upload: ['type', 'files'],
  web: ['type', 'address', 'review'],
  confluence: ['type', 'connection', 'page', 'review'],
  notion: ['type', 'connection', 'page', 'review'],
  github: ['type', 'repo', 'folder', 'review'],
  // "From your repositories": the docs offer's check over every repository of the workspace (Next on the
  // type step runs it), then a checkbox per qualifying folder, then the review.
  repos: ['type', 'folders', 'review'],
};

export const DOCS_SOURCE_LABEL: Record<DocsSourceType, string> = {
  upload: 'Upload a document',
  web: 'Web page or site',
  confluence: 'Confluence',
  notion: 'Notion',
  github: 'GitHub repository',
  repos: 'From your repositories',
};

/** The wiki a source type reads, or null (a web page). */
export const wikiOfType = (t: DocsSourceType): WikiProviderId | null =>
  t === 'confluence' || t === 'notion' ? t : t === 'github' || t === 'repos' ? 'github' : null;

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

// ---- "From your repositories" ----

/** The ticked folders that can be added, in list order (a too-large one has no checkbox). */
export function pickedRepoFolders(folders: readonly RepoDocsOffer[], picked: ReadonlySet<number>): RepoDocsOffer[] {
  return folders.filter((f) => !f.tooLarge && picked.has(f.id));
}

/** "This will add 3 folders from your repositories, one document each." — the review's sentence. */
export function repoFoldersReviewSentence(n: number): string {
  return n === 1 ? 'This will add 1 folder from your repositories as one document.' : `This will add ${n} folders from your repositories, one document each.`;
}

/** The unreadable repositories the folders step lists: the LASTING reasons only (a transient
 *  'unavailable' is not shown; it still backs off). */
export function shownUnreadableRepos(list: readonly RepoDocsUnreadable[]): RepoDocsUnreadable[] {
  return list.filter((u) => isRepoDocsUnreadableShown(u.reason));
}

/** One unreadable repository in the folders step: "acme/legacy: Limn can't read its files (no access)." */
export function unreadableRepoText(u: RepoDocsUnreadable): string {
  return `${u.repoFullName}: Limn can’t read its files (${repoDocsUnreadableReasonText(u.reason)}).`;
}

/** The folders step's line when nothing qualifies, or when some repositories were not looked at. */
export function repoFoldersNote(folders: number, notLookedAt: number): string | null {
  const rest = notLookedAt > 0 ? `${plural(notLookedAt, 'repository', 'repositories')} not checked yet. Try again shortly.` : null;
  if (folders === 0) return rest != null ? `No docs folders found so far. ${rest}` : 'No docs folders found in this workspace’s repositories.';
  return rest;
}
