// The About dialog's state, apart from the tabs' store. The Docs pages open as tabs (store.ts, openDocs).
import { create } from 'zustand'

interface HelpState {
  aboutOpen: boolean
  setAboutOpen: (open: boolean) => void
}

export const useHelp = create<HelpState>((set) => ({
  aboutOpen: false,
  setAboutOpen: (open) => set({ aboutOpen: open })
}))
