// Cleans jcc's display set test pairs (fixtures/public/junos/pairs, MIT) into tests/fixtures/display-set, following the
// repo's rule for configs (docs/SPEC.md §5): public addresses into the documentation ranges, secrets into placeholders,
// real-looking host and site names into neutral ones. Each substitution is context-free and applied the same way to
// both halves of a pair, so the pairs still match. Then config_8, 15 and 16's expected files get Juniper's documented
// `deactivate`/`protect` order. displaySetFixtures.test.ts checks the committed files are what this gives.

/** Host and site names that look real (a data-centre code), and what replaces them. The others are already neutral. */
const NAMES: [RegExp, string][] = [
  [/\bdar01-dal09\b/g, 'edge-1'],
  [/\bDAL09\b/g, 'site-1']
]

/** Junos `$1$`, `$5$`, `$6$` and `$9$` hashes and encrypted keys, up to the closing quote. */
const SECRET = /\$([1569])\$[^"\s;]*/g

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g
const IPV6 = /(?<![\w:])([23][0-9a-fA-F]{3}:[0-9a-fA-F:]*[0-9a-fA-F:])(?![\w:])/g

/** Whether an IPv4 address is globally routable: outside private, shared, loopback, link-local, documentation, benchmarking, multicast and reserved space. */
export function isPublicIPv4(octets: number[]): boolean {
  const [a, b, c] = octets
  if (octets.some((o) => o > 255)) return false
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

/** Whether an IPv6 address (2000::/3, as IPV6 matches) is outside the documentation prefix 2001:db8::/32. */
export function isPublicIPv6(address: string): boolean {
  return address.includes(':') && !/^2001:0?db8(:|$)/i.test(address)
}

const DOC_V4 = ['192.0.2', '198.51.100', '203.0.113']

/** One mapping for every file cleaned with it, so an address means the same device or network everywhere. */
export class Cleaner {
  private readonly v4 = new Map<string, string>()
  private readonly v6 = new Map<string, string>()
  private nextV4 = 0
  private readonly usedV4: Set<string>

  /** `originals`: every file to be cleaned, so new documentation addresses never collide with ones already used. */
  constructor(originals: string[]) {
    this.usedV4 = new Set(originals.flatMap((text) => [...text.matchAll(IPV4)].map((m) => m[0])))
  }

  private documentationV4(original: string): string {
    let mapped = this.v4.get(original)
    while (!mapped) {
      const n = this.nextV4++
      if (n >= DOC_V4.length * 254) throw new Error('more public IPv4 addresses than the documentation ranges hold')
      const candidate = `${DOC_V4[Math.floor(n / 254)]}.${(n % 254) + 1}`
      if (this.usedV4.has(candidate)) continue
      this.v4.set(original, candidate)
      mapped = candidate
    }
    return mapped
  }

  /** 2001:db8:<n>:: for each network part (before `::`, or the first four groups), keeping the host part. */
  private documentationV6(address: string): string {
    const gap = address.indexOf('::')
    const groups = address.split(':')
    const network = gap >= 0 ? address.slice(0, gap) : groups.slice(0, 4).join(':')
    const host = gap >= 0 ? address.slice(gap + 2) : groups.slice(4).join(':')
    let n = this.v6.get(network)
    if (!n) {
      n = (this.v6.size + 1).toString(16)
      this.v6.set(network, n)
    }
    return `2001:db8:${n}::${host}`
  }

  clean(text: string): string {
    let out = text.replace(SECRET, (_m, kind: string) => `$${kind}$PLACEHOLDER`)
    out = out.replace(IPV4, (m, a: string, b: string, c: string, d: string) => (isPublicIPv4([a, b, c, d].map(Number)) ? this.documentationV4(m) : m))
    out = out.replace(IPV6, (m: string) => (isPublicIPv6(m) ? this.documentationV6(m) : m))
    for (const [pattern, replacement] of NAMES) out = out.replace(pattern, replacement)
    return out
  }
}

/**
 * The `deactivate`/`protect` lines jcc's expected files put before their container's subtree. Juniper's documented
 * display set puts each one after the subtree's last `set` line (docs/spike-desktop-app.md, "Ordering of deactivate
 * lines").
 */
export const ORDER_CORRECTIONS: Record<number, string[]> = {
  8: ['deactivate system scripts commit'],
  15: ['protect system services', 'deactivate system syslog'],
  16: ['protect system services']
}

/** Moves each tag line after the last line of its container's subtree, keeping the text's line breaks. */
export function correctTagOrder(text: string, tagLines: string[]): string {
  const ending = text.includes('\r\n') ? '\r\n' : '\n'
  const trailing = text.endsWith(ending)
  const lines = (trailing ? text.slice(0, -ending.length) : text).split(ending)
  for (const tagLine of tagLines) {
    const from = lines.indexOf(tagLine)
    if (from < 0) throw new Error(`no line '${tagLine}' to move`)
    lines.splice(from, 1)
    const path = `set ${tagLine.slice(tagLine.indexOf(' ') + 1)} `
    let last = -1
    lines.forEach((line, i) => {
      if (line.startsWith(path)) last = i
    })
    if (last < 0) throw new Error(`no subtree under '${tagLine}'`)
    lines.splice(last + 1, 0, tagLine)
  }
  return lines.join(ending) + (trailing ? ending : '')
}

export interface Pair {
  n: number
  conf: string
  set: string
}

/** Cleans every pair with one mapping, then (unless `correctOrder` is false) corrects the order of 8, 15 and 16. */
export function cleanPairs(originals: Pair[], { correctOrder = true } = {}): Pair[] {
  const cleaner = new Cleaner(originals.flatMap((p) => [p.conf, p.set]))
  return originals.map(({ n, conf, set }) => {
    const cleanSet = cleaner.clean(set)
    const corrections = correctOrder ? ORDER_CORRECTIONS[n] : undefined
    return { n, conf: cleaner.clean(conf), set: corrections ? correctTagOrder(cleanSet, corrections) : cleanSet }
  })
}

/** What a scan of cleaned text still finds: public addresses, secrets that aren't placeholders, the replaced names. */
export function leftovers(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(IPV4)) if (isPublicIPv4(m.slice(1, 5).map(Number))) found.push(m[0])
  for (const m of text.matchAll(IPV6)) if (isPublicIPv6(m[0])) found.push(m[0])
  for (const m of text.matchAll(SECRET)) if (!m[0].endsWith('$PLACEHOLDER')) found.push(m[0])
  for (const [pattern] of NAMES) for (const m of text.matchAll(new RegExp(pattern.source, 'gi'))) found.push(m[0])
  return found
}
