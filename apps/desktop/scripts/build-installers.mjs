// Builds both Windows installers of one Dialect (Darren's decision on #89: ship both), into
// src-tauri/target/release/bundle/nsis/:
// - Dialect_<version>_x64-setup.exe: tauri.conf.json as it is, with Microsoft's WebView2 bootstrapper inside
//   (`embedBootstrapper`, a few MB). A PC without WebView2 (rare: Windows 11 and an updated Windows 10 have it) needs
//   internet while installing;
// - Dialect_<version>_x64-offline-setup.exe: the same app with Microsoft's offline WebView2 installer inside
//   (`offlineInstaller`, about 130 MB more), for a PC with no internet. Tauri downloads that installer while building.
// Both carry the dialect command (packages/cli's dialect.exe) and the PATH option (src-tauri/windows/hooks.nsh). Run with
// `npm run build:installers -w @dialect/desktop` (needs Rust, as `npm run build` does). Never run an installer here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(app, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const out = join(app, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const setup = join(out, `Dialect_${version}_x64-setup.exe`)
const offline = join(out, `Dialect_${version}_x64-offline-setup.exe`)
const tauri = (...args) => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tauri', 'build', ...args], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' })

// The offline one first, renamed out of the way, then the normal one, which keeps Tauri's own name. The offline mode is
// a config file merged over tauri.conf.json (a file, as Windows's shell would strip JSON's quotes on the command line).
rmSync(offline, { force: true })
const override = join(app, 'src-tauri', 'target', 'offline.conf.json')
mkdirSync(dirname(override), { recursive: true })
writeFileSync(override, JSON.stringify({ bundle: { windows: { webviewInstallMode: { type: 'offlineInstaller', silent: true } } } }))
tauri('--config', override)
renameSync(setup, offline)
tauri()
for (const file of [setup, offline]) if (!existsSync(file)) throw new Error(`build-installers: ${file} wasn't built`)
console.log(`build-installers:\n  ${setup}\n  ${offline}`)
