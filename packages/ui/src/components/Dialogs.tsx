// The tab dialogs: the new tab picker (what are you doing?), and the questions before closing a tab, or exiting, with
// unsaved output. Each is a modal dialog: focus starts on its first choice, Tab stays inside it and Esc cancels.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { exit, saveOutput } from '../actions'
import { DOCS } from '../help/docs'
import type { Platform } from '../platform'
import { convertJob, isUnsaved, SOURCE_PLUGIN, SOURCES, TARGETS, tabTitle, targetsFor, sourcePlugin, toolJobs, useStore, type ConversionTab } from '../store'

/** What Tab moves through in a dialog, in document order. */
const TABBABLE = 'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

function Modal({ title, onCancel, children, className }: { title: string; onCancel: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const back = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const from = back.current
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus()
    }
  }, [])

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Tab') {
      // The focus stays in the dialog: past its last control to its first, and back, through every one it has.
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])]
      const at = items.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey ? at <= 0 : at === items.length - 1) {
        e.preventDefault()
        items[e.shiftKey ? items.length - 1 : 0]?.focus()
      }
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} onKeyDown={onKey}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/**
 * What a new tab can do, as the plugins offer it: each tool, and convert from any platform convert reads to any other
 * it writes (chosen in the two lists, Junos → the first target to start with).
 */
export function JobChoices({ autofocus = false }: { autofocus?: boolean }) {
  const { newTab } = useStore.getState()
  const [from, setFrom] = useState(SOURCE_PLUGIN.id)
  const [to, setTo] = useState(TARGETS[0].id)
  const convert = convertJob(from, to)
  const targets = targetsFor(sourcePlugin(from))
  return (
    <div className="picker-list" role="group" aria-label="Jobs">
      {toolJobs().map((j, i) => (
        <button key={j.label} className="picker-item" data-autofocus={(autofocus && i === 0) || undefined} onClick={() => newTab(j.job)}>
          <span className="picker-label">{j.label}</span>
          <span className="picker-detail">{j.detail}</span>
        </button>
      ))}
      <div className="picker-item picker-convert">
        <span className="picker-label">Convert</span>
        <span className="picker-detail">A config from one platform to another's, with its interfaces named on the target.</span>
        <div className="picker-convert-row">
          <select className="target-select" aria-label="Convert from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {SOURCES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span aria-hidden="true">→</span>
          <select className="target-select" aria-label="Convert to" value={convert.job.kind === 'convert' ? convert.job.target : to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={() => newTab(convert.job)}>
            {convert.label}
          </button>
        </div>
      </div>
    </div>
  )
}

/** File → New Tab: a display set or a conversion, as the plugins offer them. */
export function NewTabDialog() {
  const open = useStore((s) => s.pickerOpen)
  const { setPickerOpen } = useStore.getState()
  if (!open) return null
  return (
    <Modal title="New tab" className="picker" onCancel={() => setPickerOpen(false)}>
      <p className="modal-text">What are you doing?</p>
      <JobChoices autofocus />
      <div className="modal-footer">
        <button className="btn" onClick={() => setPickerOpen(false)}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

const docLabel = (page: string): string => DOCS.find((d) => d.id === page)?.label ?? page

/** Closing a tab with unsaved output: save it first, close anyway, or keep the tab. */
export function CloseDialog({ platform }: { platform: Platform }) {
  const tab = useStore((s) => s.tabs.find((t): t is ConversionTab => t.id === s.closing && t.kind === 'conversion'))
  const { closeTab, cancelClose } = useStore.getState()
  if (!tab) return null
  const title = tabTitle(tab, docLabel)
  const saveAndClose = async (): Promise<void> => {
    if (await saveOutput(platform, false, tab)) closeTab(tab.id, true)
  }
  return (
    <Modal title={`Close ${title}?`} onCancel={cancelClose}>
      <p className="modal-text">Its output hasn't been saved. Closing the tab loses it.</p>
      <div className="modal-footer">
        <button className="btn primary" data-autofocus onClick={() => void saveAndClose()}>
          Save and close
        </button>
        <button className="btn" onClick={() => closeTab(tab.id, true)}>
          Close without saving
        </button>
        <button className="btn" onClick={cancelClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** File → Exit with unsaved output: exit anyway, or stay. */
export function ExitDialog({ platform }: { platform: Platform }) {
  const exiting = useStore((s) => s.exiting)
  const unsaved = useStore((s) => s.tabs.filter(isUnsaved).length)
  const { setExiting } = useStore.getState()
  if (!exiting) return null
  return (
    <Modal title="Exit Dialect?" onCancel={() => setExiting(false)}>
      <p className="modal-text">{unsaved === 1 ? "A tab's output hasn't been saved." : `${unsaved} tabs' output hasn't been saved.`} Exiting loses it.</p>
      <div className="modal-footer">
        <button className="btn" data-autofocus onClick={() => setExiting(false)}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void exit(platform, true)}>
          Exit without saving
        </button>
      </div>
    </Modal>
  )
}
