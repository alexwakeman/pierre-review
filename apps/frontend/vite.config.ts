import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.BACKEND_PORT ?? '4000';

export default defineConfig({
  // In production the SPA is served under /app; the API stays at the origin
  // root /api. `base` doesn't affect the dev `/api` proxy below.
  base: '/app/',
  plugins: [react()],
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
