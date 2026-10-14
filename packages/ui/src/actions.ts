// What the menus, the shortcuts and the buttons do with the shell: open, drop, paste, copy and save in a tab, load an
// interface map, and Exit. The shell answers later (a dialog, the clipboard, a file being read), and the user may have
// gone to another tab or closed this one meanwhile: so each action takes the tab it started in and puts what comes back
// there, or nowhere if that tab is gone (with a notice), never into whichever tab is shown by then. Each says what went
// wrong in a notice, never with the config's text.
import { parseInterfaceMap } from '@dialect/core'
import { redo, undo } from '@codemirror/commands'
import { editTarget } from './editor/views'
import type { OpenedFile, Platform } from './platform'
import { activeConversion, isUnsaved, outputCount, outputName, useStore, type ConversionTab } from './store'

const store = useStore.getState

/** The conversion tab shown, by id, or null (a Docs tab, or none): the tab an action starts in. */
const startTab = (): string | null => activeConversion(store())?.id ?? null

const GONE = 'The tab was closed before the file was read, so it was left unopened.'

/** Puts an opened or dropped file in the tab the action started in (or a new display set tab, from none). */
function load(tab: string | null, file: OpenedFile): void {
  if (!store().loadSource(tab, file.text, file.name, file.path ?? null)) store().notify('info', GONE)
}

export async function openFile(platform: Platform, tab: string | null = startTab()): Promise<void> {
  try {
    const file = await platform.openFile()
    if (file) load(tab, file)
  } catch (e) {
    store().notify('error', `Couldn't open the file: ${(e as Error).message}`)
  }
}

/** A tab restored without its contents: opens its file again, in that tab. */
export async function reopen(platform: Platform, tabId: string): Promise<void> {
  store().activate(tabId)
  await openFile(platform, tabId)
}

/** A file dropped on the window: read by the shell from the drop event, into the tab it was dropped on. */
export async function dropFile(platform: Platform, data: DataTransfer, tab: string | null = startTab()): Promise<void> {
  try {
    const file = await platform.openDropped(data)
    if (file) load(tab, file)
  } catch (e) {
    store().notify('error', `Couldn't open the dropped file: ${(e as Error).message}`)
  }
}

export async function paste(platform: Platform, tab: string | null = startTab()): Promise<void> {
  if (!tab) return
  let text: string
  try {
    text = await platform.readClipboard()
  } catch {
    store().notify('info', "This browser didn't let Dialect read the clipboard: click in the source pane and press Ctrl+V.")
    if (store().activeId === tab) store().revealAt('source', 1, 1, true)
    return
  }
  if (!store().loadSource(tab, text, null)) store().notify('info', 'The tab was closed before the clipboard was read, so nothing was pasted.')
}

/** Convert's Load map…: names from a map file, added to the tab's own (refused whole if the map has a problem). */
export async function loadInterfaceMap(platform: Platform, tab: string): Promise<void> {
  try {
    const file = await platform.openFile('interface-map')
    if (!file) return
    const { map, problems } = parseInterfaceMap(file.text)
    if (problems.length) return store().notify('error', `${file.name}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`)
    if (!store().mergeInterfaceMap(map, tab)) return store().notify('info', 'The tab was closed before the map was read, so it was left unloaded.')
    const target = store().tabs.find((t): t is ConversionTab => t.id === tab && t.kind === 'conversion')
    const known = new Set((target?.interfaces ?? []).map((i) => i.source))
    const extra = Object.keys(map).filter((name) => !known.has(name)).length
    store().notify('info', `Loaded ${file.name}.${extra ? ` ${extra} of its interfaces aren't in this config.` : ''}`)
  } catch (e) {
    store().notify('error', `Couldn't open the map: ${(e as Error).message}`)
  }
}

export async function copyOutput(platform: Platform): Promise<void> {
  const tab = activeConversion(store())
  if (!tab?.output) return
  try {
    await platform.writeClipboard(tab.output + '\n')
    store().notify('info', `Copied ${outputCount(tab.job, tab.output)}.`)
  } catch (e) {
    store().notify('error', `Couldn't copy the output: ${(e as Error).message}`)
  }
}

/**
 * Saves the tab's output: to where it was saved before this session, where the shell can write there again (the
 * desktop app), else under a name the user picks (`as`, or the first time). True once saved.
 */
export async function saveOutput(platform: Platform, as = false, tab: ConversionTab | undefined = activeConversion(store())): Promise<boolean> {
  if (!tab?.output) return false
  const { id, output } = tab
  try {
    if (!as && tab.savedPath && platform.saveTextTo) {
      await platform.saveTextTo(tab.savedPath, output + '\n')
      store().markSaved(id, output, tab.savedPath)
      return true
    }
    const saved = await platform.saveText(outputName(tab.sourceName, tab.job), output + '\n')
    if (!saved) return false
    store().markSaved(id, output, saved.path ?? null)
    return true
  } catch (e) {
    store().notify('error', `Couldn't save the output: ${(e as Error).message}`)
    return false
  }
}

/** File → Exit: quits, once the user agrees to lose any unsaved output (the exit dialog). */
export async function exit(platform: Platform, force = false): Promise<void> {
  if (!platform.exit) return
  if (!force && store().tabs.some(isUnsaved)) return store().setExiting(true)
  store().setExiting(false)
  try {
    await platform.exit()
  } catch (e) {
    store().notify('error', `Couldn't exit: ${(e as Error).message}`)
  }
}

/** Edit → Undo and Redo: in the active tab's editor last focused, or its source. */
export function editHistory(which: 'undo' | 'redo'): void {
  const id = store().activeId
  const view = id && activeConversion(store()) ? editTarget(id) : undefined
  if (!view) return
  if (which === 'undo') undo(view)
  else redo(view)
  view.focus()
}
