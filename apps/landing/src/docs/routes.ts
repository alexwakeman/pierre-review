// Docs URLs, with no imports, so the kit, the manifest and the main bundle can all use them
// without an import cycle.

export const DOCS_ROOT = '/docs';

/** True for /docs and every page under it. */
export function isDocsPath(path: string): boolean {
  return path === DOCS_ROOT || path.startsWith(`${DOCS_ROOT}/`);
}

/** A page key (`<section>/<slug>`) to its URL. A slug equal to its section is the section's own URL. */
export function docRoute(key: string): string {
  const [section = '', slug = ''] = key.split('/');
  return slug === section ? `${DOCS_ROOT}/${section}` : `${DOCS_ROOT}/${section}/${slug}`;
}

/** `section/slug#anchor` to `/docs/section/slug#anchor`. */
export function docHref(to: string): string {
  const i = to.indexOf('#');
  const key = i === -1 ? to : to.slice(0, i);
  const hash = i === -1 ? '' : to.slice(i);
  return key === '' ? hash : `${docRoute(key)}${hash}`;
}
