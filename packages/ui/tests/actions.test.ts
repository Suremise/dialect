// The actions that wait for the shell (a file dialog, the clipboard, a dropped file being read): what comes back goes to
// the tab the action started in, even when another tab is shown by then, and nowhere (with a notice) when that tab has
// been closed meanwhile. The shell is a fake whose answers the test gives when it chooses.
import { beforeEach, describe, expect, it } from 'vitest'
import { dropFile, loadInterfaceMap, openFile, paste, reopen } from '../src/actions'
import type { OpenedFile, Platform } from '../src/platform'
import { DISPLAY_SET, useStore, type ConversionTab } from '../src/store'

/** A promise and the function that settles it, for an answer the test gives later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** A shell whose open, drop and clipboard answer only when the test says. */
function shell() {
  const pending = { open: deferred<OpenedFile | null>(), drop: deferred<OpenedFile | null>(), clipboard: deferred<string>() }
  const platform: Platform = {
    kind: 'web',
    version: '0.0.0',
    openFile: () => pending.open.promise,
    openDropped: () => pending.drop.promise,
    saveText: async () => ({}),
    readClipboard: () => pending.clipboard.promise,
    writeClipboard: async () => {},
    openLink: async () => {}
  }
  return { platform, pending }
}

const tab = (id: string): ConversionTab => useStore.getState().tabs.find((t): t is ConversionTab => t.id === id && t.kind === 'conversion')!
const CONVERT = { kind: 'convert', target: 'iosxe' } as const
const R1 = 'system { host-name r1; }'
const R2 = 'system { host-name r2; }'

/** Two display set tabs with their own configs, the second shown. */
function twoTabs(): [string, string] {
  useStore.setState({ tabs: [], activeId: null, closing: null, exiting: false, notice: null })
  const first = useStore.getState().newTab(DISPLAY_SET)
  useStore.getState().setSource(R1, 'r1.conf')
  const second = useStore.getState().newTab(DISPLAY_SET)
  useStore.getState().setSource(R2, 'r2.conf')
  return [first, second]
}

beforeEach(() => {
  twoTabs()
})

describe('an action the shell answers later', () => {
  it.each([
    ['Open…', (p: Platform, start: string) => openFile(p, start), 'open'],
    ['a drop', (p: Platform, start: string) => dropFile(p, {} as DataTransfer, start), 'drop']
  ] as const)('%s fills the tab it started in, though another is shown by then', async (_, act, which) => {
    const [first, second] = twoTabs()
    useStore.getState().activate(first)
    const { platform, pending } = shell()
    const done = act(platform, first)
    useStore.getState().activate(second)
    pending[which].resolve({ name: 'r9.conf', text: 'system { host-name r9; }' })
    await done
    expect([tab(first).sourceName, tab(first).output]).toEqual(['r9.conf', 'set system host-name r9'])
    expect([tab(second).sourceName, tab(second).source]).toEqual(['r2.conf', R2])
    expect(useStore.getState().activeId).toBe(second)
  })

  it('pastes into the tab it started in, and into no tab when that one has been closed', async () => {
    const [first, second] = twoTabs()
    useStore.getState().activate(first)
    const one = shell()
    const pasted = paste(one.platform, first)
    useStore.getState().activate(second)
    one.pending.clipboard.resolve('system { host-name pasted; }')
    await pasted
    expect([tab(first).sourceName, tab(first).output]).toEqual([null, 'set system host-name pasted'])
    expect(tab(second).source).toBe(R2)

    // Closed meanwhile (saved first, so it closes without asking): the text goes nowhere, and a notice says so.
    useStore.getState().markSaved(first, tab(first).output, null)
    const two = shell()
    const lost = paste(two.platform, first)
    useStore.getState().closeTab(first)
    two.pending.clipboard.resolve('system { host-name lost; }')
    await lost
    expect(useStore.getState().tabs.map((t) => t.id)).toEqual([second])
    expect(tab(second).source).toBe(R2)
    expect(useStore.getState().notice?.text).toBe('The tab was closed before the clipboard was read, so nothing was pasted.')
  })

  it('opens a file into no tab when the tab it started in has been closed, saying so', async () => {
    const [first, second] = twoTabs()
    useStore.getState().markSaved(first, tab(first).output, null)
    const { platform, pending } = shell()
    const done = openFile(platform, first)
    useStore.getState().closeTab(first)
    pending.open.resolve({ name: 'r9.conf', text: 'system { host-name r9; }' })
    await done
    expect(useStore.getState().tabs.map((t) => t.id)).toEqual([second])
    expect(tab(second).sourceName).toBe('r2.conf')
    expect(useStore.getState().notice?.text).toBe('The tab was closed before the file was read, so it was left unopened.')
  })

  it('opens a file asked for from a Docs tab in a new display set tab', async () => {
    useStore.getState().openDocs('guide')
    const { platform, pending } = shell()
    const done = openFile(platform)
    pending.open.resolve({ name: 'r9.conf', text: 'system { host-name r9; }' })
    await done
    const opened = useStore.getState().tabs.at(-1) as ConversionTab
    expect([opened.kind, opened.sourceName, useStore.getState().activeId]).toEqual(['conversion', 'r9.conf', opened.id])
  })

  it('reopens a restored tab in that tab', async () => {
    const [first, second] = twoTabs()
    const { platform, pending } = shell()
    const done = reopen(platform, first)
    expect(useStore.getState().activeId).toBe(first)
    useStore.getState().activate(second)
    pending.open.resolve({ name: 'r1.conf', text: R1 })
    await done
    expect(tab(first).source).toBe(R1)
    expect(tab(second).source).toBe(R2)
  })

  it("loads an interface map into the convert tab it started in, or none once that tab is closed", async () => {
    useStore.setState({ tabs: [], activeId: null, notice: null })
    const PHASE = 'interfaces { ge-0/0/0 { unit 0 { family inet { address 192.0.2.1/30; } } } }'
    const first = useStore.getState().newTab(CONVERT)
    useStore.getState().setSource(PHASE, 'a.conf')
    const second = useStore.getState().newTab(CONVERT)
    useStore.getState().setSource(PHASE, 'b.conf')
    const one = shell()
    const loaded = loadInterfaceMap(one.platform, first)
    useStore.getState().activate(second)
    one.pending.open.resolve({ name: 'names.csv', text: 'ge-0/0/0,Gi1\n' })
    await loaded
    expect({ ...tab(first).interfaceMap }).toEqual({ 'ge-0/0/0': 'Gi1' })
    expect({ ...tab(second).interfaceMap }).toEqual({})
    expect(useStore.getState().notice?.text).toBe('Loaded names.csv.')

    const two = shell()
    const lost = loadInterfaceMap(two.platform, second)
    useStore.getState().closeTab(second, true)
    two.pending.open.resolve({ name: 'names.csv', text: 'ge-0/0/0,Gi2\n' })
    await lost
    expect({ ...tab(first).interfaceMap }).toEqual({ 'ge-0/0/0': 'Gi1' })
    expect(useStore.getState().notice?.text).toBe('The tab was closed before the map was read, so it was left unloaded.')
  })
})
