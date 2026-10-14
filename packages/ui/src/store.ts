// The UI's state: the open tabs, one per conversion or Docs page, the theme and transient notices. A conversion tab
// holds its job (a plugin's tool, such as Junos display set, or convert from Junos to a target), its source config and
// what that gives (the output, its source lines, the problems and in convert the interface table), and its interface
// map. Every job runs synchronously on every change, through the core's registry: a 300 KB config takes a few tens of
// milliseconds. Config contents live here, in memory, only: session.ts keeps the tabs' jobs and file names for the
// next start, never their text.
import { convert, createRegistry, interfaceInputs, type Conversion, type ConversionIssue, type InterfaceMap, type PlatformPlugin, type Tool } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import junos from '@dialect/platform-junos'
import { create } from 'zustand'
import type { DocId } from './help/docs'
import { loadSession, saveSession } from './session'

export type ThemeChoice = 'system' | 'light' | 'dark'

/** What a conversion tab does: run a plugin's tool (`junos.display-set`), or convert to a target plugin. */
export type Job = { kind: 'tool'; tool: string } | { kind: 'convert'; target: string }

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

/** A request to show a place in one tab's editor; `seq` makes the same place requested twice count twice. */
export interface Reveal {
  tab: string
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

/** What the source gives with the tab's job. */
interface Derived {
  /** The output as one text, without a trailing newline. */
  output: string
  /** A tool's output: the 1-based source line of each output line. */
  sourceLines: readonly number[]
  /** Linked lines, as [source line, output line] pairs, for marking one pane's lines from the other's cursor. */
  links: readonly (readonly [number, number])[]
  problems: Problem[]
  /** Convert: the interfaces and their names. Empty for a tool. */
  interfaces: InterfaceRow[]
}

export interface ConversionTab extends Derived {
  kind: 'conversion'
  id: string
  job: Job
  source: string
  /** The opened file's name, or null for pasted or typed text. */
  sourceName: string | null
  /** The opened file's full path, where the shell knows it (the desktop app): the tab's tooltip. */
  sourcePath: string | null
  /** The user's interface names, by source name. Kept while the source is edited; a new file starts without. */
  interfaceMap: InterfaceMap
  /** The output as last saved: the tab has unsaved output while its output is something else. */
  savedOutput: string
  /** Where Save output writes again without asking (the desktop app, after a save this session). */
  savedPath: string | null
  /** Restored at start-up without its contents: the file to reopen, until a source is opened or typed. */
  reopen: string | null
}

export interface DocsTab {
  kind: 'docs'
  id: string
  page: DocId
}

export type Tab = ConversionTab | DocsTab

export interface State {
  tabs: Tab[]
  /** The tab shown, or null with none open. */
  activeId: string | null
  theme: ThemeChoice
  reveal: Reveal | null
  notice: Notice | null
  /** The new tab picker is open. */
  pickerOpen: boolean
  /** A tab with unsaved output that the user asked to close: the close dialog asks first. */
  closing: string | null
  /** File → Exit was asked with unsaved output: the exit dialog asks first. */
  exiting: boolean

  /** Opens a conversion tab with this job and shows it. */
  newTab: (job: Job) => string
  /** Shows the page's Docs tab, opening it if it isn't open. */
  openDocs: (page: DocId) => void
  activate: (id: string) => void
  /** The next (1) or previous (-1) tab, wrapping round. */
  cycle: (delta: number) => void
  /** Closes a tab; one with unsaved output only when forced, else the close dialog asks. */
  closeTab: (id: string, force?: boolean) => void
  setPickerOpen: (open: boolean) => void
  cancelClose: () => void
  setExiting: (exiting: boolean) => void
  /**
   * The active conversion tab's source, as typed (no name given), or as opened, dropped or pasted (a name, or null for
   * pasted text). Opened and pasted text loses a leading byte order mark; typed text is kept as it is, so the editor's
   * cursor doesn't move. With no conversion tab active, opened text goes into a new display set tab.
   */
  setSource: (source: string, sourceName?: string | null, sourcePath?: string | null) => void
  setJob: (job: Job) => void
  setTarget: (targetId: string) => void
  /** Names an interface on the target; an empty name clears it. */
  setInterfaceName: (source: string, target: string) => void
  /** Takes every suggestion for an interface that has no name yet. */
  takeSuggestions: () => void
  /** Adds a loaded map's names to the current ones. */
  mergeInterfaceMap: (map: InterfaceMap) => void
  /** The tab's output was saved, to `path` where the shell can write there again. */
  markSaved: (id: string, output: string, path: string | null) => void
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

/** The plugin convert reads: Junos, for now (Junos → IOS-XE first; the reverse follows). */
export const SOURCE_PLUGIN: PlatformPlugin = junos

/** The plugins convert can write, other than the source's own. */
export const TARGETS: readonly PlatformPlugin[] = registry.targets().filter((p) => p.id !== SOURCE_PLUGIN.id)

export function targetPlugin(id: string): PlatformPlugin {
  return TARGETS.find((p) => p.id === id) ?? TARGETS[0]
}

/** Every plugin's tools, by `<plugin>.<tool>`. */
export const TOOLS: readonly { key: string; plugin: PlatformPlugin; tool: Tool }[] = registry.tools().map(({ plugin, tool }) => ({ key: `${plugin.id}.${tool.id}`, plugin, tool }))

export const DISPLAY_SET: Job & { kind: 'tool' } = { kind: 'tool', tool: 'junos.display-set' }

/** A display set's output is Junos `set` commands: counted in commands, saved as `.set`. */
const givesSetCommands = (job: Job): boolean => job.kind === 'tool' && job.tool === DISPLAY_SET.tool

export function toolOf(key: string): { plugin: PlatformPlugin; tool: Tool } {
  const found = TOOLS.find((t) => t.key === key) ?? TOOLS.find((t) => t.key === DISPLAY_SET.tool)
  if (!found) throw new Error('The Junos plugin has no display set tool.')
  return found
}

/** What the new tab picker offers: each tool, then convert to each target. New plugins and tools appear here. */
export function jobs(): { job: Job; label: string; detail: string }[] {
  return [
    ...TOOLS.map((t) => ({ job: { kind: 'tool', tool: t.key } as Job, label: `${t.tool.name} (${t.plugin.name})`, detail: (t.tool.description ?? t.tool.name).replaceAll('`', '') })),
    ...TARGETS.map((t) => ({ job: { kind: 'convert', target: t.id } as Job, label: `Convert: ${SOURCE_PLUGIN.name} → ${t.name}`, detail: `A ${SOURCE_PLUGIN.name} config to ${t.name}'s, with the interfaces named on ${t.name}.` }))
  ]
}

/** A platform's short name for a tab title: "Cisco IOS / IOS-XE" → "IOS-XE", "Cisco NX-OS" → "NX-OS". */
export const shortName = (p: PlatformPlugin): string => p.name.split(' / ').at(-1)!.replace(/^Cisco /, '')

/** The job's name: the tool's ("Display set"), or the target's short name. */
export function jobLabel(job: Job): string {
  return job.kind === 'tool' ? toolOf(job.tool).tool.name : shortName(targetPlugin(job.target))
}

export const sameJob = (a: Job, b: Job): boolean => (a.kind === 'tool' && b.kind === 'tool' ? a.tool === b.tool : a.kind === 'convert' && b.kind === 'convert' && a.target === b.target)

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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The output's size, as the summary, the status bar and Copy say it. A display set counts commands, with its lines
 * when a banner's quoted line breaks make one command several lines; anything else counts lines.
 */
export function outputCount(job: Job, output: string): string {
  const lines = output ? output.split('\n').length : 0
  if (!givesSetCommands(job)) return plural(lines, 'line', 'lines')
  const commands = countCommands(output)
  return `${plural(commands, 'command', 'commands')}${commands === lines ? '' : ` (${plural(lines, 'line', 'lines')})`}`
}

const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text)

function deriveTool(source: string, key: string): Derived {
  const result = toolOf(key).tool.run(source)
  const sourceLines = result.sourceLines ?? []
  return {
    output: withoutFinalNewline(result.text),
    sourceLines,
    links: sourceLines.map((line, i) => [line, i + 1] as const),
    // A tool gives errors and warnings only, each at a point.
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

/** The conversion behind a convert tab's state: exported for tests. */
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

function derive(t: Pick<ConversionTab, 'job' | 'source' | 'interfaceMap'>): Derived {
  if (t.source.trim() === '') return { output: '', sourceLines: [], links: [], problems: [], interfaces: [] }
  return t.job.kind === 'convert' ? deriveConvert(t.source, t.job.target, t.interfaceMap) : deriveTool(t.source, t.job.tool)
}

/** The tab has output that hasn't been saved since it last changed. */
export const isUnsaved = (t: Tab): boolean => t.kind === 'conversion' && t.output !== '' && t.output !== t.savedOutput

let seq = 0
let tabSeq = 0
const nextTabId = (): string => `tab-${++tabSeq}`

const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** A null-prototype copy: interface names are keys, and `__proto__` is an interface name like any other. */
function mapOf(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const map = Object.create(null) as Record<string, string>
  for (const [k, v] of entries) map[k] = v
  return map
}

function conversionTab(job: Job, sourceName: string | null = null, reopen: string | null = null): ConversionTab {
  const base = { job, source: '', interfaceMap: mapOf([]) }
  return { kind: 'conversion', id: nextTabId(), ...base, ...derive(base), sourceName, sourcePath: null, savedOutput: '', savedPath: null, reopen }
}

/** A restored job, if this build still has its tool or target; else display set. */
function knownJob(job: Job): Job {
  if (job.kind === 'tool') return TOOLS.some((t) => t.key === job.tool) ? job : DISPLAY_SET
  return TARGETS.some((t) => t.id === job.target) ? job : { kind: 'convert', target: TARGETS[0].id }
}

/** The tabs at start-up: the last session's, without their contents, or one display set tab. */
function startTabs(): Pick<State, 'tabs' | 'activeId'> {
  const session = loadSession()
  const tabs: Tab[] = (session?.tabs ?? []).map((t) => (t.kind === 'docs' ? { kind: 'docs', id: nextTabId(), page: t.page } : conversionTab(knownJob(t.job), t.name, t.name)))
  if (!session) tabs.push(conversionTab(DISPLAY_SET))
  return { tabs, activeId: tabs[Math.min(Math.max(session?.active ?? 0, 0), tabs.length - 1)]?.id ?? null }
}

/** The active tab, if it's a conversion. */
export function activeConversion(s: Pick<State, 'tabs' | 'activeId'>): ConversionTab | undefined {
  const t = s.tabs.find((x) => x.id === s.activeId)
  return t?.kind === 'conversion' ? t : undefined
}

export const useStore = create<State>()((set, get) => {
  /** Applies `patch` to a conversion tab, with what its source gives then. */
  const update = (id: string, patch: Partial<Pick<ConversionTab, 'job' | 'source' | 'sourceName' | 'sourcePath' | 'interfaceMap' | 'reopen'>>): void => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id || t.kind !== 'conversion') return t
        const next = { ...t, ...patch }
        return { ...next, ...derive(next) }
      })
    }))
  }
  const active = (): ConversionTab | undefined => activeConversion(get())
  const close = (id: string): void =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id)
      if (i < 0) return {}
      const tabs = s.tabs.filter((t) => t.id !== id)
      // As in a browser: the tab to its right takes its place, else the one to its left.
      const activeId = s.activeId === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.activeId
      return { tabs, activeId, closing: s.closing === id ? null : s.closing }
    })

  return {
    ...startTabs(),
    theme: storedTheme(),
    reveal: null,
    notice: null,
    pickerOpen: false,
    closing: null,
    exiting: false,
    newTab: (job) => {
      const tab = conversionTab(job)
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, pickerOpen: false }))
      return tab.id
    },
    openDocs: (page) => {
      const open = get().tabs.find((t) => t.kind === 'docs' && t.page === page)
      if (open) return set({ activeId: open.id })
      const tab: DocsTab = { kind: 'docs', id: nextTabId(), page }
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
    },
    activate: (id) => get().tabs.some((t) => t.id === id) && set({ activeId: id }),
    cycle: (delta) => {
      const { tabs, activeId } = get()
      if (tabs.length === 0) return
      const i = tabs.findIndex((t) => t.id === activeId)
      set({ activeId: tabs[(i + delta + tabs.length) % tabs.length].id })
    },
    closeTab: (id, force = false) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (!tab) return
      if (!force && isUnsaved(tab)) return set({ closing: id, activeId: id })
      close(id)
    },
    setPickerOpen: (open) => set({ pickerOpen: open }),
    cancelClose: () => set({ closing: null }),
    setExiting: (exiting) => set({ exiting }),
    setSource: (source, sourceName, sourcePath = null) => {
      let tab = active()
      if (!tab) {
        if (sourceName === undefined) return
        get().newTab(DISPLAY_SET)
        tab = active()!
      }
      if (sourceName === undefined) return update(tab.id, { source, reopen: null })
      // Another config: its interfaces may be other ports, so no name carries over unasked.
      update(tab.id, { source: withoutBom(source), sourceName, sourcePath, interfaceMap: mapOf([]), reopen: null })
    },
    setJob: (job) => {
      const tab = active()
      if (tab) update(tab.id, { job, ...(job.kind === 'convert' ? { interfaceMap: mapOf([]) } : {}) })
    },
    setTarget: (targetId) => get().setJob({ kind: 'convert', target: targetPlugin(targetId).id }),
    setInterfaceName: (source, target) => {
      const tab = active()
      if (!tab) return
      const name = target.trim()
      update(tab.id, { interfaceMap: mapOf([...Object.entries(tab.interfaceMap).filter(([k]) => k !== source), ...(name ? [[source, name] as const] : [])]) })
    },
    takeSuggestions: () => {
      const tab = active()
      if (!tab) return
      const taken = tab.interfaces.flatMap((i) => (i.target === undefined && i.suggestion ? [[i.source, i.suggestion] as const] : []))
      update(tab.id, { interfaceMap: mapOf([...Object.entries(tab.interfaceMap), ...taken]) })
    },
    mergeInterfaceMap: (map) => {
      const tab = active()
      if (tab) update(tab.id, { interfaceMap: mapOf([...Object.entries(tab.interfaceMap), ...Object.entries(map)]) })
    },
    markSaved: (id, output, path) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === 'conversion' ? { ...t, savedOutput: output, savedPath: path ?? t.savedPath } : t)) })),
    setTheme: (theme) => {
      try {
        if (theme === 'system') localStorage.removeItem(THEME_KEY)
        else localStorage.setItem(THEME_KEY, theme)
      } catch {
        // No storage (a locked-down browser): the choice lasts until the page is closed.
      }
      set({ theme })
    },
    revealAt: (pane, line, column = 1, focus = true) => {
      const tab = get().activeId
      if (tab) set({ reveal: { tab, pane, line, column, focus, seq: ++seq } })
    },
    notify: (kind, text) => set({ notice: { kind, text, seq: ++seq } }),
    dismissNotice: () => set({ notice: null })
  }
})

// The session follows the tabs: their jobs, file names and order, never their contents (session.ts).
useStore.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs || s.activeId !== prev.activeId) saveSession(s.tabs, s.activeId)
})

/** A tab's title: its file name (or Untitled) and its job, "phase1.conf → IOS-XE"; a Docs page's name. */
export function tabTitle(t: Tab, docLabel: (page: DocId) => string): string {
  return t.kind === 'docs' ? docLabel(t.page) : `${t.sourceName ?? 'Untitled'} → ${jobLabel(t.job)}`
}

/** The name to save the output under: the source's name with `.set` (a display set) or the target's id (convert). */
export function outputName(sourceName: string | null, job: Job = DISPLAY_SET): string {
  const extension = job.kind === 'convert' ? job.target : givesSetCommands(job) ? 'set' : 'txt'
  if (!sourceName) return job.kind === 'convert' ? `converted.${extension}` : job.tool === DISPLAY_SET.tool ? 'display-set.set' : `output.${extension}`
  const dot = sourceName.lastIndexOf('.')
  return `${dot > 0 ? sourceName.slice(0, dot) : sourceName}.${extension}`
}
