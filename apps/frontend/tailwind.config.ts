import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // ── THE REDESIGN'S DESIGN SYSTEM (docs/redesign/DESIGN.md) ─────────────────────────────
      // Tokens live as space-separated RGB channels in index.css (`--ui-*`, flipped in `.dark`),
      // so every colour takes Tailwind's alpha modifier. Contrast is measured in
      // test/designTokens.test.ts. New UI uses ONLY these steps: four type sizes, one radius,
      // two motion durations, two row heights.
      // The four sizes are CSS variables (index.css `--fs-*` / `--lh-*`): the page content reads the
      // larger set, the sidebar (`.type-compact`) the original one.
      fontSize: {
        meta: ['var(--fs-meta)', { lineHeight: 'var(--lh-meta)' }],
        body: ['var(--fs-body)', { lineHeight: 'var(--lh-body)' }],
        title: ['var(--fs-title)', { lineHeight: 'var(--lh-title)', fontWeight: '600' }],
        display: ['var(--fs-display)', { lineHeight: 'var(--lh-display)', fontWeight: '600', letterSpacing: '-0.01em' }],
        // A headline figure: one big number, never prose (docs/redesign/DESIGN.md § 2).
        figure: ['var(--fs-figure)', { lineHeight: 'var(--lh-figure)', fontWeight: '600', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        ui: '6px',
      },
      spacing: {
        row: '36px',
        'row-touch': '44px',
        sidebar: '268px',
        panel: '400px',
      },
      transitionDuration: {
        'ui-fast': '80ms',
        ui: '160ms',
      },
      transitionTimingFunction: {
        ui: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      },
      keyframes: {
        'ui-pop': { from: { opacity: '0', transform: 'scale(0.98)' }, to: { opacity: '1', transform: 'none' } },
        'ui-slide-in': { from: { opacity: '0', transform: 'translateX(8px)' }, to: { opacity: '1', transform: 'none' } },
        'ui-sheet-up': { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'none' } },
        'ui-drawer-in': { from: { transform: 'translateX(-100%)' }, to: { transform: 'none' } },
        'ui-fade': { from: { opacity: '0' }, to: { opacity: '1' } },
        // The toast panel unfolding UP and LEFT from the bottom-right cluster (HeaderToasts.tsx).
        'ui-unfold-up': {
          from: { opacity: '0.4', clipPath: 'inset(calc(100% - 2.5rem) 0 0 calc(100% - 4rem) round 999px)' },
          to: { opacity: '1', clipPath: 'inset(0 0 0 0 round 0.375rem)' },
        },
      },
      animation: {
        'ui-pop': 'ui-pop 140ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        'ui-slide-in': 'ui-slide-in 160ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        'ui-sheet-up': 'ui-sheet-up 180ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        'ui-drawer-in': 'ui-drawer-in 180ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        'ui-fade': 'ui-fade 140ms linear',
        'ui-unfold-up': 'ui-unfold-up 200ms cubic-bezier(0.2, 0.7, 0.2, 1)',
      },
      colors: {
        // The dark PAGE GROUND (`dark:bg-gray-950` and the veils that mimic it) is Claude Code
        // desktop's #191919, the same as --ui-bg in .dark. Extending merges with Tailwind's grays.
        gray: { 950: '#191919' },
        ui: {
          bg: 'rgb(var(--ui-bg) / <alpha-value>)',
          surface: 'rgb(var(--ui-surface) / <alpha-value>)',
          raise: 'rgb(var(--ui-raise) / <alpha-value>)',
          hover: 'rgb(var(--ui-hover) / <alpha-value>)',
          sel: 'rgb(var(--ui-sel) / <alpha-value>)',
          line: 'rgb(var(--ui-line) / <alpha-value>)',
          ink: 'rgb(var(--ui-ink) / <alpha-value>)',
          mute: 'rgb(var(--ui-mute) / <alpha-value>)',
          faint: 'rgb(var(--ui-faint) / <alpha-value>)',
          accent: 'rgb(var(--ui-accent) / <alpha-value>)',
          'accent-fill': 'rgb(var(--ui-accent-fill) / <alpha-value>)',
          'on-accent': 'rgb(var(--ui-on-accent) / <alpha-value>)',
          danger: 'rgb(var(--ui-danger) / <alpha-value>)',
          success: 'rgb(var(--ui-success) / <alpha-value>)',
          warn: 'rgb(var(--ui-warn) / <alpha-value>)',
          scrim: 'rgb(var(--ui-scrim) / <alpha-value>)',
        },
        // Derived-thread-state palette, reused across pills/dots.
        state: {
          untouched: '#ef4444', // red-500
          replied: '#f59e0b', // amber-500
          likely: '#3b82f6', // blue-500
          resolved: '#22c55e', // green-500
        },
        // AI-surface family (Limn landing palette; vars flip in .dark — see index.css).
        ai: {
          surface: 'rgb(var(--ai-surface) / <alpha-value>)',
          'surface-2': 'rgb(var(--ai-surface-2) / <alpha-value>)',
          border: 'rgb(var(--ai-border) / <alpha-value>)',
          hairline: 'rgb(var(--ai-hairline) / <alpha-value>)',
          ink: 'rgb(var(--ai-ink) / <alpha-value>)',
          muted: 'rgb(var(--ai-muted) / <alpha-value>)',
          signal: 'rgb(var(--ai-signal) / <alpha-value>)',
          'signal-fill': 'rgb(var(--ai-signal-fill) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [
    // `touch:` — a coarse pointer (phone, tablet): rows and controls grow to a 40px+ target.
    // ⚠ A VARIANT, NOT A `screens` ENTRY. A raw-media screen silently switches off every `max-*`
    // variant in the app (`max-sm:sr-only` in HeaderToasts, `max-md:hidden` in rows), because
    // Tailwind can only order min-width screens.
    plugin(({ addVariant }) => {
      addVariant('touch', '@media (pointer: coarse)');
    }),
  ],
} satisfies Config;
