// The UI's state: the source config, its display set result, the theme and transient notices. Display set runs
// synchronously on every change: it parses a 300 KB config in a few tens of milliseconds.
import { displaySet, type DisplaySetResult } from '@dialect/platform-junos'
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
  result: DisplaySetResult
  /** The set lines as one text, without a trailing newline. */
  output: string
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

function derive(source: string): Pick<State, 'result' | 'output' | 'problems'> {
  const result = displaySet(source)
  if (!result.ok) return { result, output: '', problems: [{ severity: 'error', ...result.error }] }
  return {
    result,
    output: result.lines.map((line) => line.text).join('\n'),
    problems: result.warnings.map((w) => ({ severity: 'warning', message: w.message, line: w.line, column: w.column }))
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
