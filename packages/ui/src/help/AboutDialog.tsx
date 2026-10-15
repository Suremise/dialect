// Help → About Dialect: the version, the build, the browser engine and the OS, the license links into the Docs, the
// disclaimer, the copyright and the independence notice, and Copy for the version information (modelled on Hive's About dialog).
import { useEffect, useRef, useState } from 'react'
import iconUrl from '../../../../branding/icon-small.svg'
import type { Platform } from '../platform'
import { useStore } from '../store'
import { DISCLAIMER, NOTICE, TAGLINE } from './about'
import type { DocId } from './docs'
import { engineVersion, osVersion } from './engine'
import { useHelp } from './state'

export function AboutDialog({ platform }: { platform: Platform }) {
  const { aboutOpen, setAboutOpen } = useHelp()
  const showDocs = (page: DocId): void => {
    setAboutOpen(false)
    useStore.getState().openDocs(page)
  }
  const [engine, setEngine] = useState<string>('…')
  const [os, setOs] = useState<string | null>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!aboutOpen) return
    let live = true
    void engineVersion(platform.kind).then((e) => live && setEngine(e))
    void osVersion().then((o) => live && setOs(o))
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
    [platform.kind === 'desktop' ? 'WebView' : 'Browser', engine],
    ...(os ? [['OS', os] as [string, string]] : [])
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
        <p className="about-tagline">{TAGLINE}</p>
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
        <p className="about-license">
          Open source under the{' '}
          <button className="link" onClick={() => showDocs('license')}>
            MIT License
          </button>
          . Includes{' '}
          <button className="link" onClick={() => showDocs('notices')}>
            third-party software
          </button>
          .
        </p>
        <p className="about-disclaimer" data-testid="about-disclaimer">
          {DISCLAIMER}
        </p>
        <p className="about-notice" data-testid="about-notice">
          {NOTICE}
        </p>
        <div className="modal-footer">
          <button className="btn" onClick={copy}>
            Copy
          </button>
          <button className="btn" onClick={() => showDocs('changelog')}>
            Release Notes
          </button>
          <button className="btn primary" ref={okRef} onClick={() => setAboutOpen(false)}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
