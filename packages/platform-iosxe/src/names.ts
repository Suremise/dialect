// Interface names as IOS writes them. The model keys interfaces by name as the source writes it, so names are kept as
// written (`Gi0/1` stays `Gi0/1`), except that a space between type and number is closed up (`loopback 1` is
// `loopback1`), as IOS itself shows it. Mapping names between platforms is the user's (B9's interface map).
import type { InterfaceType } from '@dialect/core'

/**
 * The interface name starting at `words[i]`, and how many words it took: `Loopback0` (one), or `loopback 66` (two, a
 * type with no number followed by a number).
 */
export function interfaceName(words: readonly string[], i: number): { name: string; used: number } | null {
  const w = words[i]
  if (w === undefined || !/^[A-Za-z]/.test(w)) return null
  const next = words[i + 1]
  if (/^[A-Za-z-]+$/.test(w) && next !== undefined && /^\d[\d/:.]*$/.test(next)) return { name: w + next, used: 2 }
  return { name: w, used: 1 }
}

/** A subinterface's parent and index: `Gi0/1.10` → `Gi0/1`, `10`. Null for a main interface. */
export function splitSubinterface(name: string): { parent: string; index: string } | null {
  const m = /^(.+\d)\.(\d+)$/.exec(name)
  return m ? { parent: m[1], index: String(Number(m[2])) } : null
}

const ETHERNET = /^(?:\w*gig\w*|\w*ethernet|fastethernet|e|gi|te|fa|fo|hu|tw|et|eth|fi)$/

/** The model's type for an interface, from its name; undefined when the name doesn't say. */
export function interfaceType(name: string): InterfaceType | undefined {
  const m = /^([A-Za-z-]+)\d/.exec(name)
  if (!m) return undefined
  const kind = m[1].toLowerCase()
  if (/^lo(?:opback)?$/.test(kind)) return 'loopback'
  if (/^po(?:rt-channel)?$/.test(kind)) return 'aggregate'
  if (/^vl(?:an)?$/.test(kind)) return 'vlan'
  if (/^tu(?:nnel)?$/.test(kind)) return 'tunnel'
  if (ETHERNET.test(kind)) return 'ethernet'
  return undefined
}
