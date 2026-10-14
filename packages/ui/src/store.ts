// The UI's state: the source config, its display set result, the theme and transient notices. Display set runs
// synchronously on every change, as the Junos plugin's tool in the core's registry: it parses a 300 KB config in a few
// tens of milliseconds.
import { createRegistry, type Tool } from '@dialect/core'
import junos from '@dialect/platform-junos'
import { create } from 'zustand'

export type ThemeChoice = 'system' | 'light' | 'dark'

/** One row of the problems panel: the parse error, or a warning. */
export interface Problem {
  severity: 'error' | 'warning'
  message: string
  line: number
  column: number
}

/** A request to show a place in an editor; `seq` makes the same place requested twice count twice. */
export interface Reveal {
  pane: 'source' | 'output'
  line: number
  column: number
  focus: boolean
  seq: number
}

export interface Notice {
  kind: 'info' | 'error'
  text: string
  seq: number
}

export interface State {
  source: string
  /** The opened file's name, or null for pasted or typed text. */
  sourceName: string | null
  /** The set lines as one text, without a trailing newline. */
  output: string
  /** The 1-based source line of each output line, for linking the panes. */
  sourceLines: readonly number[]
  problems: Problem[]
  theme: ThemeChoice
  reveal: Reveal | null
  notice: Notice | null
  /**
   * The source as typed (no name given), or as opened, dropped or pasted (a name, or null for pasted text). Opened and
   * pasted text loses a leading byte order mark; typed text is kept as it is, so the editor's cursor doesn't move.
   */
  setSource: (source: string, sourceName?: string | null) => void
  setTheme: (theme: ThemeChoice) => void
  revealAt: (pane: Reveal['pane'], line: number, column?: number, focus?: boolean) => void
  notify: (kind: Notice['kind'], text: string) => void
  dismissNotice: () => void
}

const THEME_KEY = 'dialect.theme'

function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function displaySetTool(): Tool {
  const found = createRegistry([junos])
    .tools()
    .find((t) => t.plugin.id === 'junos' && t.tool.id === 'display-set')
  if (!found) throw new Error('The Junos plugin has no display set tool.')
  return found.tool
}

const displaySet = displaySetTool()

function derive(source: string): Pick<State, 'output' | 'sourceLines' | 'problems'> {
  const result = displaySet.run(source)
  return {
    output: result.text.endsWith('\n') ? result.text.slice(0, -1) : result.text,
    sourceLines: result.sourceLines ?? [],
    // Display set gives errors and warnings only, each at a point.
    problems: result.diagnostics.map((d) => ({
      severity: d.severity === 'error' ? 'error' : 'warning',
      message: d.message,
      line: d.span?.startLine ?? 1,
      column: d.span?.startColumn ?? 1
    }))
  }
}

let seq = 0

const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export const useStore = create<State>()((set) => ({
  source: '',
  sourceName: null,
  ...derive(''),
  theme: storedTheme(),
  reveal: null,
  notice: null,
  setSource: (source, sourceName) => {
    if (sourceName === undefined) return set({ source, ...derive(source) })
    const text = withoutBom(source)
    set({ source: text, sourceName, ...derive(text) })
  },
  setTheme: (theme) => {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, theme)
    } catch {
      // No storage (a locked-down browser): the choice lasts until the page is closed.
    }
    set({ theme })
  },
  revealAt: (pane, line, column = 1, focus = true) => set({ reveal: { pane, line, column, focus, seq: ++seq } }),
  notify: (kind, text) => set({ notice: { kind, text, seq: ++seq } }),
  dismissNotice: () => set({ notice: null })
}))

/** The name to save the output under: the source's name with `.set`, or `display-set.set`. */
export function outputName(sourceName: string | null): string {
  if (!sourceName) return 'display-set.set'
  const dot = sourceName.lastIndexOf('.')
  return `${dot > 0 ? sourceName.slice(0, dot) : sourceName}.set`
}
