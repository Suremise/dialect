// The tab strip: one tab per conversion or Docs page, titled with its file name and job ("phase1.conf → IOS-XE"), a dot
// while its output is unsaved, and the file's full path on hover. Click to show one, middle-click or × to close, "+" for
// a new tab. The tabs are a WAI-ARIA tablist: the arrow keys, Home and End move between them, Delete closes one. In a
// narrow window the strip scrolls sideways.
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { DOCS } from '../help/docs'
import { isUnsaved, tabTitle, useStore, type Tab } from '../store'
import { CloseIcon, PlusIcon } from './Icons'

const docLabel = (page: string): string => DOCS.find((d) => d.id === page)?.label ?? page

export const tabDomId = (id: string): string => `${id}-tab`
export const panelDomId = (id: string): string => `${id}-panel`

function tooltip(t: Tab, title: string): string {
  if (t.kind === 'docs') return title
  const file = t.sourcePath ?? t.sourceName ?? (t.source ? 'Pasted text' : 'Untitled')
  return `${file}${isUnsaved(t) ? ' (unsaved output)' : ''}${t.reopen ? ' (not loaded: reopen it to see it again)' : ''}`
}

export function TabStrip() {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const { activate, closeTab, setPickerOpen } = useStore.getState()
  const stripRef = useRef<HTMLDivElement>(null)

  // The current tab stays in view in a strip that scrolls.
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const onKey = (i: number) => (e: KeyboardEvent): void => {
    const go = (to: number): void => {
      e.preventDefault()
      const t = tabs[(to + tabs.length) % tabs.length]
      activate(t.id)
      document.getElementById(tabDomId(t.id))?.focus()
    }
    if (e.key === 'ArrowRight') go(i + 1)
    else if (e.key === 'ArrowLeft') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(tabs.length - 1)
    else if (e.key === 'Delete') {
      e.preventDefault()
      closeTab(tabs[i].id)
    }
  }

  return (
    <div className="tabstrip">
      <div className="tabs" role="tablist" aria-label="Open tabs" ref={stripRef}>
        {tabs.map((t, i) => {
          const title = tabTitle(t, docLabel)
          const current = t.id === activeId
          const unsaved = isUnsaved(t)
          return (
            <div
              key={t.id}
              id={tabDomId(t.id)}
              role="tab"
              aria-selected={current}
              aria-controls={panelDomId(t.id)}
              aria-label={`${title}${unsaved ? ', unsaved' : ''}`}
              tabIndex={current ? 0 : -1}
              className={`tab${current ? ' current' : ''}${t.kind === 'docs' ? ' docs' : ''}`}
              title={tooltip(t, title)}
              onClick={() => activate(t.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                closeTab(t.id)
              }}
              onKeyDown={onKey(i)}
            >
              <span className="tab-title">{title}</span>
              {unsaved && <span className="tab-dot" aria-hidden="true" />}
              <button
                className="tab-close"
                tabIndex={-1}
                aria-label={`Close ${title}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
      </div>
      <button className="tab-new" aria-label="New tab" title="New tab" onClick={() => setPickerOpen(true)}>
        <PlusIcon />
      </button>
    </div>
  )
}
