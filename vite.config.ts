import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        stage: resolve(__dirname, 'src/renderer/stage.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
