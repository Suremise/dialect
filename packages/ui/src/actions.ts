// What the menus, the shortcuts and the buttons do with the shell: open, paste, copy and save in the active tab, and
// Exit. Each says what went wrong in a notice, never with the config's text.
import { redo, undo } from '@codemirror/commands'
import { editTarget } from './editor/views'
import type { Platform } from './platform'
import { activeConversion, isUnsaved, outputCount, outputName, useStore, type ConversionTab } from './store'

const store = useStore.getState

export async function openFile(platform: Platform): Promise<void> {
  try {
    const file = await platform.openFile()
    if (file) store().setSource(file.text, file.name, file.path ?? null)
  } catch (e) {
    store().notify('error', `Couldn't open the file: ${(e as Error).message}`)
  }
}

/** A tab restored without its contents: opens its file again, in that tab. */
export async function reopen(platform: Platform, tabId: string): Promise<void> {
  store().activate(tabId)
  await openFile(platform)
}

export async function paste(platform: Platform): Promise<void> {
  if (!activeConversion(store())) return
  try {
    store().setSource(await platform.readClipboard(), null)
  } catch {
    store().notify('info', "This browser didn't let Dialect read the clipboard: click in the source pane and press Ctrl+V.")
    store().revealAt('source', 1, 1, true)
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
