import { gui } from '@opencode/plugin/gui/vite';
import { defineConfig } from 'vite';

// The OpenCode Desktop bundle (`./gui-experimental`): one CommonJS file that keeps the modules the
// app provides external and bundles the rest, zod included.
export default defineConfig({
  plugins: [gui({ entry: 'src/gui/index.tsx', outFile: 'dist/gui-experimental.cjs' })]
});
