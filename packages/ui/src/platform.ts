// What the UI needs from the shell it runs in. The web build implements it with a file picker, downloads and the
// browser's clipboard (apps/web); the desktop app with Tauri's dialog, fs and opener plugins (apps/desktop). The UI
// itself never touches files.

/** What a file holds, so the shell can offer the right file types: a config, or an interface map (CSV or JSON). */
export type FileKind = 'config' | 'interface-map'

export interface OpenedFile {
  name: string
  text: string
  /** Its full path, where the shell knows it (the desktop app): the tab's tooltip. */
  path?: string
}

/** Where saved text went: a path the shell can write to again (the desktop app), or none (a download). */
export interface SavedFile {
  path?: string
}

export interface Platform {
  /** Which build this is, for About. */
  kind: 'web' | 'desktop'
  /** Dialect's version. */
  version: string
  /** Asks the user for a file to open, a config unless said otherwise. Null if they cancel. */
  openFile: (kind?: FileKind) => Promise<OpenedFile | null>
  /**
   * Reads the file dropped on the window, from the drop event's data. Null if nothing readable was dropped. Called
   * during the event: take what's needed from `data` before the first await.
   */
  openDropped: (data: DataTransfer) => Promise<OpenedFile | null>
  /**
   * Saves text under a suggested file name (the web build downloads it), a config unless said otherwise. Null if the
   * user cancels.
   */
  saveText: (suggestedName: string, text: string, kind?: FileKind) => Promise<SavedFile | null>
  /** Writes text again to a path an earlier save returned, without asking; only where saves return paths. */
  saveTextTo?: (path: string, text: string) => Promise<void>
  /** The clipboard's text. Rejects if the shell isn't allowed to read it; the UI then asks for Ctrl+V. */
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<void>
  /** Opens an https link from the Docs outside the app (a browser tab, or the default browser). */
  openLink: (url: string) => Promise<void>
  /** Quits the app: File → Exit, in the desktop app only (a web page can't close its browser tab). */
  exit?: () => Promise<void>
  /**
   * Guards the window's own close (its ✕, Alt+F4, closing or reloading the browser tab): `mayClose` says whether it may
   * close now. When it says no, the desktop app keeps the window open (the UI then asks, as File → Exit does) and the
   * web build has the browser ask. Returns what stops the guard.
   */
  guardClose?: (mayClose: () => boolean) => () => void
}
