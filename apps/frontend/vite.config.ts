import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.BACKEND_PORT ?? '4000';
// ⚠ THE SAME ENV VAR THE BACKEND READS. config.ts builds the SPA's browser-facing base
// (`appWebUrl`, the root of the Slack digest's deep links) as
// `http://localhost:${FRONTEND_PORT ?? 5173}` whenever it is not serving the SPA itself — so this
// port and that link must move together. Reading one variable in both places is what makes that
// true; a hardcoded port here would drift silently into a 404 in someone's Slack channel.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT ?? 5173);

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
  build: {
    rollupOptions: {
      output: {
        // Split the heaviest third-party libs into their own long-cacheable chunks so
        // (a) they aren't re-downloaded when app code changes, and (b) they load in
        // parallel. vis-timeline (the board), highlight.js/lowlight (code highlighting),
        // and the react-markdown/remark/rehype stack are the three big ones. Behaviour is
        // unchanged — this only regroups chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/vis-timeline|vis-data|vis-util|keycharm/.test(id)) return 'vis';
          if (/highlight\.js|lowlight|rehype-highlight/.test(id)) return 'highlight';
          if (/react-markdown|remark|rehype|micromark|mdast|hast|unist|property-information|hastscript|vfile/.test(id))
            return 'markdown';
          if (id.includes('@tanstack')) return 'tanstack';
          return undefined;
        },
      },
    },
  },
  server: {
    port: FRONTEND_PORT,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
