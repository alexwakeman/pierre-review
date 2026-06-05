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
  },
  build: {
    outDir: 'dist',
  },
});
