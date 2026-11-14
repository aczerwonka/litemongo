import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// In dev, the Fastify server (port 3001) serves /api and /mcp; Vite proxies to it
// so the browser talks to a single origin, exactly like the production container.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // New builds activate on next load; there is no user data in the SW cache to lose.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: '/',
        name: 'LiteMongo',
        short_name: 'LiteMongo',
        description: 'Lightweight, stateless MongoDB dev & jump-host client',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#09090b',
        theme_color: '#09090b',
        categories: ['developer', 'productivity', 'utilities'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell only. Monaco + its workers are large but must
        // work offline (jump hosts often have no internet), so raise the limit.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,ttf}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        // Never serve the SPA shell for API / MCP calls, and never cache them:
        // query results and credential-bearing requests stay network-only.
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/],
        runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp'), handler: 'NetworkOnly' }],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/mcp': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
