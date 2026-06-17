import type { Config } from 'tailwindcss';

// Dark-first marketing palette. Accent stops are pulled from the timeline app's
// signature colors so the landing page feels like the same product. The "brand"
// sky-glow (#38bdf8) is the app's selection/focus highlight — used for the CTA glow.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: '#3b82f6',
          blueDeep: '#2563eb',
          blueDeeper: '#1d4ed8',
          green: '#22c55e',
          sky: '#38bdf8',
          skySoft: '#7dd3fc',
          purple: '#8957e5',
          purpleSoft: '#a78bfa',
          amber: '#f59e0b',
          amberSoft: '#eab308',
          red: '#ef4444',
          // The brand mark's deep navy (favicon background) — used for nav/section tints.
          navy: '#0b1020',
          navySoft: '#111a30',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        // Soft sky glow for the primary CTA, echoing the app's focus highlight.
        'sky-glow': '0 0 0 1px rgba(56,189,248,0.35), 0 8px 40px -8px rgba(56,189,248,0.55)',
      },
    },
  },
  plugins: [],
} satisfies Config;
