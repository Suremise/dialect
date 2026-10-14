// The desktop app's own code without building it: the Platform over the dialog, fs and opener plugins and the window API
// (mocked), and the Tauri
// config and capability that make the app what the card asks for (an NSIS installer only, per user, zlib; a strict CSP;
// file access only through what the user picks). The built app is tested by the smoke test (e2e/).
import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }))
const fs = vi.hoisted(() => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }))
const opener = vi.hoisted(() => ({ openUrl: vi.fn() }))
const appWindow = vi.hoisted(() => ({ close: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/plugin-fs', () => fs)
vi.mock('@tauri-apps/plugin-opener', () => opener)
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }))

const { baseName, desktopPlatform, FILTERS } = await import('../src/desktopPlatform')

const tauri = join(__dirname, '..', 'src-tauri')
const config = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'))
const capability = JSON.parse(readFileSync(join(tauri, 'capabilities', 'default.json'), 'utf8'))

beforeEach(() => {
  vi.resetAllMocks()
})

describe('the desktop platform', () => {
  it('opens the file the user picks, by its name, with its path for the tab', async () => {
    dialog.open.mockResolvedValue('C:\\Users\\me\\configs\\edge-1.conf')
    fs.readTextFile.mockResolvedValue('system { host-name edge-1; }\n')
    expect(await desktopPlatform.openFile()).toEqual({ name: 'edge-1.conf', text: 'system { host-name edge-1; }\n', path: 'C:\\Users\\me\\configs\\edge-1.conf' })
    expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }))
    expect(fs.readTextFile).toHaveBeenCalledWith('C:\\Users\\me\\configs\\edge-1.conf')
  })

  it('reads nothing when the user cancels the open dialog', async () => {
    dialog.open.mockResolvedValue(null)
    expect(await desktopPlatform.openFile()).toBeNull()
    expect(fs.readTextFile).not.toHaveBeenCalled()
  })

  it('saves to the path the user picks, suggesting the name, and says where; writes nothing when they cancel', async () => {
    dialog.save.mockResolvedValue('D:\\out\\edge-1.set')
    expect(await desktopPlatform.saveText('edge-1.set', 'set system host-name edge-1\n')).toEqual({ path: 'D:\\out\\edge-1.set' })
    expect(dialog.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'edge-1.set' }))
    expect(fs.writeTextFile).toHaveBeenCalledWith('D:\\out\\edge-1.set', 'set system host-name edge-1\n')
    dialog.save.mockResolvedValue(null)
    fs.writeTextFile.mockClear()
    expect(await desktopPlatform.saveText('edge-1.set', 'x')).toBeNull()
    expect(fs.writeTextFile).not.toHaveBeenCalled()
  })

  it('saves again to a path a save gave, without a dialog', async () => {
    await desktopPlatform.saveTextTo!('D:\\out\\edge-1.set', 'set system host-name edge-2\n')
    expect(dialog.save).not.toHaveBeenCalled()
    expect(fs.writeTextFile).toHaveBeenCalledWith('D:\\out\\edge-1.set', 'set system host-name edge-2\n')
  })

  it('exits by closing its window (File → Exit)', async () => {
    await desktopPlatform.exit!()
    expect(appWindow.close).toHaveBeenCalledOnce()
  })

  it('offers config files, or interface maps (CSV or JSON) when it opens or saves one', async () => {
    dialog.open.mockResolvedValue(null)
    dialog.save.mockResolvedValue(null)
    await desktopPlatform.openFile()
    expect(dialog.open).toHaveBeenLastCalledWith(expect.objectContaining({ filters: FILTERS.config }))
    await desktopPlatform.openFile('interface-map')
    expect(dialog.open).toHaveBeenLastCalledWith(expect.objectContaining({ filters: FILTERS['interface-map'] }))
    await desktopPlatform.saveText('interfaces.csv', 'ge-0/0/0,Gi1\n', 'interface-map')
    expect(dialog.save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: 'interfaces.csv', filters: FILTERS['interface-map'] }))
    expect(FILTERS['interface-map'][0].extensions).toEqual(['csv', 'json', 'txt'])
  })

  it('reads a dropped file from the drop event, not through the fs plugin', async () => {
    const file = new File(['interfaces { }\n'], 'dropped.conf')
    expect(await desktopPlatform.openDropped({ files: [file] } as unknown as DataTransfer)).toEqual({ name: 'dropped.conf', text: 'interfaces { }\n' })
    expect(await desktopPlatform.openDropped({ files: [] } as unknown as DataTransfer)).toBeNull()
    expect(fs.readTextFile).not.toHaveBeenCalled()
  })

  it('says it is the desktop build, with the repo version, and opens links with the opener plugin', async () => {
    expect(desktopPlatform.kind).toBe('desktop')
    expect(desktopPlatform.version).toBe(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version)
    await desktopPlatform.openLink('https://github.com/cure53/DOMPurify')
    expect(opener.openUrl).toHaveBeenCalledWith('https://github.com/cure53/DOMPurify')
  })

  it('names a file from a Windows or POSIX path', () => {
    expect(baseName('C:\\a\\b\\c.conf')).toBe('c.conf')
    expect(baseName('/home/me/c.conf')).toBe('c.conf')
    expect(baseName('c.conf')).toBe('c.conf')
  })
})

describe('the Tauri config', () => {
  it('builds an NSIS installer only, per user, with zlib, the default WebView2 mode and the signing hook', () => {
    expect(config.bundle.targets).toEqual(['nsis'])
    expect(config.bundle.windows.nsis).toEqual({ installMode: 'currentUser', compression: 'zlib' })
    // The default (downloadBootstrapper): not set.
    expect(config.bundle.windows.webviewInstallMode).toBeUndefined()
    expect(config.bundle.windows.signCommand).toBe('node ../scripts/sign.mjs %1')
  })

  it('takes its icons from branding/out', () => {
    for (const icon of config.bundle.icon) expect(icon).toMatch(/^\.\.\/\.\.\/\.\.\/branding\/out\/icon[-\w]*\.(png|ico)$/)
    expect(config.bundle.icon).toContain('../../../branding/out/icon.ico')
  })

  it('has a strict CSP: nothing remote, no inline code, IPC only', () => {
    const csp = config.app.security.csp as Record<string, string>
    expect(csp['default-src']).toBe("'none'")
    expect(csp['script-src']).toBe("'self'")
    expect(csp['style-src']).toBe("'self'")
    expect(csp['connect-src']).toBe('ipc: http://ipc.localhost')
    for (const directive of ['base-uri', 'form-action', 'object-src']) expect(csp[directive]).toBe("'none'")
    const all = Object.values(csp).join(' ')
    expect(all).not.toMatch(/unsafe-|https?:\/\/(?!ipc\.localhost)|\*|blob:/)
    expect(config.app.security.dangerousDisableAssetCspModification).toBeUndefined()
  })

  it('leaves drops to the page, so a dropped file goes through the Platform', () => {
    expect(config.app.windows.map((w: { dragDropEnabled: boolean }) => w.dragDropEnabled)).toEqual([false])
  })

  it('lets the page open and save only through the dialogs, with no fs scope of its own, open https links only, and close its window', () => {
    expect(capability.windows).toEqual(['main'])
    expect(capability.permissions).toEqual([
      'core:window:allow-close',
      'dialog:allow-open',
      'dialog:allow-save',
      'fs:allow-read-text-file',
      'fs:allow-write-text-file',
      { identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] }
    ])
  })
})
