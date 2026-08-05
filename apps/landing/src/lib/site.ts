// ---------------------------------------------------------------------------
// The identity layer.
//
// The design bundle requires the product name to live in exactly ONE place,
// read by exactly one component (<Wordmark/>), so that a rename is a one-line
// change and nothing in the visual system depends on the letterforms. This is
// that place. Everything user-visible — the wordmark, the SEO titles, the
// JSON-LD, the footer © line — composes from SITE_NAME.
//
// SCOPE OF THE CURRENT RENAME (Pierre → Limn), deliberately staged:
//
//   IN  — every user-visible string: this site, the SPA's chrome, the CLI banner,
//         and the re-captured screenshots.
//   OUT — the published/runtime identifiers, which are migrations rather than
//         text edits and ship separately:
//           · the npm package `pierre-review` and its `npx` invocation
//           · the domain pierre-review.com (Safe Browsing + Search Console
//             verification is per-domain and non-transferable, and both OAuth
//             callback URLs are registered against it)
//           · the `pierre_session` / `pierre_oauth_state` cookies
//           · ~/.pierre-review/ (holds every local install's DB and API key)
//           · the ~20 `pierre:*` localStorage keys, one of which is shared with
//             the SPA bundle to carry cookie consent across the two apps
//           · the AutomatedReviewerKind `'pierre'` — a persisted DB value AND a
//             live, 400-validated API path segment
//           · `<!-- pierre:claude-review v=1 -->`, which is stamped into GitHub
//             review bodies we do not control, permanently
//
// So: while this file says "Limn", `npx pierre-review` remains the true command
// and is rendered as such. That mismatch is expected until tranche two lands —
// do not "fix" it by editing the command string in copy.
// ---------------------------------------------------------------------------

/** The product name. The one value the identity layer reads. */
export const SITE_NAME = 'Limn';

/**
 * The published npm package, and therefore the literal command in copy.
 * NOT derived from SITE_NAME on purpose — see the note above.
 */
export const NPM_PACKAGE = 'pierre-review';

/** The install command as it appears on the site. */
export const INSTALL_COMMAND = `npx ${NPM_PACKAGE}`;

/** The public source repository. */
export const REPO_URL = 'https://github.com/alexwakeman/pierre-review';

/**
 * The arcade game ("Inbox Invaders") entry points — the hero's game bar and the
 * footer link.
 *
 * ON: the game exists. /arcade is a real, prerendered marketing route (it is in
 * ROUTE_SEO, and therefore in PRERENDER_PATHS and the sitemap), so the "Play →"
 * link under the primary CTA resolves to a page rather than a 404.
 *
 * This stays a flag rather than being inlined because the game is deliberately
 * subordinate: it is the one piece of the site that can be pulled from the
 * marketing surface — hero bar and footer link both — without touching layout,
 * copy or the route itself. The route keeps working when this is false; only the
 * invitations to it disappear.
 */
export const ARCADE_ENABLED = true;

/** Where the game lives. */
export const ARCADE_PATH = '/arcade';

/**
 * Which H1 the homepage hero runs.
 *
 *   'calm'   — "Calm above the noise." The slogan form: what the product gives
 *              you, above the churn of multi-repo, multi-bot GitHub work.
 *   'signal' — "Your review bot flags 40 things. Limn shows you the 3 that
 *              matter." The proven concrete form, with the vermilion numeral.
 *
 * Both variants live in Home.tsx; this flag is the only switch. It is manual
 * and deliberate — a static, prerendered site has no A/B machinery, and the
 * two H1s make the same argument at different altitudes. Flip, rebuild, ship.
 */
export const HERO_VARIANT: 'calm' | 'signal' = 'calm';
