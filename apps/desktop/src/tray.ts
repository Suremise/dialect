// The page's side of the tray icon (src-tauri/src/main.rs): Show Dialect and Quit run in Rust, against the window; New
// tab sends an event, which opens the New Tab picker as File → New Tab does. Listening needs core:event:allow-listen,
// which the capability already grants for the close guard.
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@dialect/ui'

/** The event src-tauri/src/main.rs sends for the tray's New tab (its NEW_TAB_EVENT). */
export const NEW_TAB_EVENT = 'tray-new-tab'

/** Opens the New Tab picker whenever the tray asks; resolves to what stops listening. */
export const listenToTray = (): Promise<() => void> => listen(NEW_TAB_EVENT, () => useStore.getState().setPickerOpen(true))
