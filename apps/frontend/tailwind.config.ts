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
      },
    },
  },
  plugins: [],
} satisfies Config;
