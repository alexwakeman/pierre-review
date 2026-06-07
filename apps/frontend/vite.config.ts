import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.BACKEND_PORT ?? '4000';

export default defineConfig({
  // In production the SPA is served under /app; the API stays at the origin
  // root /api. `base` doesn't affect the dev `/api` proxy below.
  base: '/app/',
  plugins: [react()],
  // Force a SINGLE copy of react-query / query-core across the app and the
  // persist-client + persister packages. Without this, Vite can pre-bundle a
  // second copy (e.g. nested inside react-query-persist-client) → a second React
  // context → "No QueryClient set" even though the provider is mounted.
  resolve: {
    dedupe: ['@tanstack/react-query', '@tanstack/query-core'],
  },
  optimizeDeps: {
    include: [
      '@tanstack/react-query',
      '@tanstack/react-query-persist-client',
      '@tanstack/query-async-storage-persister',
      '@tanstack/query-core',
      'idb-keyval',
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
