// Addresses and prefixes as Junos writes them: always with a prefix length (`192.0.2.1/24`, `2001:db8::1/64`). The
// model keeps an IPv4 prefix as written and an IPv6 one lowercased, as the IOS / IOS-XE plugin does, so the same
// address is the same key whichever platform it came from.

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const isIpv4 = (s: string): boolean => IPV4.test(s)

/**
 * An IPv6 address (RFC 4291 text forms): eight groups of 1–4 hex digits, or fewer with one `::` standing for at least
 * one zero group, the last two groups optionally a dotted IPv4 address.
 */
export function isIpv6(s: string): boolean {
  if (!/^[\da-f:.]+$/i.test(s)) return false
  const halves = s.split('::')
  if (halves.length > 2) return false
  const all = halves.flatMap((h) => (h === '' ? [] : h.split(':')))
  const last = all[all.length - 1]
  let count = all.length
  if (last !== undefined && last.includes('.')) {
    if (!isIpv4(last) || !s.endsWith(last)) return false
    all.pop()
    count++
  }
  if (!all.every((g) => /^[\da-f]{1,4}$/i.test(g))) return false
  return halves.length === 2 ? count < 8 : count === 8
}

/** An address as the model keys it: IPv6 lowercased, IPv4 as written. */
export const addressKey = (s: string): string => (isIpv6(s) ? s.toLowerCase() : s)

export interface Prefix {
  readonly address: string
  readonly length: number
  readonly v6: boolean
}

/** `192.0.2.1/24` or `2001:DB8::/32` → its address (IPv6 lowercased), length and family; null when it isn't one. */
export function parsePrefix(text: string): Prefix | null {
  const m = /^([\da-fA-F:.]+)\/(\d{1,3})$/.exec(text)
  if (!m) return null
  const length = Number(m[2])
  if (isIpv4(m[1])) return length <= 32 ? { address: m[1], length, v6: false } : null
  if (isIpv6(m[1])) return length <= 128 ? { address: m[1].toLowerCase(), length, v6: true } : null
  return null
}

/** A prefix in the model's form, `address/length`. */
export const prefixKey = (p: Prefix): string => `${p.address}/${p.length}`
