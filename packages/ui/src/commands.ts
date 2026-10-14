// Every command the menus and the shortcuts run, with its keybinding, in one registry (Hive's commands.ts, smaller).
// The menu bar lists commands by id; the window's keydown handler finds the command a key combination belongs to.
import { copyOutput, editHistory, exit, openFile, paste, saveOutput } from './actions'
import { DOCS, type DocId } from './help/docs'
import { useHelp } from './help/state'
import type { Platform } from './platform'
import { activeConversion, useStore, type ThemeChoice } from './store'

export interface Command {
  id: string
  label: string
  /**
   * Its shortcuts, as "Mod+Shift+S" ("Mod" is Ctrl); the first is shown in the menus. A browser keeps some for its
   * own tabs (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1…9), so those commands have `webKeys` too, shown first in the web build.
   */
  keys?: string[]
  webKeys?: string[]
  /** Shown in the menus but left to the focused editor, which has its own (Undo, Redo). */
  editorKeys?: boolean
  run: () => unknown
  /** Greyed out in the menus, and not run, while this says no. */
  enabled?: () => boolean
  /** A choice in a group (the theme): ticked in the menus while it holds. */
  checked?: () => boolean
  /** What it does, on hover in the menus. */
  tip?: string
}

const state = useStore.getState
const hasConversion = (): boolean => !!activeConversion(state())
const hasOutput = (): boolean => !!activeConversion(state())?.output
const hasTab = (): boolean => state().activeId !== null

const theme = (choice: ThemeChoice, label: string): Command => ({
  id: `view.theme.${choice}`,
  label,
  run: () => state().setTheme(choice),
  checked: () => state().theme === choice
})

const doc = (id: string, page: DocId, keys?: string[]): Command => ({
  id,
  label: DOCS.find((d) => d.id === page)!.label,
  ...(keys ? { keys } : {}),
  run: () => state().openDocs(page)
})

/** The tab at a 1-based place in the strip: Ctrl+1…9. */
const tabAt = (n: number): Command => ({
  id: `window.tab${n}`,
  label: `Tab ${n}`,
  keys: [`Mod+${n}`],
  webKeys: [`Alt+${n}`],
  run: () => {
    const tab = state().tabs[n - 1]
    if (tab) state().activate(tab.id)
  }
})

export function createCommands(platform: Platform): Command[] {
  return [
    { id: 'tab.new', label: 'New Tab…', keys: ['Mod+T'], webKeys: ['Alt+T'], tip: 'Open a tab for a display set or a conversion', run: () => state().setPickerOpen(true) },
    { id: 'file.open', label: 'Open…', keys: ['Mod+O'], tip: 'Open a config file in this tab', run: () => openFile(platform) },
    { id: 'file.save', label: 'Save Output', keys: ['Mod+S'], enabled: hasOutput, tip: "Save this tab's output", run: () => saveOutput(platform) },
    { id: 'file.saveAs', label: 'Save Output As…', keys: ['Mod+Shift+S'], enabled: hasOutput, tip: "Save this tab's output under a new name", run: () => saveOutput(platform, true) },
    { id: 'tab.close', label: 'Close Tab', keys: ['Mod+W', 'Mod+F4'], webKeys: ['Alt+W'], enabled: hasTab, run: () => state().activeId && state().closeTab(state().activeId!) },
    ...(platform.exit ? [{ id: 'app.exit', label: 'Exit', tip: 'Quit Dialect', run: () => exit(platform) }] : []),
    { id: 'edit.undo', label: 'Undo', keys: ['Mod+Z'], editorKeys: true, enabled: hasConversion, run: () => editHistory('undo') },
    { id: 'edit.redo', label: 'Redo', keys: ['Mod+Y'], editorKeys: true, enabled: hasConversion, run: () => editHistory('redo') },
    { id: 'edit.copyOutput', label: 'Copy Output', enabled: hasOutput, tip: "Copy this tab's output to the clipboard", run: () => copyOutput(platform) },
    { id: 'edit.paste', label: 'Paste', enabled: hasConversion, tip: "Replace this tab's source with the clipboard's text", run: () => paste(platform) },
    theme('system', 'System Theme'),
    theme('light', 'Light Theme'),
    theme('dark', 'Dark Theme'),
    { id: 'window.next', label: 'Next Tab', keys: ['Mod+Tab', 'Mod+PageDown'], webKeys: ['Alt+PageDown'], enabled: () => state().tabs.length > 1, run: () => state().cycle(1) },
    { id: 'window.previous', label: 'Previous Tab', keys: ['Mod+Shift+Tab', 'Mod+PageUp'], webKeys: ['Alt+PageUp'], enabled: () => state().tabs.length > 1, run: () => state().cycle(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(tabAt),
    doc('help.guide', 'guide', ['F1']),
    doc('help.changelog', 'changelog'),
    doc('help.license', 'license'),
    doc('help.notices', 'notices'),
    { id: 'help.about', label: 'About Dialect', run: () => useHelp.getState().setAboutOpen(true) }
  ]
}

/** A command's shortcuts in the order this build shows them: the browser-safe ones first in the web build. */
export function keysOf(c: Pick<Command, 'keys' | 'webKeys'>, kind: Platform['kind']): string[] {
  return kind === 'web' ? [...(c.webKeys ?? []), ...(c.keys ?? [])] : [...(c.keys ?? []), ...(c.webKeys ?? [])]
}

/** "Mod+Shift+S" as the menus show it: "Ctrl+Shift+S". */
export const formatKey = (key: string): string => key.replace(/\bMod\b/g, 'Ctrl').replace('PageDown', 'PgDn').replace('PageUp', 'PgUp')

// Physical keys, so Shift doesn't change what a combination is called (Ctrl+Shift+1 stays "1", not "!").
const CODE_KEYS: Record<string, string> = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space' }

/** A key event as a combination ("Mod+Shift+S"), or '' for a lone modifier. */
export function eventToKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const code = e.code ?? ''
  let key: string
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Numpad\d$/.test(code)) key = code.slice(6)
  else if (CODE_KEYS[code]) key = CODE_KEYS[code]
  else key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(key)
  return parts.join('+')
}

/** The command a key event runs, if any: the editors keep Undo and Redo. */
export function matchKey(commands: readonly Command[], e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): Command | undefined {
  const key = eventToKey(e).toUpperCase()
  if (!key) return undefined
  return commands.find((c) => !c.editorKeys && [...(c.keys ?? []), ...(c.webKeys ?? [])].some((k) => k.toUpperCase() === key))
}

/** Runs a command, unless it's disabled now. */
export function runCommand(c: Command | undefined): void {
  if (!c || (c.enabled && !c.enabled())) return
  void Promise.resolve(c.run()).catch((e: Error) => useStore.getState().notify('error', e.message))
}
