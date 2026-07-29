import type { Config } from 'tailwindcss';

// ---------------------------------------------------------------------------
// Limn marketing site — the "Feint" direction, mapped from design_handoff_feint.
//
// THE DESIGN IDEA (do not lose this in a refactor): the site is PRINTED MATTER.
// Warm paper, hairline rules, a serif reading column. No boxes, no shadows, no
// gradients, nothing rounded. Exactly ONE colour exists — vermilion — and it
// means exactly one thing: A HUMAN IS STILL NEEDED. Nothing else may use it.
//
// tokens.css from the handoff is deliberately framework-agnostic; per its README
// it is mapped ONTO this Tailwind theme rather than added alongside as a second
// styling system. So the hexes live here, as literals, exactly like the old
// `brand.*` palette did — there is no CSS-custom-property layer on this site and
// introducing one would be the second system the brief warns against.
//
// Two scales below are FULL OVERRIDES, not extensions (`borderRadius` and
// `boxShadow`). That is deliberate: it deletes `rounded-*` and `shadow-*` from
// the utility set entirely, so "nothing is rounded, no shadows anywhere" becomes
// a build-time fact instead of a code-review convention.
// ---------------------------------------------------------------------------
export default {
  // The site is light-only. `darkMode` was previously 'class' but inert (zero
  // `dark:` variants have ever existed here); the Feint direction is a single
  // paper theme, so the option is gone rather than left as a lie.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Nothing in this direction is rounded — not buttons, not frames, not the
    // terminal panel. Overriding (not extending) makes `rounded-lg` etc. not exist.
    borderRadius: { none: '0', DEFAULT: '0' },
    // "No shadows anywhere. Depth comes from rules and paper tone shifts only."
    boxShadow: { none: 'none' },

    extend: {
      // Two named breakpoints, both taken from the design's responsive rules
      // rather than from Tailwind's defaults, because both are about THIS
      // layout: `rail` is where the 84px section rail stops fitting beside its
      // content and moves above it; `type` is where the display sizes step down.
      screens: {
        type: '700px',
        rail: '1080px',
      },

      colors: {
        paper: '#FAFAF8',
        'paper-alt': '#F4F4EF',

        'rule-hair': '#EDEDE8',
        rule: '#E2E2DC',
        'rule-strong': '#DCDCD6',

        ink: '#16161A',
        // NOTE: tokens.json calls these `body` and `body-soft`. They are renamed
        // here on purpose. Tailwind generates `text-*` utilities from BOTH
        // `colors` and `fontSize`, so a colour named `body` alongside the 19px
        // size named `body` emits two competing `.text-body` rules and one wins
        // silently by source order. Same trap would apply to `muted`/`list`/
        // `price`/`h2`. Do not "tidy" these back to the token names.
        'ink-body': '#2A2A2E',
        'ink-soft': '#3A3A3E',
        muted: '#5A5A5E',
        secondary: '#6A6A65',
        // The nav's resting link colour — the one grey in the design that is not
        // in tokens.json (it sits between `muted` and `ink`).
        'nav-idle': '#4A4A4E',

        // The single signal colour, in its three legal forms. See the a11y note
        // at the bottom of this file — the split is a contrast requirement, not
        // a stylistic one.
        'signal-text': '#C13A20',
        'signal-fill': '#E2492C',
        'signal-on-dark': '#F26B4E',

        'on-dark-primary': '#FAFAF8',
        'on-dark-body': '#DCDCD6',
        'on-dark-secondary': '#9A9A94',
        'on-dark-tertiary': '#A5A5A0',
      },

      fontFamily: {
        // Self-hosted, latin-subset, static cuts — see the @font-face blocks in
        // src/index.css for why these are not fetched from Google.
        display: ['Archivo', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ['Newsreader', 'Georgia', 'Times New Roman', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      // Tailwind's tuple form carries line-height and tracking with the size, so
      // one utility sets all three and the measured scale cannot drift apart.
      fontSize: {
        hero: ['66px', { lineHeight: '1.02', letterSpacing: '-0.032em' }],
        'page-title': ['58px', { lineHeight: '1.03', letterSpacing: '-0.03em' }],
        cta: ['52px', { lineHeight: '1.04', letterSpacing: '-0.03em' }],
        'h2-major': ['44px', { lineHeight: '1.08', letterSpacing: '-0.025em' }],
        h2: ['40px', { lineHeight: '1.1', letterSpacing: '-0.025em' }],
        // The two below-700px steps. The brief is explicit that the hero KEEPS
        // its tracking when it steps down — the tight letterfit is the voice, not
        // an artefact of the size.
        'hero-sm': ['40px', { lineHeight: '1.06', letterSpacing: '-0.032em' }],
        'h2-sm': ['30px', { lineHeight: '1.12', letterSpacing: '-0.025em' }],
        'h2-minor': ['38px', { lineHeight: '1.1', letterSpacing: '-0.025em' }],
        price: ['46px', { lineHeight: '1', letterSpacing: '-0.03em' }],
        h3: ['27px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        h4: ['21px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        'h4-sm': ['20px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        h5: ['22px', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
        lede: ['20px', { lineHeight: '1.55' }],
        body: ['19px', { lineHeight: '1.6' }],
        'body-sm': ['18px', { lineHeight: '1.55' }],
        list: ['17px', { lineHeight: '1.5' }],
        'pull-quote': ['22px', { lineHeight: '1.45' }],
        'mono-row': ['14px', { lineHeight: '1.4' }],
        'mono-data': ['15px', { lineHeight: '1.5' }],
        'mono-term': ['19px', { lineHeight: '1.4' }],
        'mono-nav': ['13px', { lineHeight: '1.7' }],
        'mono-caption': ['12px', { lineHeight: '1.65' }],
        'mono-label': ['11px', { lineHeight: '1.6', letterSpacing: '0.14em' }],
        'mono-label-wide': ['11px', { lineHeight: '1.6', letterSpacing: '0.16em' }],
      },

      spacing: {
        gutter: '56px',
        rail: '84px',
        'grid-gutter': '40px',
        'section-y': '72px',
        'section-y-lg': '80px',
        'hero-y': '88px',
      },

      maxWidth: {
        canvas: '1280px',
        // Reading measures from tokens.json's type rules: "Reading column caps at
        // 60–66ch; list items at 74ch."
        lede: '60ch',
        reassure: '66ch',
        answer: '74ch',
        caption: '84ch',
      },

      gridTemplateColumns: {
        // The section pattern: an 84px rail holding a two-line mono label, then
        // one or two content columns.
        rail: '84px 1fr 1fr',
        'rail-1': '84px 1fr',
        // The hero: copy, then the 300px "Works with" vendor rail.
        hero: '1fr 300px',
      },

      borderWidth: {
        // The nav's active-item underline.
        2: '2px',
      },

      transitionDuration: {
        hover: '120ms',
        disclosure: '160ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
      },

      keyframes: {
        // The terminal block cursor. steps(1, end) = a hard on/off, no fade —
        // it is imitating a real cursor, not decorating.
        'limn-caret': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
      },
      animation: {
        'limn-caret': 'limn-caret 1.1s steps(1, end) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;

// ---------------------------------------------------------------------------
// ACCESSIBILITY CONTRACT (measured ratios from design_handoff_feint/tokens.json)
//
//   ink        on paper — 16.4:1
//   ink-body   on paper — 13.8:1
//   secondary  on paper —  5.3:1   ← the floor for small grey text on paper
//   signal-text on paper — 4.6:1   ← ALL vermilion text, and any vermilion fill
//                                     that carries text (i.e. buttons)
//   signal-fill on paper — 3.85:1  ← NON-TEXT ONLY. Hairlines, rules, sprite
//                                     accents, 24px+ display type. It may never
//                                     carry text nor sit behind text.
//   on-dark-secondary   —  6.3:1   ← the floor for small text inside #16161A panels
//
// Body copy is never below 17px. If the signal colour is ever re-tinted, BOTH
// the text pairing and the button-fill pairing must be re-checked.
// ---------------------------------------------------------------------------
