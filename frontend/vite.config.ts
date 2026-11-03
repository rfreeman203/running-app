import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: '..', // .env lives in the repo root, not inside frontend/
  server: {
    host: true,
    port: 5173,
    // remote phone testing via an ngrok/cloudflared tunnel to http://localhost:5173
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.trycloudflare.com'],
    proxy: {
      '/auth': 'http://localhost:3000',
      '/training': 'http://localhost:3000',
    },
  },
});
