// Each tab's editors, so the Edit menu's Undo and Redo reach the right one: the editor last focused in the active tab,
// or its source (the output is read-only).
import type { EditorView } from '@codemirror/view'

type Pane = 'source' | 'output'

const views = new Map<string, EditorView>()
const lastFocused = new Map<string, Pane>()

const key = (tab: string, pane: Pane): string => `${tab} ${pane}`

export function registerView(tab: string, pane: Pane, view: EditorView): () => void {
  views.set(key(tab, pane), view)
  return () => {
    if (views.get(key(tab, pane)) === view) views.delete(key(tab, pane))
    if (!views.has(key(tab, 'source')) && !views.has(key(tab, 'output'))) lastFocused.delete(tab)
  }
}

export function noteFocus(tab: string, pane: Pane): void {
  lastFocused.set(tab, pane)
}

/** The editor Edit's commands act on in this tab. */
export function editTarget(tab: string): EditorView | undefined {
  return views.get(key(tab, lastFocused.get(tab) ?? 'source')) ?? views.get(key(tab, 'source'))
}
