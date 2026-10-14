// The Help menu in the title bar: the four Docs pages and About Dialect. F1 opens the user guide; Esc leaves the Docs.
import { useEffect, useRef, useState } from 'react'
import { DOCS } from './docs'
import { useHelp } from './state'

export function HelpMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { showDocs, closeDocs, setAboutOpen } = useHelp.getState()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F1') {
        e.preventDefault()
        setOpen(false)
        showDocs('guide')
      } else if (e.key === 'Escape') {
        if (open) setOpen(false)
        else if (!useHelp.getState().aboutOpen) closeDocs()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (open && !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const choose = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="btn subtle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Help: the user guide, release notes, licenses and About (F1)">
        Help
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Help">
          {DOCS.map((d) => (
            <button key={d.id} role="menuitem" className="menu-item" onClick={choose(() => showDocs(d.id))}>
              {d.label}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button role="menuitem" className="menu-item" onClick={choose(() => setAboutOpen(true))}>
            About Dialect
          </button>
        </div>
      )}
    </div>
  )
}
