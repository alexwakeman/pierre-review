import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type BuildOptions, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.BACKEND_PORT ?? '4000';
// ⚠ THE SAME ENV VAR THE BACKEND READS. config.ts builds the SPA's browser-facing base
// (`appWebUrl`, the root of the Slack digest's deep links) as
// `http://localhost:${FRONTEND_PORT ?? 5173}` whenever it is not serving the SPA itself — so this
// port and that link must move together. Reading one variable in both places is what makes that
// true; a hardcoded port here would drift silently into a 404 in someone's Slack channel.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT ?? 5173);

const BUILD: BuildOptions = {
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
};

// THE STATIC DEMO (`vite build --mode demo`, `pnpm build:demo`): the same app under /demo/, built
// from src/demo/entry.ts instead of src/main.tsx. That entry answers every /api request in the
// browser from a recording (src/demo/README.md). Every difference from the normal build lives in
// this function, so `vite build` without the mode is untouched by the demo.
const DEMO_RECORDING_ID = 'virtual:limn-demo-recording';
function limnDemo(): Plugin {
  const data = (name: string): string => fileURLToPath(new URL(`./src/demo/data/${name}`, import.meta.url));
  return {
    name: 'limn-demo',
    // The real recording when it has been made, else the hand-written sample.
    resolveId(id) {
      if (id !== DEMO_RECORDING_ID) return null;
      const real = data('recording.json');
      return existsSync(real) ? real : data('sample-recording.json');
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html
          .replace('src="/src/main.tsx"', 'src="/src/demo/entry.ts"')
          .replace('<title>Limn</title>', '<title>Limn demo</title>'),
    },
  };
}

export default defineConfig(({ mode }) => ({
  // In production the SPA is served under /app; the API stays at the origin
  // root /api. `base` doesn't affect the dev `/api` proxy below.
  ...(mode === 'demo'
    ? {
        base: '/demo/',
        build: { ...BUILD, outDir: 'dist-demo' },
        define: { 'import.meta.env.VITE_LIMN_DEMO': JSON.stringify('1') },
      }
    : { base: '/app/', build: BUILD }),
  plugins: mode === 'demo' ? [react(), limnDemo()] : [react()],
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
    port: FRONTEND_PORT,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
}));
