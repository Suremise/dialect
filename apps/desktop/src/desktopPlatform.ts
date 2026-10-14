// The desktop app's file and clipboard access. Open and save go through Tauri's dialog and fs plugins: the fs plugin has
// no scope of its own (src-tauri/capabilities), so it reads and writes only the files the user picks in a dialog, which
// the dialog plugin adds to its scope. A dropped file is read from the drop event, as in the web build: the window
// leaves drops to the page (dragDropEnabled: false in tauri.conf.json), so the UI's drop handler gets the file.
import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { OpenedFile, Platform } from '@dialect/ui'

const FILTERS = [
  { name: 'Configs', extensions: ['conf', 'cfg', 'txt', 'junos'] },
  { name: 'All files', extensions: ['*'] }
]

/** The file name at the end of a Windows or POSIX path. */
export const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

export const desktopPlatform: Platform = {
  async openFile(): Promise<OpenedFile | null> {
    const path = await open({ multiple: false, directory: false, filters: FILTERS })
    if (typeof path !== 'string') return null
    return { name: baseName(path), text: await readTextFile(path) }
  },
  openDropped(data) {
    // Taken now: the drop event's files are only there while it's being handled.
    const file = data.files[0]
    if (!file) return Promise.resolve(null)
    return file.text().then((text) => ({ name: file.name, text }))
  },
  async saveText(suggestedName, text) {
    const path = await save({ defaultPath: suggestedName, filters: FILTERS })
    if (!path) return
    await writeTextFile(path, text)
  },
  async readClipboard() {
    if (!navigator.clipboard?.readText) throw new Error('no clipboard API')
    return navigator.clipboard.readText()
  },
  async writeClipboard(text) {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard API')
    await navigator.clipboard.writeText(text)
  }
}
