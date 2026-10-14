// A CodeMirror 6 editor in a shadow root. CodeMirror injects its styles at runtime; in a shadow root it uses a
// constructed stylesheet (adoptedStyleSheets) instead of a <style> element, which the web build's strict CSP (hashes
// only, no 'unsafe-inline') would block. The theme's custom properties inherit into the shadow root, so the editors
// follow the app's light and dark themes without being reconfigured.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { Reveal } from '../store'
import { junos } from './junosLanguage'
import { noteFocus, registerView } from './views'

/** A line to mark: the error, a warning, or the line linked to the other pane's cursor. */
export interface LineMark {
  line: number
  kind: 'error' | 'warning' | 'link'
  /** What the gutter marker says on hover (errors and warnings). */
  title?: string
}

export interface EditorProps {
  /** The editor's accessible name. */
  label: string
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  placeholder?: string
  marks?: LineMark[]
  reveal?: Reveal | null
  /** Called with the 1-based line the cursor moves to. */
  onCursorLine?: (line: number) => void
  dark: boolean
  /** For tests and the problems panel: names the pane (`data-pane`). */
  pane: 'source' | 'output'
  /** The tab it belongs to: Edit → Undo and Redo act on its tab's editors, and reveals name their tab. */
  tab: string
  /** A gutter that marks the error and warning lines, with what they say on hover. */
  issueGutter?: boolean
}

const setMarks = StateEffect.define<LineMark[]>()

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue
      const lines = tr.state.doc.lines
      const ranges = effect.value
        .filter((m) => m.line >= 1 && m.line <= lines)
        .map((m) => Decoration.line({ class: `cm-mark-${m.kind}` }).range(tr.state.doc.line(m.line).from))
        .sort((a, b) => a.from - b.from)
      next = Decoration.set(ranges, true)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** An error or warning line's marker in the issue gutter. */
class IssueMarker extends GutterMarker {
  constructor(
    readonly kind: 'error' | 'warning',
    readonly title: string
  ) {
    super()
  }
  eq(other: IssueMarker): boolean {
    return other.kind === this.kind && other.title === this.title
  }
  toDOM(): Node {
    const el = document.createElement('span')
    el.className = `cm-issue cm-issue-${this.kind}`
    el.title = this.title
    el.setAttribute('aria-label', this.title)
    return el
  }
}

/** One marker per line: an error over warnings, with every message on the line in its title. */
const issuesField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    let next = markers.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue
      const byLine = new Map<number, LineMark[]>()
      for (const m of effect.value) if (m.kind !== 'link' && m.line >= 1 && m.line <= tr.state.doc.lines) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m])
      const ranges = [...byLine.entries()]
        .sort(([a], [b]) => a - b)
        .map(([line, marks]) => {
          const kind = marks.some((m) => m.kind === 'error') ? 'error' : 'warning'
          return new IssueMarker(kind, [...new Set(marks.map((m) => m.title ?? m.kind))].join('\n')).range(tr.state.doc.line(line).from)
        })
      next = RangeSet.of(ranges)
    }
    return next
  }
})

const issueGutter: Extension = [issuesField, gutter({ class: 'cm-issue-gutter', markers: (view) => view.state.field(issuesField) })]

const highlight = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.modifier, color: 'var(--syntax-tag)', fontWeight: '600' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: [tags.brace, tags.squareBracket, tags.punctuation], color: 'var(--syntax-punctuation)' }
])

function theme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg-panel)', fontSize: '13px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace", lineHeight: '1.5' },
      '.cm-content': { caretColor: 'var(--accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--editor-selection)'
      },
      '.cm-gutters': { backgroundColor: 'var(--bg-panel)', color: 'var(--fg-faint)', border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent-ink)' },
      '.cm-activeLine': { backgroundColor: 'var(--editor-line)' },
      '.cm-placeholder': { color: 'var(--fg-muted)', fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
      '.cm-mark-error': { backgroundColor: 'var(--mark-error)', boxShadow: 'inset 3px 0 0 var(--error)' },
      '.cm-mark-warning': { backgroundColor: 'var(--mark-warning)', boxShadow: 'inset 3px 0 0 var(--warning)' },
      '.cm-mark-link': { backgroundColor: 'var(--accent-soft)', boxShadow: 'inset 3px 0 0 var(--accent)' },
      '.cm-issue-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '14px' },
      '.cm-issue': { display: 'block', width: '8px', height: '8px', borderRadius: '50%' },
      '.cm-issue-error': { backgroundColor: 'var(--error)' },
      '.cm-issue-warning': { backgroundColor: 'var(--warning)', borderRadius: '1px', transform: 'rotate(45deg) scale(0.85)' },
      '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--fg)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-subtle)' },
      '.cm-textfield': { backgroundColor: 'var(--bg-input)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '3px' },
      '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-elevated)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '3px' },
      '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-selection)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' }
    },
    { dark }
  )
}

export function Editor(props: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeRef = useRef(new Compartment())
  const placeholderRef = useRef(new Compartment())
  // The latest callbacks, so the editor made once always calls the current ones.
  const onChangeRef = useRef(props.onChange)
  const onCursorLineRef = useRef(props.onCursorLine)
  onChangeRef.current = props.onChange
  onCursorLineRef.current = props.onCursorLine
  const externalRef = useRef(false)

  useEffect(() => {
    const host = hostRef.current!
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const parent = document.createElement('div')
    parent.style.height = '100%'
    shadow.replaceChildren(parent)
    let lastLine = 0
    const view = new EditorView({
      root: shadow,
      parent,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          props.issueGutter ? issueGutter : [],
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          junos,
          syntaxHighlighting(highlight),
          marksField,
          themeRef.current.of(theme(props.dark)),
          EditorState.readOnly.of(props.readOnly ?? false),
          EditorView.contentAttributes.of({ 'aria-label': props.label }),
          EditorView.domEventHandlers({ focus: () => noteFocus(props.tab, props.pane) }),
          placeholderRef.current.of(props.placeholder ? placeholder(props.placeholder) : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalRef.current) onChangeRef.current?.(update.state.doc.toString())
            // Only the user's own moves: a reveal from the other pane mustn't echo back to it.
            const byUser = update.transactions.some((tr) => tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete'))
            if (update.selectionSet && byUser) {
              const line = update.state.doc.lineAt(update.state.selection.main.head).number
              if (line !== lastLine) {
                lastLine = line
                onCursorLineRef.current?.(line)
              }
            }
          })
        ]
      })
    })
    viewRef.current = view
    const unregister = registerView(props.tab, props.pane, view)
    return () => {
      unregister()
      view.destroy()
      viewRef.current = null
    }
    // Made once; the effects below keep it in step with the props.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === props.value) return
    externalRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, selection: { anchor: 0 }, scrollIntoView: true })
    } finally {
      externalRef.current = false
    }
  }, [props.value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMarks.of(props.marks ?? []) })
  }, [props.marks, props.value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeRef.current.reconfigure(theme(props.dark)) })
  }, [props.dark])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderRef.current.reconfigure(props.placeholder ? placeholder(props.placeholder) : []) })
  }, [props.placeholder])

  useEffect(() => {
    const view = viewRef.current
    const reveal = props.reveal
    if (!view || !reveal || reveal.tab !== props.tab || reveal.pane !== props.pane) return
    const doc = view.state.doc
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines))
    const pos = Math.min(line.from + Math.max(reveal.column - 1, 0), line.to)
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    if (reveal.focus) view.focus()
  }, [props.reveal])

  return <div className="editor-host" ref={hostRef} data-pane={props.pane} />
}
