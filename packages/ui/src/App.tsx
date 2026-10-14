// Dialect's two modes, display set and convert: the source config on the left, its display set or conversion on the
// right, problems below (and in convert, the interface table beside them). The same UI runs in the web build and the
// desktop app; `platform` is the shell's file and clipboard access.
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import iconUrl from '../../../branding/icon-small.svg'
import { CheckIcon, CopyIcon, ErrorIcon, OpenIcon, PasteIcon, SaveIcon, ThemeIcon, WarningIcon } from './components/Icons'
import { InterfaceTable } from './components/InterfaceTable'
import { Editor, type LineMark } from './editor/Editor'
import { AboutDialog } from './help/AboutDialog'
import { DocsView } from './help/DocsView'
import { HelpMenu } from './help/HelpMenu'
import { useHelp } from './help/state'
import type { Platform } from './platform'
import { countCommands, outputName, SOURCE_PLUGIN, TARGETS, targetPlugin, useStore, type Mode, type ThemeChoice } from './store'

const MODES: readonly { mode: Mode; label: string; title: string }[] = [
  { mode: 'display-set', label: 'Display set', title: 'Hierarchical Junos config to display set commands' },
  { mode: 'convert', label: 'Convert', title: "A Junos config to another platform's" }
]

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
  const { mode, targetId, source, sourceName, output, links, problems, interfaces, theme, reveal, notice } = useStore()
  const { setSource, setMode, setTarget, setTheme, revealAt, notify, dismissNotice } = useStore.getState()
  const converting = mode === 'convert'
  const target = targetPlugin(targetId)
  const docsPage = useHelp((s) => s.docsPage)
  const systemDark = useSystemDark()
  const dark = theme === 'system' ? systemDark : theme === 'dark'
  // Lines linked to the other pane's cursor: output lines → their source statement, and back.
  const [linkedSource, setLinkedSource] = useState<number[]>([])
  const [linkedOutput, setLinkedOutput] = useState<number[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    setLinkedSource([])
    setLinkedOutput([])
  }, [source, mode, targetId])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissNotice, 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const error = problems.find((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning')

  const unnamed = interfaces.filter((i) => i.target === undefined).length
  const outputLines = output ? output.split('\n').length : 0
  // Display set counts commands: a banner's quoted line breaks make one command several lines, said when they do.
  const commands = converting ? 0 : countCommands(output)
  const outputCount = converting
    ? plural(outputLines, 'line', 'lines')
    : `${plural(commands, 'command', 'commands')}${commands === outputLines ? '' : ` (${plural(outputLines, 'line', 'lines')})`}`

  const sourceMarks = useMemo<LineMark[]>(
    () => [
      ...problems.flatMap((p) => (p.line ? [{ line: p.line, kind: p.severity, title: p.message }] : [])),
      ...linkedSource.map((line) => ({ line, kind: 'link' as const }))
    ],
    [problems, linkedSource]
  )
  const outputMarks = useMemo<LineMark[]>(() => linkedOutput.map((line) => ({ line, kind: 'link' as const })), [linkedOutput])

  const onOutputCursor = useCallback(
    (line: number) => {
      const lines = [...new Set(links.flatMap(([from, to]) => (to === line ? [from] : [])))].sort((a, b) => a - b)
      setLinkedOutput([])
      setLinkedSource(lines)
      if (lines.length > 0) revealAt('source', lines[0], 1, false)
    },
    [links]
  )

  const onSourceCursor = useCallback(
    (line: number) => {
      const lines = [...new Set(links.flatMap(([from, to]) => (from === line ? [to] : [])))].sort((a, b) => a - b)
      setLinkedSource([])
      setLinkedOutput(lines)
      if (lines.length > 0) revealAt('output', lines[0], 1, false)
    },
    [links]
  )

  const open = useCallback(async () => {
    try {
      const file = await platform.openFile()
      if (file) {
        setSource(file.text, file.name)
        useHelp.getState().closeDocs()
      }
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
      await platform.saveText(outputName(sourceName, mode, targetId), output + '\n')
    } catch (e) {
      notify('error', `Couldn't save the output: ${(e as Error).message}`)
    }
  }, [platform, output, sourceName, mode, targetId])

  const copy = useCallback(async () => {
    if (!output) return
    try {
      await platform.writeClipboard(output + '\n')
      notify('info', `Copied ${outputCount}.`)
    } catch (e) {
      notify('error', `Couldn't copy the output: ${(e as Error).message}`)
    }
  }, [platform, output, outputCount])

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
      (file) => {
        if (!file) return
        setSource(file.text, file.name)
        useHelp.getState().closeDocs()
      },
      (err: Error) => notify('error', `Couldn't open the dropped file: ${err.message}`)
    )
  }

  const outputSummary = error
    ? 'No output: the config has a syntax error'
    : source.trim() === ''
      ? ''
      : converting
        ? `${outputCount}${unnamed ? `, incomplete: ${plural(unnamed, 'interface needs', 'interfaces need')} a name` : ''}`
        : outputCount
  const outputTitle = converting ? target.name : 'Display set'

  return (
    <div className={`app${converting ? ' converting' : ''}`} onDragOverCapture={onDragOver} onDragLeave={(e) => e.relatedTarget === null && setDragging(false)} onDropCapture={onDrop}>
      <header className="titlebar">
        <img className="titlebar-logo" src={iconUrl} alt="" width="18" height="18" />
        <span className="titlebar-name">Dialect</span>
        <div className="mode-switch" role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.mode} className={`mode-button${m.mode === mode ? ' selected' : ''}`} aria-pressed={m.mode === mode} title={m.title} onClick={() => setMode(m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
        {converting && (
          <label className="target-picker">
            <span>{SOURCE_PLUGIN.name} →</span>
            <select aria-label="Target platform" value={targetId} onChange={(e) => setTarget(e.target.value)}>
              {TARGETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="toolbar" role="toolbar" aria-label="Actions">
          <button className="btn" onClick={() => void open()} title="Open a config file (Ctrl+O)">
            <OpenIcon /> Open…
          </button>
          <button className="btn" onClick={() => void paste()} title="Replace the source with the clipboard's text">
            <PasteIcon /> Paste
          </button>
          <button className="btn" onClick={() => void copy()} disabled={!output} title={converting ? `Copy the ${target.name} config` : 'Copy the display set'}>
            <CopyIcon /> Copy output
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!output} title={`Save the ${converting ? `${target.name} config` : 'display set'} as ${outputName(sourceName, mode, targetId)} (Ctrl+S)`}>
            <SaveIcon /> Save output
          </button>
          <span className="toolbar-sep" />
          <HelpMenu />
          <button className="btn subtle icon-only" onClick={() => setTheme(NEXT_THEME[theme])} title={`${THEME_LABEL[theme]}: click for ${THEME_LABEL[NEXT_THEME[theme]].toLowerCase()}`} aria-label={THEME_LABEL[theme]}>
            <ThemeIcon />
          </button>
        </div>
      </header>

      {/* While the Docs show, the panes are hidden, not unmounted: the editors keep their state and undo history. */}
      {docsPage && <DocsView platform={platform} />}
      <main className="workbench" hidden={!!docsPage}>
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
            issueGutter
          />
        </section>
        <section className="pane" aria-label="Output">
          <div className="pane-header">
            <span>{outputTitle}</span>
            <span className="pane-detail" data-testid="output-summary">
              {outputSummary}
            </span>
          </div>
          <Editor
            pane="output"
            label={`${outputTitle} output`}
            value={output}
            readOnly
            placeholder={
              error ? `Fix the syntax error to see the ${converting ? 'conversion' : 'display set'}.` : converting ? `The ${target.name} config appears here.` : 'The display set commands appear here.'
            }
            marks={outputMarks}
            reveal={reveal}
            onCursorLine={onOutputCursor}
            dark={dark}
          />
        </section>
      </main>

      <div className={`bottom${converting ? ' converting' : ''}`} hidden={!!docsPage}>
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
                `Open or paste a Junos config to see its ${converting ? 'conversion' : 'display set'}.`
              ) : (
                <>
                  <CheckIcon /> No problems.
                </>
              )}
            </li>
          ) : (
            problems.map((p, i) => (
              <li key={i}>
                <button className={`problem ${p.severity}`} onClick={() => p.line && revealAt('source', p.line, p.column, true)} title={p.message}>
                  {p.severity === 'error' ? <ErrorIcon /> : <WarningIcon />}
                  <span className="problem-message">{p.message}</span>
                  {p.line && (
                    <span className="problem-place">
                      line {p.line}, column {p.column}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
        </section>
        {converting && <InterfaceTable platform={platform} />}
      </div>

      <footer className="statusbar">
        <span className="status-item">{converting ? `${SOURCE_PLUGIN.name} → ${target.name}` : 'Junos → display set'}</span>
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

      <AboutDialog platform={platform} />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop a config file to open it
        </div>
      )}
    </div>
  )
}
