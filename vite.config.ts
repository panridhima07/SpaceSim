import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two pages: the rocket builder (index.html) and the Moon landing view (landing.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html'),
      },
    },
  },
});
