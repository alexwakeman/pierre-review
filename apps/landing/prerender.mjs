// Build-time prerenderer for the marketing site.
//
// WHY THIS EXISTS
// The landing page is a client-rendered React SPA. Before this script, every URL
// on pierre-review.com returned the same ~7.8 KB shell whose entire <body> was an
// empty #root plus a splash caret — so anything that does not execute JavaScript
// (an AI agent fetching the page, a link unfurler, a text browser, a crawler on a
// render budget) saw a site with no content and no way to tell /pricing from
// /privacy. The <head> metadata was good, but metadata is a summary of content,
// not a substitute for it.
//
// WHAT IT DOES
// After `vite build` produces the client bundle, this runs each route through
// react-dom/server and writes real HTML to dist/<route>/index.html, with the
// route's own title/description/canonical baked into the head. The result is a
// site that is fully readable with JS disabled and still behaves as an SPA once
// the bundle loads.
//
// WHY NOT HYDRATE
// main.tsx keeps using createRoot(), not hydrateRoot(). Hydration would save a
// re-render but demands the server and client trees match exactly — and several
// components here deliberately differ: CookieBanner and GameBar both render
// nothing until they have read localStorage, so the static HTML omits them and the
// browser tree includes them. A mismatch degrades to a client render anyway, but
// noisily. Static markup + a fresh client render is the same end state with no
// failure mode.
//
// The SSR bundle is a build artifact only: it is written outside dist/ and deleted
// on the way out, so nothing extra ships.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const ssrDir = join(here, '.ssr-build');

const SEO_MARKERS = ['<!-- seo:start -->', '<!-- seo:end -->'];
const APP_MARKERS = ['<!-- app:start -->', '<!-- app:end -->'];

const log = (msg) => console.log(`  prerender: ${msg}`);

/** Replace everything between two marker comments (markers included). */
function replaceBetween(html, [start, end], replacement, label) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(
      `index.html is missing the ${label} markers (${start} … ${end}). ` +
        `prerender.mjs rewrites those regions — restore them or the built site ` +
        `silently reverts to an empty, contentless shell on every route.`,
    );
  }
  return html.slice(0, a) + replacement + html.slice(b + end.length);
}

const escapeAttr = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The full per-route <head> SEO block: title, description, canonical, OG, Twitter. */
function seoBlock({ title, description, robots = 'index, follow', url, image, imageAlt, siteName }) {
  const t = escapeAttr(title);
  const d = escapeAttr(description);
  return [
    `<title>${escapeText(title)}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta name="robots" content="${escapeAttr(robots)}" />`,
    // Canonical + og:url are per-route. Serving one canonical for all eight URLs
    // (the old behaviour for any non-JS crawl) tells a search engine the whole
    // site is one page.
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeAttr(siteName)}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    `<meta property="og:image" content="${escapeAttr(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeAttr(imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${escapeAttr(image)}" />`,
    `<meta name="twitter:image:alt" content="${escapeAttr(imageAlt)}" />`,
  ]
    .map((line) => `    ${line}`)
    .join('\n');
}

// ---- 1. Bundle the app for Node ------------------------------------------------
// A separate SSR build (not the client bundle) so imports resolve for Node and the
// CSS/asset pipeline is skipped. Vite writes index.js next to the entry name.
log('building SSR bundle');
rmSync(ssrDir, { recursive: true, force: true });
execFileSync(
  'npx',
  ['vite', 'build', '--ssr', 'src/entry-server.tsx', '--outDir', '.ssr-build', '--logLevel', 'warn'],
  { cwd: here, stdio: 'inherit' },
);

const { render, ROUTE_SEO, PRERENDER_PATHS, SITE_URL, OG_IMAGE, SITE_NAME } = await import(
  join(ssrDir, 'entry-server.js')
);

// ---- 2. Render each route into the built shell ---------------------------------
const template = readFileSync(join(dist, 'index.html'), 'utf8');
// Composed from SITE_NAME rather than written out, so the product name lives in
// exactly one place (src/lib/site.ts) across the whole build.
const IMAGE_ALT = `The ${SITE_NAME} timeline dashboard showing pull-request activity across a team’s repositories.`;

let smallest = Infinity;
const written = [];

for (const path of PRERENDER_PATHS) {
  const seo = ROUTE_SEO[path];
  const url = path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`;

  const body = render(path);
  // A render that produces almost nothing means the route resolved to a blank or
  // errored component. Failing here beats shipping an empty page that looks fine
  // in a browser (where JS fills it in) and is empty to everything else.
  if (body.length < 1000) {
    throw new Error(`route ${path} rendered only ${body.length} bytes — expected real content`);
  }

  let html = replaceBetween(
    template,
    SEO_MARKERS,
    seoBlock({ ...seo, url, image: OG_IMAGE, imageAlt: IMAGE_ALT, siteName: SITE_NAME }),
    'seo',
  );
  html = replaceBetween(html, APP_MARKERS, body, 'app');

  // '/' is dist/index.html; '/pricing' is dist/pricing/index.html — the layout
  // @fastify/static resolves directory indexes from, and what the backend's
  // not-found handler looks for when the URL has no trailing slash.
  const outFile = path === '/' ? join(dist, 'index.html') : join(dist, path.slice(1), 'index.html');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html);

  smallest = Math.min(smallest, html.length);
  written.push(path);
  log(`${path.padEnd(14)} → ${(html.length / 1024).toFixed(1)} KB`);
}

// ---- 3. Guardrails --------------------------------------------------------------
// The failure this whole script exists to prevent is silent: a broken prerender
// still produces a site that works perfectly in a browser. These assertions are
// what turn that into a build failure.
if (written.length < 8) {
  throw new Error(`only ${written.length} routes prerendered — expected all 8`);
}
// The floor is on the FINAL html, and it has to clear the un-prerendered shell by
// a real margin to mean anything: index.html plus Vite's asset tags is already
// ~8.3 KB before a single byte of content, so the old 8000 threshold could never
// fire. The smallest genuinely-rendered page is several times this.
if (smallest < 12000) {
  throw new Error(`smallest page is ${smallest} bytes — prerendered content is missing`);
}

// Legacy inbound links (/insights, /reviews) predate the Pro page. They are not in
// ROUTE_SEO (they would be duplicate content in the sitemap), but they should still
// answer with something readable rather than the bare shell, so they get a copy of
// /pro's prerendered HTML — whose canonical already points at /pro, which is exactly
// the signal a search engine needs to collapse the duplicate.
for (const alias of ['insights', 'reviews']) {
  mkdirSync(join(dist, alias), { recursive: true });
  cpSync(join(dist, 'pro', 'index.html'), join(dist, alias, 'index.html'));
}
log('aliased /insights + /reviews → /pro');

rmSync(ssrDir, { recursive: true, force: true });
log(`done — ${written.length} routes + 2 aliases`);
