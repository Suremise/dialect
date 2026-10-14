// Imports Vite resolves, here and in @dialect/ui's source, which this package compiles: CSS for its side effect, an
// SVG as its URL (a data: URL in the single-file build).
declare module '*.css'
declare module '*.svg' {
  const url: string
  export default url
}
// A file's text, bundled (the Docs view's documents).
declare module '*?raw' {
  const text: string
  export default text
}
