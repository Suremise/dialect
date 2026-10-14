// A conversion tab's page: its toolbar, the source config on the left and its output on the right (a display set, or a
// conversion), problems below (and in convert, the interface table beside them). Every open conversion tab keeps its
// page mounted, hidden while another tab shows, so its editors keep their text, cursor and undo history.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { copyOutput, openFile, paste, reopen, saveOutput } from '../actions'
import { Editor, type LineMark } from '../editor/Editor'
import type { Platform } from '../platform'
import { jobLabel, outputCount, outputName, SOURCE_PLUGIN, TARGETS, targetPlugin, toolOf, useStore, type ConversionTab } from '../store'
import { CheckIcon, CopyIcon, ErrorIcon, OpenIcon, PasteIcon, SaveIcon, WarningIcon } from './Icons'
import { InterfaceTable } from './InterfaceTable'
import { panelDomId, tabDomId } from './TabStrip'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What the output pane says above it: the count, or why there's none. */
export function outputSummary(tab: ConversionTab): string {
  if (tab.problems.some((p) => p.severity === 'error')) return 'No output: the config has a syntax error'
  if (tab.source.trim() === '') return ''
  const unnamed = tab.interfaces.filter((i) => i.target === undefined).length
  return `${outputCount(tab.job, tab.output)}${unnamed ? `, incomplete: ${plural(unnamed, 'interface needs', 'interfaces need')} a name` : ''}`
}

/** The job as the status bar and the output pane name it. */
export function jobTitle(tab: ConversionTab): { output: string; status: string; doing: string } {
  if (tab.job.kind === 'convert') {
    const target = targetPlugin(tab.job.target)
    return { output: target.name, status: `${SOURCE_PLUGIN.name} → ${target.name}`, doing: 'conversion' }
  }
  const { plugin, tool } = toolOf(tab.job.tool)
  return { output: tool.name, status: `${plugin.name} → ${tool.name.toLowerCase()}`, doing: tool.name.toLowerCase() }
}

export function ConversionView({ tab, active, platform, dark }: { tab: ConversionTab; active: boolean; platform: Platform; dark: boolean }) {
  const reveal = useStore((s) => (s.reveal?.tab === tab.id ? s.reveal : null))
  const { setSource, setTarget, revealAt } = useStore.getState()
  const { id, job, source, sourceName, output, links, problems } = tab
  const converting = job.kind === 'convert'
  const target = converting ? targetPlugin(job.target) : null
  const titles = jobTitle(tab)
  // Lines linked to the other pane's cursor: output lines → their source statement, and back.
  const [linkedSource, setLinkedSource] = useState<number[]>([])
  const [linkedOutput, setLinkedOutput] = useState<number[]>([])

  useEffect(() => {
    setLinkedSource([])
    setLinkedOutput([])
  }, [source, job])

  const error = problems.find((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning')

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

  const summary = outputSummary(tab)

  return (
    <div className={`conversion${converting ? ' converting' : ''}`} id={panelDomId(id)} role="tabpanel" aria-labelledby={tabDomId(id)} hidden={!active} data-tab={id}>
      <div className="tab-toolbar">
        <span className="job-label">{converting ? `${SOURCE_PLUGIN.name} →` : jobLabel(job)}</span>
        {converting && (
          <select className="target-select" aria-label="Target platform" value={target!.id} onChange={(e) => setTarget(e.target.value)}>
            {TARGETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <div className="toolbar" role="toolbar" aria-label="Actions">
          <button className="btn" onClick={() => void openFile(platform)} title="Open a config file in this tab">
            <OpenIcon /> Open…
          </button>
          <button className="btn" onClick={() => void paste(platform)} title="Replace the source with the clipboard's text">
            <PasteIcon /> Paste
          </button>
          <button className="btn" onClick={() => void copyOutput(platform)} disabled={!output} title={`Copy the ${titles.output} output`}>
            <CopyIcon /> Copy output
          </button>
          <button className="btn primary" onClick={() => void saveOutput(platform)} disabled={!output} title={`Save the ${titles.output} output as ${outputName(sourceName, job)}`}>
            <SaveIcon /> Save output
          </button>
        </div>
      </div>

      {tab.reopen && (
        <div className="reopen-bar" role="status">
          <span>This tab had {tab.reopen} open. Dialect doesn't keep configs between sessions.</span>
          <button className="btn primary small" onClick={() => void reopen(platform, id)}>
            <OpenIcon /> Reopen {tab.reopen}…
          </button>
        </div>
      )}

      <main className="workbench">
        <section className="pane" aria-label="Source">
          <div className="pane-header">
            <span>Source</span>
            <span className="pane-detail" data-testid="source-name">
              {sourceName ?? (source ? 'Pasted text' : 'Junos, hierarchical')}
            </span>
          </div>
          <Editor
            tab={id}
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
            <span>{titles.output}</span>
            <span className="pane-detail" data-testid="output-summary">
              {summary}
            </span>
          </div>
          <Editor
            tab={id}
            pane="output"
            label={`${titles.output} output`}
            value={output}
            readOnly
            placeholder={error ? `Fix the syntax error to see the ${titles.doing}.` : converting ? `The ${target!.name} config appears here.` : `The ${titles.doing} appears here.`}
            marks={outputMarks}
            reveal={reveal}
            onCursorLine={onOutputCursor}
            dark={dark}
          />
        </section>
      </main>

      <div className={`bottom${converting ? ' converting' : ''}`}>
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
                  `Open or paste a Junos config to see its ${titles.doing}.`
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
        {converting && <InterfaceTable tab={tab} platform={platform} />}
      </div>
    </div>
  )
}
