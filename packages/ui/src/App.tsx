// Dialect's window: the menu bar, the tab strip (one tab per conversion or Docs page), the current tab's page and the
// status bar. The same UI runs in the web build and the desktop app; `platform` is the shell's file and clipboard
// access. Every menu item and shortcut is a command from one registry (commands.ts).
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import iconUrl from '../../../branding/icon-small.svg'
import { dropFile } from './actions'
import { createCommands, matchKey, runCommand } from './commands'
import { ConversionView, jobTitle, outputSummary } from './components/ConversionView'
import { CloseDialog, ExitDialog, JobChoices, NewTabDialog } from './components/Dialogs'
import { ErrorIcon } from './components/Icons'
import { MenuBar } from './components/MenuBar'
import { TabStrip } from './components/TabStrip'
import { AboutDialog } from './help/AboutDialog'
import { DOCS } from './help/docs'
import { DocsView } from './help/DocsView'
import { useHelp } from './help/state'
import type { Platform } from './platform'
import { isUnsaved, tabTitle, useStore } from './store'

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

const docLabel = (page: string): string => DOCS.find((d) => d.id === page)?.label ?? page

/** With no tab open: what a new tab can do, as the picker offers it. */
function NoTabs() {
  return (
    <div className="no-tabs">
      <h1>No tabs open</h1>
      <p>Open a tab for what you're doing (File → New Tab):</p>
      <JobChoices />
    </div>
  )
}

export function App({ platform }: { platform: Platform }) {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const theme = useStore((s) => s.theme)
  const notice = useStore((s) => s.notice)
  const { dismissNotice } = useStore.getState()
  const commands = useMemo(() => createCommands(platform), [platform])
  const systemDark = useSystemDark()
  const dark = theme === 'system' ? systemDark : theme === 'dark'
  const [dragging, setDragging] = useState(false)
  const active = tabs.find((t) => t.id === activeId)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    document.title = active ? `${tabTitle(active, docLabel)} - Dialect` : 'Dialect'
  }, [active])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissNotice, 5000)
    return () => clearTimeout(timer)
  }, [notice])

  // The window's own close (its ✕, a browser tab's close or reload) asks first while a tab's output is unsaved: in the
  // Exit dialog where the shell can quit itself (the desktop app), else in the browser's own question.
  useEffect(
    () =>
      platform.guardClose?.(() => {
        const s = useStore.getState()
        if (!s.tabs.some(isUnsaved)) return true
        if (platform.exit) s.setExiting(true)
        return false
      }),
    [platform]
  )

  // The shortcuts, after the editors have had their keys (Undo, Redo, search): a key one used is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const s = useStore.getState()
      // A dialog has the keyboard while it's open.
      if (s.pickerOpen || s.closing || s.exiting || useHelp.getState().aboutOpen) return
      const command = matchKey(commands, e)
      if (!command) return
      e.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commands])

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
    // The shell reads it (as it opens and saves files), here from the event's data, into the tab shown now.
    void dropFile(platform, e.dataTransfer)
  }

  const conversion = active?.kind === 'conversion' ? active : null
  const error = conversion?.problems.find((p) => p.severity === 'error')

  return (
    <div className="app" onDragOverCapture={onDragOver} onDragLeave={(e) => e.relatedTarget === null && setDragging(false)} onDropCapture={onDrop}>
      <header className="titlebar">
        <img className="titlebar-logo" src={iconUrl} alt="Dialect" width="18" height="18" />
        <MenuBar commands={commands} platform={platform} />
      </header>
      <TabStrip />

      <div className="pages">
        {tabs.map((t) =>
          t.kind === 'conversion' ? <ConversionView key={t.id} tab={t} active={t.id === activeId} platform={platform} dark={dark} /> : <DocsView key={t.id} tab={t} active={t.id === activeId} platform={platform} />
        )}
        {tabs.length === 0 && <NoTabs />}
      </div>

      <footer className="statusbar">
        <span className="status-item">{conversion ? jobTitle(conversion).status : active ? 'Docs' : 'Dialect'}</span>
        <span className="status-item" data-testid="status-result">
          {error ? (
            <>
              <ErrorIcon /> Syntax error, line {error.line}
            </>
          ) : conversion ? (
            outputSummary(conversion)
          ) : (
            ''
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
      <NewTabDialog />
      <CloseDialog platform={platform} />
      <ExitDialog platform={platform} />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop a config file to open it
        </div>
      )}
    </div>
  )
}
