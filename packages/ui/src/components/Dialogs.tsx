// The tab dialogs: the new tab picker (what are you doing?), and the questions before closing a tab, or exiting, with
// unsaved output. Each is a modal dialog: focus starts on its first choice, Tab stays inside it and Esc cancels.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { exit, saveOutput } from '../actions'
import { DOCS } from '../help/docs'
import type { Platform } from '../platform'
import { isUnsaved, jobs, tabTitle, useStore, type ConversionTab } from '../store'

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
      // The focus stays in the dialog.
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
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

/** File → New Tab: a display set or a conversion, as the plugins offer them. */
export function NewTabDialog() {
  const open = useStore((s) => s.pickerOpen)
  const { newTab, setPickerOpen } = useStore.getState()
  if (!open) return null
  return (
    <Modal title="New tab" className="picker" onCancel={() => setPickerOpen(false)}>
      <p className="modal-text">What are you doing?</p>
      <div className="picker-list" role="group" aria-label="Jobs">
        {jobs().map((j, i) => (
          <button key={j.label} className="picker-item" data-autofocus={i === 0 || undefined} onClick={() => newTab(j.job)}>
            <span className="picker-label">{j.label}</span>
            <span className="picker-detail">{j.detail}</span>
          </button>
        ))}
      </div>
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
