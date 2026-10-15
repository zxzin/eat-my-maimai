import { defineConfig } from 'vite';
import { mcpPlugin } from './server/mcp-vite-plugin.js';

export default defineConfig({
  plugins: [mcpPlugin()],
  server: { host: '127.0.0.1', strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/cannon-es/')) return 'physics';
        },
      },
    },
  },
});
