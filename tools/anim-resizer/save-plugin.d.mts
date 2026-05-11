import type { Plugin } from 'vite';

// Vite plugin that mounts POST /__anim-resizer/save in dev. Writes the
// validated edit payloads back to src/sprites/*.json. Only active when
// `apply: 'serve'`, so it never ships in production builds.
export function animResizerSavePlugin(): Plugin;
