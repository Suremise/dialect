// Builds the dialect command into one ES module, dist/dialect.mjs, run by Node 24. Everything it imports from the
// workspace (the Junos plugin, the core) is bundled in; Node's own modules stay imports.
import { builtinModules } from 'module'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/bin.ts',
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { entryFileNames: 'dialect.mjs', format: 'es', banner: '#!/usr/bin/env node' }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
