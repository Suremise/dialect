// The standalone dialect.exe (scripts/build-exe.mjs, #89): built into a temp folder and run with no Node on the PATH,
// as on a machine without Node. It's this Node's node.exe, so it builds only with the Node scripts/notices/node.md is
// for (CI's desktop job pins it); with any other, these tests are skipped and say why.
import { spawnSync } from 'child_process'
import { readFileSync, rmSync } from 'fs'
import { delimiter, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { childEnv } from '../../../tests/childEnv'
import { tempDir } from '../../../tests/tempDir'

const cliRoot = join(__dirname, '..')
const CONVERT = join(__dirname, 'fixtures/convert')
const noticed = /Node\.js v(\d+\.\d+\.\d+)/.exec(readFileSync(join(cliRoot, '..', '..', 'scripts', 'notices', 'node.md'), 'utf8'))?.[1]
const skip = process.platform !== 'win32' ? 'Windows only' : noticed !== process.versions.node ? `needs Node ${noticed}, the notice's (this is ${process.versions.node})` : ''

/** The environment with every folder holding a node.exe taken off the PATH, whatever case its name has here. */
function withoutNode(): NodeJS.ProcessEnv {
  const env = childEnv()
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  const folders = pathKeys.flatMap((k) => (env[k] ?? '').split(delimiter)).filter((f) => f && !spawnSync('cmd', ['/c', 'if', 'exist', join(f, 'node.exe'), 'exit', '1']).status)
  for (const k of pathKeys) delete env[k]
  return { ...env, Path: folders.join(delimiter) }
}

describe.skipIf(skip)(`the standalone dialect.exe${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let dir: string
  let exe: string
  const env = skip ? {} : withoutNode()
  const dialect = (args: string[], input?: string) => {
    const r = spawnSync(exe, args, { input, cwd: dir, env, encoding: 'utf8', timeout: 30_000 })
    if (r.error) throw r.error
    return r
  }

  beforeAll(() => {
    dir = tempDir('dialect-exe-')
    const built = spawnSync(process.execPath, [join(cliRoot, 'scripts', 'build-exe.mjs'), dir], { env: childEnv(), encoding: 'utf8', timeout: 180_000 })
    expect(built.status, built.stderr).toBe(0)
    exe = join(dir, 'dialect.exe')
  }, 200_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('runs where no node.exe is on the PATH', () => {
    expect(spawnSync('cmd', ['/c', 'where', 'node'], { env, encoding: 'utf8' }).status).not.toBe(0)
    const r = dialect(['--version'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`dialect ${JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version}\n`)
  })

  it('reads stdin and gives usage errors as the .mjs build does', () => {
    expect(dialect(['display-set', '-'], 'system { host-name r1; }\n')).toMatchObject({ status: 0, stdout: 'set system host-name r1\n' })
    expect(dialect(['nosuch']).status).toBe(2)
  })

  it('converts with an interface map, as the .mjs build does', () => {
    const r = dialect(['convert', '--from', 'junos', '--to', 'iosxe', '--map', join(CONVERT, 'phase1.map.csv'), join(CONVERT, 'phase1.conf')])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(readFileSync(join(CONVERT, 'phase1.iosxe'), 'utf8'))
  })

  it("carries no broken signature: node.exe's is taken off", () => {
    const file = readFileSync(exe)
    const pe = file.readUInt32LE(0x3c)
    const optional = pe + 24
    const security = optional + (file.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8
    expect([file.readUInt32LE(security), file.readUInt32LE(security + 4)]).toEqual([0, 0])
  })
})
