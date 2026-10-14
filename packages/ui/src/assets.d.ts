// Imports Vite resolves: an SVG as its URL (inlined as a data: URL in the single-file build), CSS for its side effect.
declare module '*.svg' {
  const url: string
  export default url
}
declare module '*.css'
