// Builds the standalone dialect.exe, the dialect command with no Node.js to install: a Node single executable application
// (https://nodejs.org/api/single-executable-applications.html). The command is bundled into one CommonJS script
// (vite.config.ts, `--mode sea`), Node turns it into a blob, and postject puts the blob into a copy of the node.exe that
// runs this script (Node 24), whose license and bundled components' licenses ship with it (scripts/notices). Windows
// only, as the installer and the release are. Run with `npm run build:exe -w @dialect/cli`; writes dist/dialect.exe, or
// with a folder as its argument, <folder>/dialect.exe (the tests build into a temp folder).
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postject from 'postject'
import { build } from 'vite'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const out = process.argv[2] ? resolve(process.argv[2]) : join(pkg, 'dist')
const work = join(out, 'sea')
const exe = join(out, 'dialect.exe')
/** The fuse Node looks for to know a blob was injected (Node's documented sentinel). */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

if (process.platform !== 'win32') {
  console.error('build-exe: builds the Windows dialect.exe, on Windows only')
  process.exit(1)
}

// The exe is the node.exe running this, so the notices must be for that Node: its LICENSE lists what it ships.
const notice = readFileSync(join(pkg, '..', '..', 'scripts', 'notices', 'node.md'), 'utf8')
const noticed = /Node\.js v(\d+\.\d+\.\d+)/.exec(notice)?.[1]
if (noticed !== process.versions.node) {
  console.error(`build-exe: this is Node ${process.versions.node}, but scripts/notices/node.md is for Node ${noticed}: build with Node ${noticed}, or update the notice to this Node's LICENSE (https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE)`)
  process.exit(1)
}

/**
 * Takes a PE file's Authenticode signature off: the attribute certificate table the security data directory points at,
 * which ends the file. node.exe is signed by the OpenJS Foundation; once the blob is in, that signature no longer holds,
 * and an exe with a broken signature looks worse to Windows than an unsigned one. Dialect's own signing (the desktop
 * app's scripts/sign.mjs) can sign the result when there is a certificate.
 */
function stripSignature(path) {
  const file = readFileSync(path)
  const pe = file.readUInt32LE(0x3c)
  if (file.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('build-exe: node.exe is not a PE file')
  const optional = pe + 24
  const magic = file.readUInt16LE(optional)
  // The data directories follow the optional header's fixed part: 96 bytes in PE32, 112 in PE32+. Security is entry 4.
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8
  const offset = file.readUInt32LE(security)
  const size = file.readUInt32LE(security + 4)
  if (!offset || !size) return file
  if (offset + size !== file.length) throw new Error('build-exe: node.exe has data after its signature')
  file.writeUInt32LE(0, security)
  file.writeUInt32LE(0, security + 4)
  writeFileSync(path, file.subarray(0, offset))
}

await build({ root: pkg, configFile: join(pkg, 'vite.config.ts'), mode: 'sea', logLevel: 'warn', build: { outDir: work } })
const config = join(work, 'sea-config.json')
const blob = join(work, 'dialect.blob')
writeFileSync(config, JSON.stringify({ main: join(work, 'dialect.cjs'), output: blob, disableExperimentalSEAWarning: true }, null, 2))
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
copyFileSync(process.execPath, exe)
stripSignature(exe)
await postject.inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: FUSE })
console.log(`build-exe: ${exe} (Node ${process.versions.node})`)
