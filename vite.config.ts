import { defineConfig } from 'vite';
import { animResizerSavePlugin } from './tools/anim-resizer/save-plugin.mjs';

export default defineConfig({
  base: './',
  // The save plugin self-restricts via `apply: 'serve'` so it's a no-op in
  // production builds — but listing it here at the top level is fine.
  plugins: [animResizerSavePlugin()],
  server: {
    port: 3000,
    open: true
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    // Multi-page setup so /tools/anim-resizer.html ships as its own bundled
    // entry alongside the game. Relative paths are resolved against this
    // config file's directory by Vite.
    rollupOptions: {
      input: {
        main: 'index.html',
        'anim-resizer': 'tools/anim-resizer.html'
      }
    }
  }
});
