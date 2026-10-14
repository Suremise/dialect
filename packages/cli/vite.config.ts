// Builds the dialect command: by default one ES module, dist/dialect.mjs, run by Node 24; with `--mode sea`, one
// CommonJS script, dist/sea/dialect.cjs, that scripts/build-exe.mjs makes into the standalone dialect.exe (a Node single
// executable application runs one CommonJS script). Everything it imports from the workspace (the plugins, the core) is
// bundled in; Node's own modules stay imports.
import { builtinModules } from 'module'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  const sea = mode === 'sea'
  return {
    build: {
      ssr: sea ? 'src/sea.ts' : 'src/bin.ts',
      target: 'node24',
      outDir: sea ? 'dist/sea' : 'dist',
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        output: sea ? { entryFileNames: 'dialect.cjs', format: 'cjs' } : { entryFileNames: 'dialect.mjs', format: 'es', banner: '#!/usr/bin/env node' }
      }
    },
    ssr: { noExternal: true, target: 'node' }
  }
})
