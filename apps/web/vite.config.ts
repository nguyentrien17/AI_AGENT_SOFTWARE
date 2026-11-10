import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server on :5173 proxies the API, so the browser sees one origin (cookies + CSRF check just work).
// Production: `npm run build:web`, then the API serves apps/web/dist at http://127.0.0.1:8787/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
