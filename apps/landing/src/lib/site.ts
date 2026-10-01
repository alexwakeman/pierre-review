// ---------------------------------------------------------------------------
// The identity layer.
//
// The design bundle requires the product name to live in exactly ONE place,
// read by exactly one component (<Wordmark/>), so that a rename is a one-line
// change and nothing in the visual system depends on the letterforms. This is
// that place. Everything user-visible — the wordmark, the SEO titles, the
// JSON-LD, the footer © line — composes from SITE_NAME.
//
// SCOPE OF THE RENAME (Pierre → Limn), staged in two tranches:
//
//   DONE — every user-visible string: this site, the SPA's chrome, the CLI banner,
//          and the re-captured screenshots. Then, in the release that made Claude
//          Review and AI Fix free, the npm package: `pierre-review` → `limn-review`
//          (bin `limn`, with `pierre-review` kept as a deprecated alias) and the
//          data dir ~/.pierre-review → ~/.limn (moved once, on first boot).
//   OUT  — identifiers that are migrations rather than text edits:
//           · the domain pierre-review.com (Safe Browsing + Search Console
//             verification is per-domain and non-transferable, and both OAuth
//             callback URLs are registered against it)
//           · the `pierre_session` / `pierre_oauth_state` cookies
//           · the ~20 `pierre:*` localStorage keys, one of which is shared with
//             the SPA bundle to carry cookie consent across the two apps
//           · the AutomatedReviewerKind `'pierre'` — a persisted DB value AND a
//             live, 400-validated API path segment
//           · `<!-- pierre:claude-review v=1 -->`, which is stamped into GitHub
//             review bodies we do not control, permanently
//           · the source repository's URL (REPO_URL below)
//
// The command in copy is ALWAYS composed from NPM_PACKAGE below, never typed.
// ---------------------------------------------------------------------------

/** The product name. The one value the identity layer reads. */
export const SITE_NAME = 'Limn';

/**
 * The published npm package, and therefore the literal command in copy.
 * NOT derived from SITE_NAME on purpose — see the note above.
 */
export const NPM_PACKAGE = 'limn-review';

/** The install command as it appears on the site. */
export const INSTALL_COMMAND = `npx ${NPM_PACKAGE}`;

/** The public source repository. */
export const REPO_URL = 'https://github.com/alexwakeman/pierre-review';

// The arcade game ("Inbox Invaders") was removed with the site restructure — the
// route, the page, src/game/ and the hero game bar all went together. It was the
// one surface that spoke to neither of the site's two readers, and a three-page
// site cannot afford a fourth page about something that is not the product.
