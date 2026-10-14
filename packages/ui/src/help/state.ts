// What the Help menu opens: the Docs view (in place of the display set panes) at a page, and the About dialog. Its own
// small store, apart from the display set's.
import { create } from 'zustand'
import type { DocId } from './docs'

interface HelpState {
  /** The Docs page shown, or null for the display set. */
  docsPage: DocId | null
  aboutOpen: boolean
  showDocs: (page: DocId) => void
  closeDocs: () => void
  setAboutOpen: (open: boolean) => void
}

export const useHelp = create<HelpState>((set) => ({
  docsPage: null,
  aboutOpen: false,
  showDocs: (page) => set({ docsPage: page, aboutOpen: false }),
  closeDocs: () => set({ docsPage: null }),
  setAboutOpen: (open) => set({ aboutOpen: open })
}))
