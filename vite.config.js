import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_TIME__: Date.now() },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4747' } },
});
