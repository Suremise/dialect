// What the UI needs from the shell it runs in. The web build implements it with a file picker, downloads and the
// browser's clipboard (apps/web); the desktop app with Tauri's dialog, fs and opener plugins (apps/desktop). The UI
// itself never touches files.

export interface OpenedFile {
  name: string
  text: string
}

export interface Platform {
  /** Which build this is, for About. */
  kind: 'web' | 'desktop'
  /** Dialect's version. */
  version: string
  /** Asks the user for a file to open. Null if they cancel. */
  openFile: () => Promise<OpenedFile | null>
  /**
   * Reads the file dropped on the window, from the drop event's data. Null if nothing readable was dropped. Called
   * during the event: take what's needed from `data` before the first await.
   */
  openDropped: (data: DataTransfer) => Promise<OpenedFile | null>
  /** Saves text under a suggested file name (the web build downloads it). */
  saveText: (suggestedName: string, text: string) => Promise<void>
  /** The clipboard's text. Rejects if the shell isn't allowed to read it; the UI then asks for Ctrl+V. */
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<void>
  /** Opens an https link from the Docs outside the app (a browser tab, or the default browser). */
  openLink: (url: string) => Promise<void>
}
