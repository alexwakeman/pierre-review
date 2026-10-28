import type { WikiProviderId, WikiUnreachableReason } from '@pierre-review/shared';

// THE WIKI-SOURCE SEAM (docs/REFERENCE-DOCS.md § Wiki sources). A team wiki — Confluence today, Notion
// next — is read through ONE adapter interface, so the import, the change check, the incremental
// rebuild and the refresh cadence (sync.ts, refresh.ts) never name a provider. An adapter:
//
//   • resolves a pasted address to a page reference (pure, no request);
//   • reads one page — its title, version / last-edit time, parent, and (optionally) its body in the
//     provider's own format — and converts that body to markdown;
//   • lists a page's descendants to a depth (ids, titles, parents, order — no bodies);
//   • finds the descendants changed since an instant (a coarse server-side filter: the caller compares
//     versions / edit times itself, so the filter may over-report but must never under-report).
//
// Every failure is a `WikiSourceError` with a CODE (never the upstream body). A 429 is honoured by the
// adapter (Retry-After, bounded) and surfaces as `rate_limited` only when the wait would be too long.
// ⚠ Adapters NEVER log a request's headers: they carry the credential.

export interface WikiCredential {
  /** Atlassian account email (Basic auth with the token); null for a bearer token. */
  email: string | null;
  token: string;
}

/** A page in a wiki SITE. `origin` is `https://<host>`; `pageId` is the provider's own id. */
export interface WikiPageRef {
  provider: WikiProviderId;
  origin: string;
  host: string;
  pageId: string;
}

/** A page's place in the tree and its change markers — no body. */
export interface WikiPageMeta {
  id: string;
  title: string;
  /** The parent PAGE (null for a page with none in the tree, e.g. the root). */
  parentId: string | null;
  /** The provider's version number, when it has one (Confluence). */
  version: number | null;
  /** The last edit, when the provider reports it. */
  editedAt: Date | null;
  /** Levels below the listing's root (the root is 0). */
  depth: number;
  /** Order among siblings, when the provider reports it. */
  position: number | null;
}

/** A page WITH its body in the provider's own format (Confluence: storage-format XHTML). */
export interface WikiPage extends WikiPageMeta {
  body: string;
  /** The page's address in the wiki, for the chapter's "Source:" line. */
  webUrl: string | null;
}

export interface WikiCallOptions {
  credential: WikiCredential;
  signal?: AbortSignal;
}

export interface WikiSource {
  readonly provider: WikiProviderId;
  /** A pasted page address → its reference, or null when it names no page of this wiki. Pure. */
  resolveRef(rawUrl: string): WikiPageRef | null;
  /** One page. `body: false` reads only its metadata (the cheap version check). */
  getPage(site: WikiPageRef, pageId: string, opts: WikiCallOptions & { body: boolean }): Promise<WikiPage>;
  /** Every descendant PAGE of `rootId` down to `depth` levels (root excluded), in tree order. At most
   *  `cap` are returned; `more` says whether the tree holds more. */
  listDescendants(
    site: WikiPageRef,
    rootId: string,
    depth: number,
    cap: number,
    opts: WikiCallOptions,
  ): Promise<{ pages: WikiPageMeta[]; more: boolean }>;
  /** Descendant pages of `rootId` (any depth) edited after `since` — may over-report, never under. */
  changedSince(site: WikiPageRef, rootId: string, since: Date, opts: WikiCallOptions): Promise<WikiPageMeta[]>;
  /** A page's body → markdown (the library's text). Hook: diagrams carry `[Diagram: name]` today. */
  toMarkdown(page: WikiPage): Promise<string>;
  /** Settings' "Test connection": one cheap authenticated read of the site. Throws on failure. */
  checkAccess(site: Pick<WikiPageRef, 'provider' | 'origin' | 'host'>, opts: WikiCallOptions): Promise<void>;
  /** A page's address in the wiki (the chapter's "Source:" line). Pure. */
  pageUrl(site: WikiPageRef, pageId: string): string;
}

export type WikiSourceErrorCode =
  | 'bad_url'
  | 'blocked'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'not_json'
  | 'too_large'
  | 'http'
  | 'no_credential';

export class WikiSourceError extends Error {
  constructor(
    readonly code: WikiSourceErrorCode,
    readonly status: number | null = null,
    /** A 429's Retry-After, in ms, when the adapter gave up waiting. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`wiki request failed: ${code}${status != null ? ` (${status})` : ''}`);
    this.name = 'WikiSourceError';
  }
}

/** The document line's reason for an error, or null when the error is not about reaching the wiki. */
export function unreachableReasonOf(err: unknown): WikiUnreachableReason {
  const code = err instanceof WikiSourceError ? err.code : 'network';
  switch (code) {
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    case 'unauthorized':
      return 'unauthorized';
    case 'no_credential':
      return 'no_credential';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'network';
  }
}

/** A sentence for a failed import (a first build), never the upstream body. */
export function wikiErrorMessage(providerName: string, err: unknown): string {
  const code = err instanceof WikiSourceError ? err.code : 'network';
  switch (code) {
    case 'no_credential':
      return `Add a ${providerName} API token in Settings → Workspace → Reference docs, then try again.`;
    case 'unauthorized':
      return `${providerName} did not accept the saved email and token.`;
    case 'forbidden':
      return `The saved ${providerName} token may not read this page.`;
    case 'not_found':
      return `${providerName} has no such page, or the saved token cannot see it.`;
    case 'rate_limited':
      return `${providerName} asked Limn to slow down. Try again in a few minutes.`;
    case 'blocked':
    case 'bad_url':
      return `Limn does not read ${providerName} at that address. Use the page's https address.`;
    case 'redirect':
      return `${providerName} answered with a redirect. Use the page's own address.`;
    case 'timeout':
      return `${providerName} took too long to answer.`;
    case 'too_large':
      return `${providerName} sent more than Limn reads for one page.`;
    case 'not_json':
    case 'http':
      return `${providerName} answered with an error${err instanceof WikiSourceError && err.status != null ? ` (${err.status})` : ''}.`;
    default:
      return `${providerName} could not be reached.`;
  }
}

// ---- the registry ----

const sources = new Map<WikiProviderId, WikiSource>();

export function registerWikiSource(s: WikiSource): void {
  sources.set(s.provider, s);
}

export function wikiSourceFor(provider: WikiProviderId): WikiSource | null {
  return sources.get(provider) ?? null;
}

/** The adapter whose `resolveRef` accepts this address, and the reference. */
export function resolveWikiUrl(rawUrl: string): { source: WikiSource; ref: WikiPageRef } | null {
  for (const s of sources.values()) {
    const ref = s.resolveRef(rawUrl);
    if (ref) return { source: s, ref };
  }
  return null;
}

/** Test seam: swap an adapter (a fake), returning the one it replaced. */
export function _setWikiSourceForTest(s: WikiSource): WikiSource | null {
  const prev = sources.get(s.provider) ?? null;
  sources.set(s.provider, s);
  return prev;
}
