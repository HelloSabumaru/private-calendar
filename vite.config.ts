import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? './' : '/',
  build: { outDir: mode === 'demo' ? 'dist/demo' : 'dist/client' },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    https: mode !== 'demo' && process.env.CALENDAR_DEV ? {
      key: readFileSync('.certs/localhost-key.pem'), cert: readFileSync('.certs/localhost.pem'),
    } : undefined,
    proxy: mode === 'demo' ? undefined : { '/api': 'http://127.0.0.1:6742', '/healthz': 'http://127.0.0.1:6742' },
  },
}));
