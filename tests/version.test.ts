// Dialect's version is one version (scripts/version.mjs): the root package.json, every workspace and its @dialect/*
// dependencies, package-lock.json, tauri.conf.json, Cargo.toml and Cargo.lock all say the same, and setting it changes
// every place and nothing else, in a copy made in a temp folder.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { setVersion, versions, workspaces } from '../scripts/version.mjs'
import { tempDir } from './tempDir'

const repo = join(__dirname, '..')
const TAURI = 'apps/desktop/src-tauri/tauri.conf.json'
const CARGO = ['apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock']

type Found = { where: string; version: string | undefined }

describe("Dialect's version", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('is the same everywhere it is written', () => {
    const found = versions(repo) as Found[]
    const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }
    expect(found.filter((f) => f.version !== version)).toEqual([])
    // Every place is there: the root, each workspace, the lockfile, the installer's and the crate's.
    const places = found.map((f) => f.where)
    for (const ws of workspaces(repo) as string[]) expect(places).toContain(`${ws}/package.json`)
    for (const file of ['package.json', 'package-lock.json', TAURI, ...CARGO]) expect(places).toContain(file)
  })

  it('is set everywhere at once, changing nothing else', () => {
    dir = tempDir('dialect-version-')
    const files = ['package.json', 'package-lock.json', TAURI, ...CARGO, ...(workspaces(repo) as string[]).map((ws) => `${ws}/package.json`)]
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      cpSync(join(repo, file), join(dir, file))
    }
    const before = (versions(dir) as Found[]).map((f) => f.where)
    setVersion(dir, '9.8.7-beta.1')
    const after = versions(dir) as Found[]
    expect(after.map((f) => f.where)).toEqual(before)
    expect(after.filter((f) => f.version !== '9.8.7-beta.1')).toEqual([])
    // Only the versions changed: put the repo's back, and each file is the repo's again, layout and all.
    setVersion(dir, (versions(repo) as Found[])[0].version)
    for (const file of files) expect(readFileSync(join(dir, file), 'utf8'), file).toBe(readFileSync(join(repo, file), 'utf8'))
    expect(() => setVersion(dir, 'v1.0')).toThrow("'v1.0' isn't a version")
  })
})
