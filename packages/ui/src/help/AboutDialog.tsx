// Help → About Dialect: the version, the build, the browser engine, the vendor disclaimer, links into the Docs, and
// Copy for the version information (Hive's About dialog, smaller).
import { useEffect, useRef, useState } from 'react'
import iconUrl from '../../../../branding/icon-small.svg'
import type { Platform } from '../platform'
import { useStore } from '../store'
import { DOCS } from './docs'
import { engineVersion } from './engine'
import { useHelp } from './state'

export const DISCLAIMER = 'Dialect is not affiliated with or endorsed by Juniper Networks or Cisco Systems.'

export function AboutDialog({ platform }: { platform: Platform }) {
  const { aboutOpen, setAboutOpen, showDocs } = useHelp()
  const [engine, setEngine] = useState<string>('…')
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!aboutOpen) return
    let live = true
    void engineVersion(platform.kind).then((e) => live && setEngine(e))
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAboutOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      live = false
      window.removeEventListener('keydown', onKey)
    }
  }, [aboutOpen, platform])

  if (!aboutOpen) return null
  const rows: [string, string][] = [
    ['Version', platform.version],
    ['Build', platform.kind === 'desktop' ? 'Desktop app' : 'Web build'],
    [platform.kind === 'desktop' ? 'WebView' : 'Browser', engine]
  ]
  const copy = (): void => {
    const text = [`Dialect ${platform.version}`, ...rows.slice(1).map(([k, v]) => `${k}: ${v}`)].join('\n') + '\n'
    platform.writeClipboard(text).then(
      () => useStore.getState().notify('info', 'Version information copied.'),
      (e: Error) => useStore.getState().notify('error', `Couldn't copy: ${e.message}`)
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAboutOpen(false)}>
      <div className="modal about" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <img className="about-icon" src={iconUrl} alt="" width="56" height="56" />
        <h1 id="about-title">Dialect</h1>
        <p className="about-tagline">Translates network device configs between vendor dialects.</p>
        <table className="about-table" data-testid="about-info">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="about-disclaimer">{DISCLAIMER}</p>
        <p className="about-docs">
          {DOCS.map((d) => (
            <button key={d.id} className="link" onClick={() => showDocs(d.id)}>
              {d.label}
            </button>
          ))}
        </p>
        <div className="modal-footer">
          <button className="btn" onClick={copy}>
            Copy
          </button>
          <button className="btn primary" ref={okRef} onClick={() => setAboutOpen(false)}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
