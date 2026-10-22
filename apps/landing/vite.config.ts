import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Public marketing site. Independent of the timeline SPA; served at `/` by the tiny
// site service in apps/site (which also serves the demo at /demo/ and the contact
// form's API). A distinct dev port keeps it from colliding with the frontend (5173).
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5174,
    // The contact form is the only thing on this site that talks to a server, and
    // without this proxy it cannot be developed at all: a bare `fetch('/api/contact/…')`
    // hits Vite, which answers the SPA fallback — 200, with HTML — so the form reads it
    // as "not configured" and renders its unavailable state. That looks like a working
    // failure path rather than a missing proxy, which is exactly the kind of thing that
    // stays broken. Run `pnpm --filter @pierre-review/site dev` beside this. In
    // production there is no proxy: apps/site serves the pages and /api on one origin.
    proxy: {
      '/api': {
        // LANDING_API_TARGET points it at a site service on another port — e.g. a
        // throwaway one with a test webhook configured, to exercise the success path.
        target: process.env.LANDING_API_TARGET ?? 'http://127.0.0.1:4300',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
