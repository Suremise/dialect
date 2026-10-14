// Imports Vite resolves: an SVG as its URL (inlined as a data: URL in the single-file build), CSS for its side effect.
declare module '*.svg' {
  const url: string
  export default url
}
declare module '*.css'
// A file's text, bundled (the Docs view's documents).
declare module '*?raw' {
  const text: string
  export default text
}
