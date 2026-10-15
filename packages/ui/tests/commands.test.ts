// The command registry without a browser: every menu item's command is there once, with its keys; a key event finds the
// command it belongs to, leaving the editors their own (Undo, Redo); the web build shows the browser-safe keys first; and
// Exit is only in a shell that can quit.
import { describe, expect, it, vi } from 'vitest'
import { createCommands, eventToKey, formatKey, keysOf, matchKey } from '../src/commands'
import { RELEASES_URL } from '../src/help/about'
import type { Platform } from '../src/platform'

const shell = (kind: Platform['kind'], exit?: () => Promise<void>): Platform => ({
  kind,
  version: '0.0.0',
  openFile: async () => null,
  openDropped: async () => null,
  saveText: async () => ({}),
  readClipboard: async () => '',
  writeClipboard: async () => {},
  openLink: async () => {},
  ...(exit ? { exit } : {})
})

const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, keyName = code.replace(/^Key|^Digit/, '')) => ({
  key: keyName,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: false,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift
})

describe('the commands', () => {
  const desktop = createCommands(shell('desktop', async () => {}))
  const web = createCommands(shell('web'))

  it('have unique ids, and no two share a key', () => {
    const ids = desktop.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = desktop.flatMap((c) => [...(c.keys ?? []), ...(c.webKeys ?? [])].map((k) => k.toUpperCase()))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('open the releases page outside the app, from Help → Releases on GitHub', async () => {
    const openLink = vi.fn(async () => {})
    const releases = createCommands({ ...shell('web'), openLink }).find((c) => c.id === 'help.releases')!
    expect(releases.label).toBe('Releases on GitHub')
    await releases.run()
    expect(openLink).toHaveBeenCalledWith(RELEASES_URL)
    expect(RELEASES_URL).toBe('https://github.com/Suremise/dialect/releases')
  })

  it('have Exit only where the shell can quit', () => {
    expect(desktop.some((c) => c.id === 'app.exit')).toBe(true)
    expect(web.some((c) => c.id === 'app.exit')).toBe(false)
  })

  it.each([
    [key('KeyT', { ctrl: true }), 'tab.new'],
    [key('KeyT', { alt: true }), 'tab.new'],
    [key('KeyW', { ctrl: true }), 'tab.close'],
    [key('KeyS', { ctrl: true }), 'file.save'],
    [key('KeyS', { ctrl: true, shift: true }, 'S'), 'file.saveAs'],
    [key('Tab', { ctrl: true }, 'Tab'), 'window.next'],
    [key('Tab', { ctrl: true, shift: true }, 'Tab'), 'window.previous'],
    [key('PageDown', { alt: true }, 'PageDown'), 'window.next'],
    // Shift doesn't rename a digit: Ctrl+2 is "2" whatever the layout gives.
    [key('Digit2', { ctrl: true }, '2'), 'window.tab2'],
    [key('Digit1', { alt: true }, '1'), 'window.tab1'],
    [key('F1', {}, 'F1'), 'help.guide']
  ])('%o runs %s', (event, id) => {
    expect(matchKey(desktop, event)?.id).toBe(id)
  })

  it('leave Undo and Redo to the editor, and run nothing for a lone modifier or an unbound key', () => {
    expect(matchKey(desktop, key('KeyZ', { ctrl: true }))).toBeUndefined()
    expect(matchKey(desktop, key('KeyY', { ctrl: true }))).toBeUndefined()
    expect(matchKey(desktop, { key: 'Control', code: 'ControlLeft', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeUndefined()
    expect(matchKey(desktop, key('KeyQ', { ctrl: true }))).toBeUndefined()
    expect(eventToKey(key('KeyS', { ctrl: true, shift: true }))).toBe('Mod+Shift+S')
  })

  it("show the browser-safe keys first in the web build, the app's own in the desktop app", () => {
    const newTab = desktop.find((c) => c.id === 'tab.new')!
    expect(keysOf(newTab, 'desktop').map(formatKey)).toEqual(['Ctrl+T', 'Alt+T'])
    expect(keysOf(newTab, 'web').map(formatKey)).toEqual(['Alt+T', 'Ctrl+T'])
    expect(formatKey('Mod+PageDown')).toBe('Ctrl+PgDn')
  })
})
