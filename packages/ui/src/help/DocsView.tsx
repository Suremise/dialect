// The Docs view, in place of the display set panes: the bundled user guide, release notes, license and third-party
// notices (docs.ts), one page at a time, with About at the end of the list, as in Hive.
import { useEffect, useRef } from 'react'
import type { Platform } from '../platform'
import { useStore } from '../store'
import { DOCS, docForLink } from './docs'
import { Markdown } from './Markdown'
import { useHelp } from './state'

export function DocsView({ platform }: { platform: Platform }) {
  const { docsPage, showDocs, closeDocs, setAboutOpen } = useHelp()
  const doc = DOCS.find((d) => d.id === docsPage) ?? DOCS[0]
  const pageRef = useRef<HTMLDivElement>(null)

  // A new page starts at its top.
  useEffect(() => {
    pageRef.current?.scrollTo(0, 0)
  }, [doc.id])

  const openExternal = (url: string): void => {
    platform.openLink(url).catch((e: Error) => useStore.getState().notify('error', `Couldn't open the link: ${e.message}`))
  }

  return (
    <main className="docs" aria-label="Docs">
      <nav className="docs-nav" aria-label="Documents">
        <div className="docs-nav-header">Docs</div>
        {DOCS.map((d) => (
          <button key={d.id} className={`docs-nav-item${d.id === doc.id ? ' selected' : ''}`} aria-current={d.id === doc.id ? 'page' : undefined} onClick={() => showDocs(d.id)}>
            {d.label}
          </button>
        ))}
        <button className="docs-nav-item" onClick={() => setAboutOpen(true)}>
          About Dialect
        </button>
        <span className="docs-nav-spacer" />
        <button className="btn docs-back" onClick={closeDocs} title="Back to the display set (Esc)">
          ← Display set
        </button>
      </nav>
      <div className="docs-page" ref={pageRef} data-doc={doc.id}>
        <Markdown
          source={doc.source}
          onDoc={(href) => {
            const target = docForLink(href)
            if (target) showDocs(target.id)
            return !!target
          }}
          onExternal={openExternal}
        />
      </div>
    </main>
  )
}
