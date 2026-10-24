import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

export default defineConfig({
  // The Preact preset aliases react / react-dom / react/jsx-runtime to
  // preact/compat, so the source keeps React idioms and the bundle stays small.
  plugins: [preact(), tailwindcss()],
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
    reportCompressedSize: true,
  },
});
