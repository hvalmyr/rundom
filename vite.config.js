import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/rundom/
export default defineConfig({
  base: './',
  build: { target: 'es2022' }
});
