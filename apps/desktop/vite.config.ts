// The desktop app's frontend: the shared UI built into dist/, which Tauri bundles into the app (src-tauri/tauri.conf.json,
// build.frontendDist). Tauri serves it from its own protocol and adds its CSP, with the scripts' and styles' hashes.
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  plugins: [react()],
  // `tauri dev` loads the page from here.
  server: { port: 5183, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false
  }
})
