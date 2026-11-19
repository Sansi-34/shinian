import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 并行开发时每个工作流用 VITE_API_TARGET 指向自己隔离的后端端口，
      // 避免多个 dev server 共用主库。
      '/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:3000',
    },
  },
});