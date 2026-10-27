import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/rundom/
export default defineConfig({
  base: './',
  // MapLibre (~1 MB) lives in its own lazy chunk on purpose
  build: { target: 'es2022', chunkSizeWarningLimit: 1100 }
});
