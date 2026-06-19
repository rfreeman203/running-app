import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: '..', // .env lives in the repo root, not inside frontend/
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/training': 'http://localhost:3000',
    },
  },
});
