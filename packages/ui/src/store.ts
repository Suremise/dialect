// The UI's state: the mode, the source config and what it gives in that mode (display set, or a conversion), the
// interface map, the theme and transient notices. Both modes run synchronously on every change, through the core's
// registry: display set as the Junos plugin's tool, convert as the core's convert() from Junos to the chosen target. A
// 300 KB config takes a few tens of milliseconds.
import { convert, createRegistry, interfaceInputs, type Conversion, type ConversionIssue, type InterfaceMap, type PlatformPlugin, type Tool } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import junos from '@dialect/platform-junos'
import { create } from 'zustand'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Mode = 'display-set' | 'convert'

/** One row of the problems panel: the parse error, a warning, or what didn't carry over in a conversion. */
export interface Problem {
  severity: 'error' | 'warning'
  message: string
  /** Where in the source; absent for a problem with no place (two interfaces given one name). */
  line?: number
  column?: number
}

/** One row of the interface table: an interface the source names, and its name on the target. */
export interface InterfaceRow {
  source: string
  /** The user's name for it; absent while it has none (or two were given one name). */
  target?: string
  /** The target plugin's suggestion, used only when the user takes it. */
  suggestion?: string
  /** The source line that configures or names it. */
  line?: number
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

/** What the source gives in the current mode. */
interface Derived {
  /** The output as one text, without a trailing newline. */
  output: string
  /** Display set: the 1-based source line of each output line. */
  sourceLines: readonly number[]
  /** Linked lines, as [source line, output line] pairs, for marking one pane's lines from the other's cursor. */
  links: readonly (readonly [number, number])[]
  problems: Problem[]
  /** Convert: the interfaces and their names. Empty in display set. */
  interfaces: InterfaceRow[]
}

export interface State extends Derived {
  mode: Mode
  /** The plugin convert renders with. */
  targetId: string
  source: string
  /** The opened file's name, or null for pasted or typed text. */
  sourceName: string | null
  /** The user's interface names, by source name. Kept while the source is edited; a new file starts without. */
  interfaceMap: InterfaceMap
  theme: ThemeChoice
  reveal: Reveal | null
  notice: Notice | null
  /**
   * The source as typed (no name given), or as opened, dropped or pasted (a name, or null for pasted text). Opened and
   * pasted text loses a leading byte order mark; typed text is kept as it is, so the editor's cursor doesn't move.
   */
  setSource: (source: string, sourceName?: string | null) => void
  setMode: (mode: Mode) => void
  setTarget: (targetId: string) => void
  /** Names an interface on the target; an empty name clears it. */
  setInterfaceName: (source: string, target: string) => void
  /** Takes every suggestion for an interface that has no name yet. */
  takeSuggestions: () => void
  /** Adds a loaded map's names to the current ones. */
  mergeInterfaceMap: (map: InterfaceMap) => void
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

const registry = createRegistry([junos, iosxe])

function displaySetTool(): Tool {
  const found = registry.tools().find((t) => t.plugin.id === 'junos' && t.tool.id === 'display-set')
  if (!found) throw new Error('The Junos plugin has no display set tool.')
  return found.tool
}

const displaySet = displaySetTool()

/** The plugin convert reads: Junos, for now (Junos → IOS-XE first). */
export const SOURCE_PLUGIN: PlatformPlugin = junos

/** The plugins convert can write, other than the source's own. */
export const TARGETS: readonly PlatformPlugin[] = registry.targets().filter((p) => p.id !== SOURCE_PLUGIN.id)

export function targetPlugin(id: string): PlatformPlugin {
  return TARGETS.find((p) => p.id === id) ?? TARGETS[0]
}

/**
 * How many commands a display set holds: set, deactivate and protect alike. A quoted value can hold line breaks (a
 * banner), so one command can be several lines: a line break ends a command only outside quotes, read as Junos's
 * tokenizer reads them (in a quoted string, a backslash escapes the character after it).
 */
export function countCommands(output: string): number {
  if (output === '') return 0
  let commands = 1
  let quoted = false
  for (let i = 0; i < output.length; i++) {
    const c = output[i]
    if (quoted && c === '\\') i++
    else if (c === '"') quoted = !quoted
    else if (c === '\n' && !quoted) commands++
  }
  return commands
}

const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text)

function deriveDisplaySet(source: string): Derived {
  const result = displaySet.run(source)
  const sourceLines = result.sourceLines ?? []
  return {
    output: withoutFinalNewline(result.text),
    sourceLines,
    links: sourceLines.map((line, i) => [line, i + 1] as const),
    // Display set gives errors and warnings only, each at a point.
    problems: result.diagnostics.map((d) => ({
      severity: d.severity === 'error' ? 'error' : 'warning',
      message: d.message,
      line: d.span?.startLine ?? 1,
      column: d.span?.startColumn ?? 1
    })),
    interfaces: []
  }
}

/** What an issue says in the problems panel: the plugin's reason, never the statement's text (it may hold a secret). */
function issueMessage(issue: ConversionIssue, target: PlatformPlugin): string {
  const what = issue.kind === 'unmapped' ? `Not converted: the ${SOURCE_PLUGIN.name} plugin gave this statement no disposition` : issue.kind === 'unsupported' ? 'Not converted' : `Not written for ${target.name}`
  return issue.reason ? `${what}: ${issue.reason}` : what
}

/** The conversion behind the convert mode's state: exported for tests. */
export function conversionOf(source: string, targetId: string, map: InterfaceMap): Conversion {
  return convert(SOURCE_PLUGIN, targetPlugin(targetId), source, { modelVersion: registry.modelVersion, inputs: interfaceInputs(map) })
}

function deriveConvert(source: string, targetId: string, map: InterfaceMap): Derived {
  const target = targetPlugin(targetId)
  const c = conversionOf(source, targetId, map)
  const lineOf = new Map(c.ledger.source.statements.map((s) => [s.id, s.span?.startLine]))
  const links: [number, number][] = []
  for (const l of c.links) {
    const line = lineOf.get(l.statement)
    if (line !== undefined) for (let out = l.output.startLine; out <= l.output.endLine; out++) links.push([line, out])
  }
  const problems: Problem[] = [
    ...c.ledger.diagnostics.map((d): Problem => ({ severity: d.severity === 'error' ? 'error' : 'warning', message: d.message, ...(d.span ? { line: d.span.startLine, column: d.span.startColumn } : {}) })),
    ...(c.render ? c.issues.map((i): Problem => ({ severity: 'warning', message: issueMessage(i, target), ...(i.span ? { line: i.span.startLine, column: i.span.startColumn } : {}) })) : [])
  ]
  return {
    output: c.render ? withoutFinalNewline(c.render.text) : '',
    sourceLines: [],
    links,
    problems,
    interfaces: c.interfaces.map((i) => {
      const line = i.statement ? lineOf.get(i.statement) : undefined
      return { source: i.source, ...(i.target !== undefined ? { target: i.target } : {}), ...(i.suggestion ? { suggestion: i.suggestion } : {}), ...(line !== undefined ? { line } : {}) }
    })
  }
}

function derive(s: Pick<State, 'mode' | 'source' | 'targetId' | 'interfaceMap'>): Derived {
  if (s.source.trim() === '') return { output: '', sourceLines: [], links: [], problems: [], interfaces: [] }
  return s.mode === 'convert' ? deriveConvert(s.source, s.targetId, s.interfaceMap) : deriveDisplaySet(s.source)
}

let seq = 0

const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** A null-prototype copy: interface names are keys, and `__proto__` is an interface name like any other. */
function mapOf(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const map = Object.create(null) as Record<string, string>
  for (const [k, v] of entries) map[k] = v
  return map
}

export const useStore = create<State>()((set, get) => {
  /** Sets `patch` and what the source gives with it. */
  const update = (patch: Partial<Pick<State, 'mode' | 'source' | 'sourceName' | 'targetId' | 'interfaceMap'>>) => {
    const next = { ...get(), ...patch }
    set({ ...patch, ...derive(next) })
  }
  return {
    mode: 'display-set',
    targetId: TARGETS[0].id,
    source: '',
    sourceName: null,
    interfaceMap: mapOf([]),
    output: '',
    sourceLines: [],
    links: [],
    problems: [],
    interfaces: [],
    theme: storedTheme(),
    reveal: null,
    notice: null,
    setSource: (source, sourceName) => {
      if (sourceName === undefined) return update({ source })
      // Another config: its interfaces may be other ports, so no name carries over unasked.
      update({ source: withoutBom(source), sourceName, interfaceMap: mapOf([]) })
    },
    setMode: (mode) => update({ mode }),
    setTarget: (targetId) => update({ targetId: targetPlugin(targetId).id, interfaceMap: mapOf([]) }),
    setInterfaceName: (source, target) => {
      const name = target.trim()
      update({ interfaceMap: mapOf([...Object.entries(get().interfaceMap).filter(([k]) => k !== source), ...(name ? [[source, name] as const] : [])]) })
    },
    takeSuggestions: () => {
      const taken = get().interfaces.flatMap((i) => (i.target === undefined && i.suggestion ? [[i.source, i.suggestion] as const] : []))
      update({ interfaceMap: mapOf([...Object.entries(get().interfaceMap), ...taken]) })
    },
    mergeInterfaceMap: (map) => update({ interfaceMap: mapOf([...Object.entries(get().interfaceMap), ...Object.entries(map)]) }),
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
  }
})

/** The name to save the output under: the source's name with `.set` (display set) or the target's id (convert). */
export function outputName(sourceName: string | null, mode: Mode = 'display-set', targetId: string = TARGETS[0].id): string {
  const extension = mode === 'convert' ? targetId : 'set'
  if (!sourceName) return mode === 'convert' ? `converted.${extension}` : 'display-set.set'
  const dot = sourceName.lastIndexOf('.')
  return `${dot > 0 ? sourceName.slice(0, dot) : sourceName}.${extension}`
}
