// Imports Vite resolves, here and in @dialect/ui's source, which this package compiles: CSS for its side effect, an
// SVG as its URL.
declare module '*.css'
declare module '*.svg' {
  const url: string
  export default url
}
