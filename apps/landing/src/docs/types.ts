// The docs' content model. One page = one file under pages/<section>/<slug>.tsx that exports
// `meta` (this type) and a default body component. The MANIFEST (manifest.ts) says which section a
// page belongs to, its order and its writer; the page's folder must match its section.

/** Who writes a page (the docs build split the work five ways; `auto` = generated, e.g. the changelog). */
export type Writer = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'auto';

export interface DocMeta {
  /** The page title: task-oriented, in the app's own words ("Arm merge when ready"). */
  title: string;
  /** One or two plain sentences: what the page covers. Shown under the title, in search and in the meta description. */
  summary: string;
  /** True while the page is a placeholder. The docs test fails while any page is a stub. */
  stub?: boolean;
}

export interface PageModule {
  meta: DocMeta;
  /** The body. ⚠ HOOK-FREE: the contents list is read by calling it outside a render. */
  default: () => JSX.Element;
}

export interface PageEntry {
  /** `<section>/<slug>`, the page's key everywhere (DocLink to="…"). */
  key: string;
  section: string;
  slug: string;
  writer: Writer;
  /** The URL: /docs/<section>/<slug>, or /docs/<section> when the slug equals the section. */
  route: string;
  meta: DocMeta;
  Body: () => JSX.Element;
}

export interface SectionEntry {
  id: string;
  title: string;
  /** The sidebar heading this section sits under. */
  group: string;
  /** What the section covers, in one sentence (the docs home's section cards). */
  blurb: string;
  pages: PageEntry[];
}
