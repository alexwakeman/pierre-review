import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Public marketing landing page (cloud mode). Independent of the timeline SPA;
// served at `/` by the Fastify server for anonymous visitors. A distinct dev
// port keeps it from colliding with the frontend (5173) / backend (4000).
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5174,
    // The contact form is the only thing on this site that talks to the backend, and
    // without this proxy it cannot be developed at all: a bare `fetch('/api/contact/…')`
    // hits Vite, which answers the SPA fallback — 200, with HTML — so the form reads it
    // as "not configured" and renders its unavailable state. That looks like a working
    // failure path rather than a missing proxy, which is exactly the kind of thing that
    // stays broken. In production there is no proxy: Fastify serves both the landing and
    // /api on one origin (see apps/backend/src/app.ts).
    proxy: {
      '/api': {
        // LANDING_API_TARGET so this can be pointed at a backend that is not the default
        // dev one — the demo stack runs on :4100, and a throwaway instance with a test
        // webhook configured is the only way to exercise the form's success path without
        // disturbing whatever is already on :4000.
        target: process.env.LANDING_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
