// The desktop app's file and clipboard access. Open and save go through Tauri's dialog and fs plugins: the fs plugin has
// no scope of its own (src-tauri/capabilities), so it reads and writes only the files the user picks in a dialog, which
// the dialog plugin adds to its scope. A dropped file is read from the drop event, as in the web build: the window
// leaves drops to the page (dragDropEnabled: false in tauri.conf.json), so the UI's drop handler gets the file. Links
// open in the default browser through the opener plugin, which the capability allows for https URLs only. File → Exit
// closes the window (core:window:allow-close), which quits the app.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { FileKind, OpenedFile, Platform } from '@dialect/ui'
// Dialect's version: the repo's (Vite keeps only this field).
import { version } from '../../../package.json'

/** The dialogs' file types, by what the file holds: an interface map is `from,to` lines or JSON. */
export const FILTERS: Record<FileKind, { name: string; extensions: string[] }[]> = {
  config: [
    { name: 'Configs', extensions: ['conf', 'cfg', 'txt', 'junos', 'set', 'iosxe'] },
    { name: 'All files', extensions: ['*'] }
  ],
  'interface-map': [
    { name: 'Interface maps', extensions: ['csv', 'json', 'txt'] },
    { name: 'All files', extensions: ['*'] }
  ]
}

/** The file name at the end of a Windows or POSIX path. */
export const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

export const desktopPlatform: Platform = {
  kind: 'desktop',
  version,
  async openFile(kind = 'config'): Promise<OpenedFile | null> {
    const path = await open({ multiple: false, directory: false, filters: FILTERS[kind] })
    if (typeof path !== 'string') return null
    return { name: baseName(path), text: await readTextFile(path), path }
  },
  openDropped(data) {
    // Taken now: the drop event's files are only there while it's being handled.
    const file = data.files[0]
    if (!file) return Promise.resolve(null)
    return file.text().then((text) => ({ name: file.name, text }))
  },
  async saveText(suggestedName, text, kind = 'config') {
    const path = await save({ defaultPath: suggestedName, filters: FILTERS[kind] })
    if (!path) return null
    await writeTextFile(path, text)
    return { path }
  },
  async saveTextTo(path, text) {
    // A path the dialog gave this session, so the fs plugin's scope still has it.
    await writeTextFile(path, text)
  },
  async readClipboard() {
    if (!navigator.clipboard?.readText) throw new Error('no clipboard API')
    return navigator.clipboard.readText()
  },
  async writeClipboard(text) {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard API')
    await navigator.clipboard.writeText(text)
  },
  async openLink(url) {
    await openUrl(url)
  },
  async exit() {
    // The only window: closing it quits the app.
    await getCurrentWindow().close()
  }
}
