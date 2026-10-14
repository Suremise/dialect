// A Markdown page: marked turns it into HTML and DOMPurify cleans that, as Hive's Markdown does. Headings get GitHub's
// ids ("Display set (Junos)" → display-set-junos), so a `#heading` link scrolls to it. No link navigates the page itself
// (the app would leave its own page): a link to another bundled document opens it, `#heading` scrolls, and an https link
// goes to `onExternal`; anything else does nothing.
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'

/** GitHub's id for a heading: lower case, punctuation dropped, spaces to hyphens. */
export const headingId = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

export function Markdown({ source, onDoc, onExternal }: { source: string; onDoc: (href: string) => boolean; onExternal: (url: string) => void }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false })), [source])
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const seen = new Map<string, number>()
    for (const h of ref.current?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []) {
      const id = headingId(h.textContent ?? '')
      const n = seen.get(id) ?? 0
      seen.set(id, n + 1)
      h.id = n ? `${id}-${n}` : id
    }
  }, [html])

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (onDoc(href)) return
    if (/^https:\/\//i.test(href)) onExternal(href)
    else if (href.startsWith('#')) e.currentTarget.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView()
  }
  return <div className="markdown" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
