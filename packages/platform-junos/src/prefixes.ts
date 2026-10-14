// Prefix matches as Junos reads them. A term's route filters (and the prefixes of the lists `prefix-list-filter` names)
// are one list that Junos searches by longest match: a route is held against the most specific of their prefixes that
// contains it, and only that one's match type decides (Juniper, "How Route Filters Are Evaluated"). The model reads
// them as any-match: a route matches when any of them does. Both readings agree unless a more specific prefix inside a
// less specific one leaves out lengths the less specific one takes, so that is what's checked, both ways.
import { parsePrefix as modelPrefix, type PrefixMatch } from '@dialect/core'
import { isIpv4, isIpv6 } from './addresses'

/** An address as a number, with its family's width; null when it isn't an address. */
export function addressValue(address: string): { readonly value: bigint; readonly bits: 32 | 128 } | null {
  if (isIpv4(address)) return { value: address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n), bits: 32 }
  if (!isIpv6(address)) return null
  let text = address
  // A dotted IPv4 tail is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const v4 = addressValue(dotted[1])!.value
    text = `${text.slice(0, -dotted[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const groups = (s: string | undefined) => (s ? s.split(':') : [])
  const left = groups(head)
  const right = groups(tail)
  const all = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return { value: all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n), bits: 128 }
}

/** Whether `prefix` (`10.0.0.0/8`) is in the model's form: CIDR, with no host bits set. */
export const isModelPrefix = (prefix: string): boolean => modelPrefix(prefix) !== null

interface Range {
  readonly value: bigint
  readonly bits: 32 | 128
  readonly length: number
  readonly min: number
  readonly max: number
}

function range(match: PrefixMatch): Range | null {
  const slash = match.prefix.lastIndexOf('/')
  const address = addressValue(match.prefix.slice(0, slash))
  const length = Number(match.prefix.slice(slash + 1))
  return address ? { ...address, length, min: match.minLength, max: match.maxLength } : null
}

/** Whether prefix `inner` lies inside `outer`, strictly more specific. */
function inside(inner: Range, outer: Range): boolean {
  if (inner.bits !== outer.bits || inner.length <= outer.length) return false
  const shift = BigInt(outer.bits - outer.length)
  return inner.value >> shift === outer.value >> shift
}

/**
 * Whether Junos's longest-match reading of `matches` (one term's route filters, or the entries of its lists) gives every
 * route the same answer as the model's any-match. They differ when a prefix B inside a less specific A doesn't take
 * every length from B's own up that A takes: a route inside B of such a length matches A, but Junos holds it against B.
 * Matches with the same prefix are taken together, as Junos takes them.
 */
export function longestMatchAgrees(matches: readonly PrefixMatch[]): boolean {
  const ranges = matches.map(range)
  if (ranges.some((r) => r === null)) return false
  const all = ranges as Range[]
  for (const a of all) {
    for (const b of all) {
      if (!inside(b, a)) continue
      // The lengths a route inside B can have that A takes: each must be one some match on B's prefix takes too.
      const same = all.filter((c) => c.bits === b.bits && c.length === b.length && c.value === b.value)
      for (let length = Math.max(b.length, a.min); length <= a.max; length++) if (!same.some((c) => c.min <= length && length <= c.max)) return false
    }
  }
  return true
}
