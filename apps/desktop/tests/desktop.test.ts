// The desktop app's own code without building it: the Platform over the dialog, fs and opener plugins and the window API
// (mocked), the tray's New tab, and the Tauri config and capability that make the app what the cards ask for (an NSIS
// installer only, per user, zlib, with the Dialect icon; a strict CSP; file access only through what the user picks; a
// tray icon whose menu needs no permission). The built app is tested by the smoke test (e2e/).
import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }))
const fs = vi.hoisted(() => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }))
const opener = vi.hoisted(() => ({ openUrl: vi.fn() }))
const appWindow = vi.hoisted(() => ({ close: vi.fn(), destroy: vi.fn(), onCloseRequested: vi.fn() }))
const event = vi.hoisted(() => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/plugin-fs', () => fs)
vi.mock('@tauri-apps/plugin-opener', () => opener)
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }))
vi.mock('@tauri-apps/api/event', () => event)

const { baseName, desktopPlatform, FILTERS } = await import('../src/desktopPlatform')
const { listenToTray, NEW_TAB_EVENT } = await import('../src/tray')
const { useStore } = await import('@dialect/ui')

const tauri = join(__dirname, '..', 'src-tauri')
const config = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'))
const capability = JSON.parse(readFileSync(join(tauri, 'capabilities', 'default.json'), 'utf8'))
const mainRs = readFileSync(join(tauri, 'src', 'main.rs'), 'utf8')
const cargo = readFileSync(join(tauri, 'Cargo.toml'), 'utf8')
const branding = join(__dirname, '..', '..', '..', 'branding', 'out')
/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (path: string): [number, number] => {
  const png = readFileSync(path)
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

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

  it('exits by destroying its window (File → Exit, asked already), not by asking the close guard again', async () => {
    await desktopPlatform.exit!()
    expect(appWindow.destroy).toHaveBeenCalledOnce()
    expect(appWindow.close).not.toHaveBeenCalled()
  })

  it("guards the window's own close: kept open while the UI says not yet, and the guard stops", async () => {
    const unlisten = vi.fn()
    appWindow.onCloseRequested.mockResolvedValue(unlisten)
    let may = false
    const stop = desktopPlatform.guardClose!(() => may)
    const handler = appWindow.onCloseRequested.mock.calls[0][0] as (event: { preventDefault: () => void }) => void
    const kept = { preventDefault: vi.fn() }
    handler(kept)
    expect(kept.preventDefault).toHaveBeenCalledOnce()
    may = true
    const closed = { preventDefault: vi.fn() }
    handler(closed)
    expect(closed.preventDefault).not.toHaveBeenCalled()
    stop()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce())
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
  it('builds an NSIS installer only, per user, with zlib, its hooks, the WebView2 bootstrapper inside and the signing hook', () => {
    expect(config.bundle.targets).toEqual(['nsis'])
    expect(config.bundle.windows.nsis).toEqual({ installMode: 'currentUser', compression: 'zlib', installerIcon: '../../../branding/out/icon.ico', uninstallerIcon: '../../../branding/out/icon.ico', installerHooks: 'windows/hooks.nsh' })
    // Darren's choice C (#89): this installer embeds the bootstrapper; scripts/build-installers.mjs builds the offline one.
    expect(config.bundle.windows.webviewInstallMode).toEqual({ type: 'embedBootstrapper' })
    expect(config.bundle.windows.signCommand).toBe('node ../scripts/sign.mjs %1')
  })

  it('installs the standalone dialect command as cli\\dialect.exe, built before the app (the app is dialect.exe)', () => {
    expect(config.bundle.resources).toEqual({ '../../../packages/cli/dist/dialect.exe': 'cli/dialect.exe' })
    expect(config.build.beforeBuildCommand).toBe('npm run frontend && npm run build:exe -w @dialect/cli')
  })

  it("asks to put the command on the user's PATH after installing (yes by default, also silent), and takes it off on uninstall", () => {
    const hooks = readFileSync(join(tauri, 'windows', 'hooks.nsh'), 'utf8')
    const macro = (name: string) => hooks.slice(hooks.indexOf(`!macro ${name}`), hooks.indexOf('!macroend', hooks.indexOf(`!macro ${name}`)))
    expect(macro('NSIS_HOOK_POSTINSTALL')).toMatch(/MessageBox MB_YESNO\|MB_ICONQUESTION ".*PATH.*" \/SD IDYES IDNO \w+/)
    expect(macro('NSIS_HOOK_POSTINSTALL')).toContain('!insertmacro DIALECT_EDIT_PATH 1')
    expect(macro('NSIS_HOOK_POSTUNINSTALL')).toContain('!insertmacro DIALECT_EDIT_PATH 0')
    // The user's PATH (no admin), unexpanded, with the folder passed in an environment variable, never quoted into a command.
    const edit = macro('DIALECT_EDIT_PATH')
    expect(edit).toContain("'HKCU:\\Environment'")
    expect(edit).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')")
    expect(edit).toContain('-Type ExpandString')
    expect(edit).toContain('SetEnvironmentVariable(t "DIALECT_CLI_DIR", t "$INSTDIR\\cli")')
    expect(edit).not.toMatch(/-Command "[^"]*\$INSTDIR/)
  })

  it('gives the installer (the setup file and its window) and the uninstaller the Dialect icon', () => {
    expect(config.bundle.windows.nsis.installerIcon).toBe('../../../branding/out/icon.ico')
    expect(config.bundle.windows.nsis.uninstallerIcon).toBe('../../../branding/out/icon.ico')
    // Tauri's own icon list is what the app's .exe and its window carry: the .ico, from the same masters.
    expect(config.bundle.icon).toContain(config.bundle.windows.nsis.installerIcon)
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
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-close',
      'core:window:allow-destroy',
      'dialog:allow-open',
      'dialog:allow-save',
      'fs:allow-read-text-file',
      'fs:allow-write-text-file',
      { identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] }
    ])
  })
})

describe('the tray icon', () => {
  it("has the tray feature only: its icon is decoded when the app is built, so no image decoder ships", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "[^"]+", features = \["tray-icon"\] \}$/m)
    expect(mainRs).toContain('tauri::include_image!("../../../branding/out/tray-32.png")')
  })

  it('is made from branding/tray.svg at 16 and 32 px', () => {
    expect(pngSize(join(branding, 'tray-16.png'))).toEqual([16, 16])
    expect(pngSize(join(branding, 'tray-32.png'))).toEqual([32, 32])
  })

  it('says Dialect, and its menu shows the window, opens a new tab and quits, in that order', () => {
    expect(mainRs).toContain('.tooltip("Dialect")')
    const items = [...mainRs.matchAll(/MenuItem::with_id\(app, "([^"]+)", "([^"]+)"/g)].map((m) => [m[1], m[2]])
    expect(items).toEqual([
      ['show', 'Show Dialect'],
      ['new-tab', 'New tab'],
      ['quit', 'Quit']
    ])
    // A left click shows the window; the menu is on the right button.
    expect(mainRs).toContain('.show_menu_on_left_click(false)')
  })

  it("quits as the window's own close does, so the close guard asks first while output is unsaved", () => {
    const quit = mainRs.slice(mainRs.indexOf('"quit" =>'))
    expect(quit.slice(0, quit.indexOf('_ =>'))).toMatch(/window\.close\(\)/)
    expect(mainRs).not.toMatch(/\.destroy\(\)|\.exit\(/)
  })

  it("opens the New Tab picker on the tray's event, which main.rs sends by the same name", async () => {
    expect(mainRs).toContain(`const NEW_TAB_EVENT: &str = "${NEW_TAB_EVENT}";`)
    const unlisten = vi.fn()
    event.listen.mockResolvedValue(unlisten)
    expect(await listenToTray()).toBe(unlisten)
    expect(event.listen).toHaveBeenCalledWith(NEW_TAB_EVENT, expect.any(Function))
    useStore.getState().setPickerOpen(false)
    ;(event.listen.mock.calls[0][1] as () => void)()
    expect(useStore.getState().pickerOpen).toBe(true)
    useStore.getState().setPickerOpen(false)
  })

  it('needs no permission of its own: its menu runs in Rust, and the page only listens', () => {
    expect(JSON.stringify(capability.permissions)).not.toMatch(/tray|menu|emit/)
  })
})
