import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    https: process.env.CALENDAR_DEV ? {
      key: readFileSync('.certs/localhost-key.pem'), cert: readFileSync('.certs/localhost.pem'),
    } : undefined,
    proxy: { '/api': 'http://127.0.0.1:6742', '/healthz': 'http://127.0.0.1:6742' },
  },
});
