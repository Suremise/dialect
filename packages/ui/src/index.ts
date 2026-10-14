// @dialect/ui: the React UI both shells share. A shell renders <App platform={…} /> with its own file and clipboard
// access, and imports the styles once (`@dialect/ui/styles.css`).
export const PACKAGE_NAME = '@dialect/ui'

export { App } from './App'
export type { OpenedFile, Platform } from './platform'
export { outputName, useStore, type Problem, type ThemeChoice } from './store'
