// A Docs tab's page: one of the bundled documents (docs.ts), the user guide, release notes, license or third-party
// notices, with the list of them beside it, as in Hive. Each page has its own tab: the list and a link to another
// document open that page's tab, or show it if it's open.
import { useRef } from 'react'
import { panelDomId, tabDomId } from '../components/TabStrip'
import type { Platform } from '../platform'
import { useStore, type DocsTab } from '../store'
import { DOCS, docForLink } from './docs'
import { Markdown } from './Markdown'
import { useHelp } from './state'

export function DocsView({ tab, active, platform }: { tab: DocsTab; active: boolean; platform: Platform }) {
  const doc = DOCS.find((d) => d.id === tab.page) ?? DOCS[0]
  const { openDocs, notify } = useStore.getState()
  const pageRef = useRef<HTMLDivElement>(null)

  const openExternal = (url: string): void => {
    platform.openLink(url).catch((e: Error) => notify('error', `Couldn't open the link: ${e.message}`))
  }

  return (
    <div className="docs" id={panelDomId(tab.id)} role="tabpanel" aria-labelledby={tabDomId(tab.id)} hidden={!active} data-tab={tab.id}>
      <nav className="docs-nav" aria-label="Documents">
        <div className="docs-nav-header">Docs</div>
        {DOCS.map((d) => (
          <button key={d.id} className={`docs-nav-item${d.id === doc.id ? ' selected' : ''}`} aria-current={d.id === doc.id ? 'page' : undefined} onClick={() => openDocs(d.id)}>
            {d.label}
          </button>
        ))}
        <button className="docs-nav-item" onClick={() => useHelp.getState().setAboutOpen(true)}>
          About Dialect
        </button>
      </nav>
      <div className="docs-page" ref={pageRef} data-doc={doc.id}>
        <Markdown
          source={doc.source}
          onDoc={(href) => {
            const target = docForLink(href)
            if (target) openDocs(target.id)
            return !!target
          }}
          onExternal={openExternal}
        />
      </div>
    </div>
  )
}
