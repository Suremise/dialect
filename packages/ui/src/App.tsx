// Dialect's display set mode: the source config on the left, its display set on the right, problems below. The same
// UI runs in the web build and the desktop app; `platform` is the shell's file and clipboard access.
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import iconUrl from '../../../branding/icon-small.svg'
import { CheckIcon, CopyIcon, ErrorIcon, OpenIcon, PasteIcon, SaveIcon, ThemeIcon, WarningIcon } from './components/Icons'
import { Editor, type LineMark } from './editor/Editor'
import type { Platform } from './platform'
import { outputName, useStore, type ThemeChoice } from './store'

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' }
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }

function useSystemDark(): boolean {
  const query = useMemo(() => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null), [])
  const [dark, setDark] = useState(query?.matches ?? true)
  useEffect(() => {
    if (!query) return
    const onChange = (): void => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return dark
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function App({ platform }: { platform: Platform }) {
  const { source, sourceName, output, sourceLines, problems, theme, reveal, notice } = useStore()
  const { setSource, setTheme, revealAt, notify, dismissNotice } = useStore.getState()
  const systemDark = useSystemDark()
  const dark = theme === 'system' ? systemDark : theme === 'dark'
  // Lines linked to the other pane's cursor: output lines → their source statement, and back.
  const [linkedSource, setLinkedSource] = useState<number | null>(null)
  const [linkedOutput, setLinkedOutput] = useState<number[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    setLinkedSource(null)
    setLinkedOutput([])
  }, [source])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissNotice, 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const error = problems.find((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning')

  const sourceMarks = useMemo<LineMark[]>(
    () => [...problems.map((p) => ({ line: p.line, kind: p.severity })), ...(linkedSource ? [{ line: linkedSource, kind: 'link' as const }] : [])],
    [problems, linkedSource]
  )
  const outputMarks = useMemo<LineMark[]>(() => linkedOutput.map((line) => ({ line, kind: 'link' as const })), [linkedOutput])

  const onOutputCursor = useCallback(
    (line: number) => {
      const target = sourceLines[line - 1]
      setLinkedOutput([])
      setLinkedSource(target ?? null)
      if (target) revealAt('source', target, 1, false)
    },
    [sourceLines]
  )

  const onSourceCursor = useCallback(
    (line: number) => {
      const targets = sourceLines.flatMap((l, i) => (l === line ? [i + 1] : []))
      setLinkedSource(null)
      setLinkedOutput(targets)
      if (targets.length > 0) revealAt('output', targets[0], 1, false)
    },
    [sourceLines]
  )

  const open = useCallback(async () => {
    try {
      const file = await platform.openFile()
      if (file) setSource(file.text, file.name)
    } catch (e) {
      notify('error', `Couldn't open the file: ${(e as Error).message}`)
    }
  }, [platform])

  const paste = useCallback(async () => {
    try {
      const text = await platform.readClipboard()
      setSource(text, null)
    } catch {
      notify('info', "This browser didn't let Dialect read the clipboard: click in the source pane and press Ctrl+V.")
      revealAt('source', 1, 1, true)
    }
  }, [platform])

  const save = useCallback(async () => {
    if (!output) return
    try {
      await platform.saveText(outputName(sourceName), output + '\n')
    } catch (e) {
      notify('error', `Couldn't save the output: ${(e as Error).message}`)
    }
  }, [platform, output, sourceName])

  const copy = useCallback(async () => {
    if (!output) return
    try {
      await platform.writeClipboard(output + '\n')
      notify('info', `Copied ${plural(sourceLines.length, 'set line', 'set lines')}.`)
    } catch (e) {
      notify('error', `Couldn't copy the output: ${(e as Error).message}`)
    }
  }, [platform, output, sourceLines.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key === 'o') {
        e.preventDefault()
        void open()
      } else if (e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, save])

  // Capture phase, so a file dropped on an editor opens instead of being typed into it.
  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (e: DragEvent): void => {
    setDragging(false)
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    // The shell reads it (as it opens and saves files), here from the event's data.
    platform.openDropped(e.dataTransfer).then(
      (file) => file && setSource(file.text, file.name),
      (err: Error) => notify('error', `Couldn't open the dropped file: ${err.message}`)
    )
  }

  const outputSummary = error ? 'No output: the config has a syntax error' : source.trim() === '' ? '' : plural(sourceLines.length, 'set line', 'set lines')

  return (
    <div className="app" onDragOverCapture={onDragOver} onDragLeave={(e) => e.relatedTarget === null && setDragging(false)} onDropCapture={onDrop}>
      <header className="titlebar">
        <img className="titlebar-logo" src={iconUrl} alt="" width="18" height="18" />
        <span className="titlebar-name">Dialect</span>
        <span className="titlebar-mode" title="Hierarchical Junos config to display set commands">
          Display set
        </span>
        <div className="toolbar" role="toolbar" aria-label="Actions">
          <button className="btn" onClick={() => void open()} title="Open a config file (Ctrl+O)">
            <OpenIcon /> Open…
          </button>
          <button className="btn" onClick={() => void paste()} title="Replace the source with the clipboard's text">
            <PasteIcon /> Paste
          </button>
          <button className="btn" onClick={() => void copy()} disabled={!output} title="Copy the display set">
            <CopyIcon /> Copy output
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!output} title={`Save the display set as ${outputName(sourceName)} (Ctrl+S)`}>
            <SaveIcon /> Save output
          </button>
          <span className="toolbar-sep" />
          <button className="btn subtle icon-only" onClick={() => setTheme(NEXT_THEME[theme])} title={`${THEME_LABEL[theme]}: click for ${THEME_LABEL[NEXT_THEME[theme]].toLowerCase()}`} aria-label={THEME_LABEL[theme]}>
            <ThemeIcon />
          </button>
        </div>
      </header>

      <main className="workbench">
        <section className="pane" aria-label="Source">
          <div className="pane-header">
            <span>Source</span>
            <span className="pane-detail" data-testid="source-name">
              {sourceName ?? (source ? 'Pasted text' : 'Junos, hierarchical')}
            </span>
          </div>
          <Editor
            pane="source"
            label="Source config"
            value={source}
            onChange={(text) => setSource(text)}
            placeholder="Paste a hierarchical Junos config here, open a file, or drop one anywhere in this window."
            marks={sourceMarks}
            reveal={reveal}
            onCursorLine={onSourceCursor}
            dark={dark}
          />
        </section>
        <section className="pane" aria-label="Output">
          <div className="pane-header">
            <span>Display set</span>
            <span className="pane-detail" data-testid="output-summary">
              {outputSummary}
            </span>
          </div>
          <Editor
            pane="output"
            label="Display set output"
            value={output}
            readOnly
            placeholder={error ? 'Fix the syntax error to see the display set.' : 'The display set commands appear here.'}
            marks={outputMarks}
            reveal={reveal}
            onCursorLine={onOutputCursor}
            dark={dark}
          />
        </section>
      </main>

      <section className="problems" aria-label="Problems">
        <div className="section-header">
          <span>Problems</span>
          <span className="count" data-testid="problem-count">
            {error ? '1 error' : plural(warnings.length, 'warning', 'warnings')}
          </span>
        </div>
        <ul className="problem-list">
          {problems.length === 0 ? (
            <li className="problem-empty">
              {source.trim() === '' ? (
                'Open or paste a Junos config to see its display set.'
              ) : (
                <>
                  <CheckIcon /> No problems.
                </>
              )}
            </li>
          ) : (
            problems.map((p, i) => (
              <li key={i}>
                <button className={`problem ${p.severity}`} onClick={() => revealAt('source', p.line, p.column, true)}>
                  {p.severity === 'error' ? <ErrorIcon /> : <WarningIcon />}
                  <span className="problem-message">{p.message}</span>
                  <span className="problem-place">
                    line {p.line}, column {p.column}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <footer className="statusbar">
        <span className="status-item">Junos → display set</span>
        <span className="status-item" data-testid="status-result">
          {error ? (
            <>
              <ErrorIcon /> Syntax error, line {error.line}
            </>
          ) : (
            outputSummary
          )}
        </span>
        <span className="status-spacer" />
        {notice && (
          <span className={`status-item notice ${notice.kind}`} role="status" key={notice.seq}>
            {notice.text}
          </span>
        )}
        <span className="status-item" title="Dialect isn't affiliated with or endorsed by Juniper Networks or Cisco Systems.">
          Offline: nothing leaves this computer
        </span>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop a config file to open it
        </div>
      )}
    </div>
  )
}
