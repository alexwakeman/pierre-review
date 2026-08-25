import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
  plugins: [],
} satisfies Config;
