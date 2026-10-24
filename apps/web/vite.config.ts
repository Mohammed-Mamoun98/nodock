import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/auth': API,
      '/webhooks': API,
      '/internal': API,
      '/healthz': API,
      '/metrics-lite': API,
    },
  },
  build: {
    target: 'es2022',
    // Keep the initial payload honest: the budget lives in the plan (≤120 KB gz).
    reportCompressedSize: true,
  },
});
