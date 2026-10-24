import type { Config } from 'tailwindcss';

// The landing site is styled by board.css and page-scoped CSS files, not by
// Tailwind utilities. Tailwind stays for its preflight reset (src/index.css), so
// the theme is left at its defaults; the old "Feint" paper tokens were removed
// with the paper pages.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
