#!/usr/bin/env node
// Checks fixtures/manifest.json against the files on disk, and prints the coverage table.
//   node fixtures/verify.mjs             check; exits 1 on any problem
//   node fixtures/verify.mjs --coverage  also print the platform x area table (Markdown) used in README.md
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'])
const PLATFORMS = ['junos', 'iosxe', 'nxos', 'iosxr']
// Phase 1 areas must have at least one file per platform; the rest are later phases.
const PHASE1 = ['system', 'interfaces', 'static-routes', 'mgmt', 'vlans', 'ospf', 'bgp', 'policy', 'filters', 'vrfs']
const LATER = ['isis', 'eigrp', 'evpn-vxlan', 'mpls', 'nat', 'security', 'vpn', 'ha', 'qos']
const SPECIAL = ['whole', 'pairs']
const AREAS = new Set([...PHASE1, ...LATER, ...SPECIAL])

const problems = []
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const listed = new Map(manifest.files.map((f) => [f.path, f]))
if (listed.size !== manifest.files.length) problems.push('manifest has duplicate paths')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p).split(sep).join('/')]
  })
}
const onDisk = [...walk(join(root, 'public')), ...(existsSync(join(root, 'originals')) ? walk(join(root, 'originals')) : [])]
for (const p of onDisk) if (!listed.has(p)) problems.push(`not in manifest: ${p}`)

const hashes = new Map()
for (const f of manifest.files) {
  const where = `manifest ${f.path}`
  const abs = join(root, f.path)
  if (!existsSync(abs)) { problems.push(`${where}: file missing`); continue }
  const data = readFileSync(abs)
  const sha = createHash('sha256').update(data).digest('hex')
  if (sha !== f.sha256) problems.push(`${where}: sha256 differs`)
  if (data.length !== f.bytes) problems.push(`${where}: size differs`)
  if (hashes.has(sha)) problems.push(`${where}: same content as ${hashes.get(sha)}`)
  hashes.set(sha, f.path)
  const [top, platform, area] = f.path.split('/')
  if (top === 'public' && data.includes(13)) problems.push(`${where}: CR in a public/ file (convert to LF and keep the original under originals/)`)
  if (top === 'originals' && !f.convertedTo) problems.push(`${where}: originals/ entry without convertedTo`)
  if (top === 'public' && f.original && !listed.has(f.original)) problems.push(`${where}: original ${f.original} not in manifest`)
  if (platform !== f.platform || !PLATFORMS.includes(platform)) problems.push(`${where}: platform ${f.platform} vs path`)
  if (!AREAS.has(area) || f.areas[0] !== area) problems.push(`${where}: area folder ${area} vs areas ${f.areas}`)
  for (const a of f.areas) if (!AREAS.has(a)) problems.push(`${where}: unknown area ${a}`)
  if (!ALLOWED_LICENSES.has(f.license)) problems.push(`${where}: license ${f.license} not allowed`)
  if (!/^[0-9a-f]{40}$/.test(f.commit)) problems.push(`${where}: commit is not a full SHA`)
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(f.source)) problems.push(`${where}: source is not a repo URL`)
  if (!f.sourcePath) problems.push(`${where}: no sourcePath`)
  if ((f.platform === 'junos') !== (f.junosForm != null)) problems.push(`${where}: junosForm must be set for Junos only`)
  if (f.junosForm != null && !['hierarchical', 'set', 'mixed'].includes(f.junosForm)) problems.push(`${where}: junosForm ${f.junosForm}`)
}

// Every source repo needs its license text in LICENSES/.
const licenseFiles = readdirSync(join(root, 'LICENSES'))
for (const repo of new Set(manifest.files.map((f) => f.source))) {
  const name = repo.split('/').pop()
  if (!licenseFiles.some((l) => l.startsWith(name + '.'))) problems.push(`LICENSES/: no license file for ${repo}`)
}

if (process.argv.includes('--coverage')) {
  const pub = manifest.files.filter((f) => f.path.startsWith('public/'))
  const count = (p, a) => pub.filter((f) => f.platform === p && f.areas.includes(a)).length
  const rows = [`| Area | ${PLATFORMS.join(' | ')} |`, `|---|${PLATFORMS.map(() => '---:').join('|')}|`]
  for (const a of [...PHASE1, ...LATER, ...SPECIAL]) {
    const cells = PLATFORMS.map((p) => count(p, a) || (PHASE1.includes(a) ? '**0**' : '–'))
    rows.push(`| ${PHASE1.includes(a) ? a : `${a} \\*`} | ${cells.join(' | ')} |`)
  }
  const total = PLATFORMS.map((p) => pub.filter((f) => f.platform === p).length)
  rows.push(`| **files** | ${total.join(' | ')} |`)
  console.log(rows.join('\n'))
  for (const p of PLATFORMS) for (const a of PHASE1) if (!count(p, a)) problems.push(`coverage: no ${p} file for phase 1 area ${a}`)
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\n${problems.length} problem(s)`)
  process.exit(1)
}
console.error(`ok: ${manifest.files.length} manifest entries, ${onDisk.length} files`)
