// The web build's file and clipboard access: a file picker, downloads, and the browser's clipboard (with the older
// copy command as a fallback, since a page opened from file:// may not get the clipboard API).
import type { OpenedFile, Platform } from '@dialect/ui'
// Dialect's version: the repo's (Vite keeps only this field).
import { version } from '../../../package.json'

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.conf,.cfg,.txt,.junos,text/plain'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

function copyWithCommand(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'offscreen'
  document.body.append(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('the browser refused to copy')
}

export const webPlatform: Platform = {
  kind: 'web',
  version,
  async openFile(): Promise<OpenedFile | null> {
    const file = await pickFile()
    return file ? { name: file.name, text: await file.text() } : null
  },
  openDropped(data) {
    // Taken now: the drop event's files are only there while it's being handled.
    const file = data.files[0]
    if (!file) return Promise.resolve(null)
    return file.text().then((text) => ({ name: file.name, text }))
  },
  async saveText(suggestedName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = suggestedName
    document.body.append(link)
    link.click()
    link.remove()
    // The download has its own copy once it starts; let it start first.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  },
  async readClipboard() {
    if (!navigator.clipboard?.readText) throw new Error('no clipboard API')
    return navigator.clipboard.readText()
  },
  async writeClipboard(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API')
      await navigator.clipboard.writeText(text)
    } catch {
      copyWithCommand(text)
    }
  },
  async openLink(url) {
    // A new tab, which may go online: the page itself still can't (its CSP).
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
