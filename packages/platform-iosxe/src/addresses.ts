// Addresses as IOS writes them: IPv4 with a dotted mask (`10.0.0.1 255.255.255.0`), the model with a prefix length.

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const isIpv4 = (s: string): boolean => IPV4.test(s)

/** An IPv6 address, loosely: hex groups and colons, at most one `::`, optionally ending in a dotted IPv4. */
export function isIpv6(s: string): boolean {
  if (!/^[\da-f:.]+$/i.test(s) || !s.includes(':') || s.split('::').length > 2) return false
  const groups = s.split(':').filter(Boolean)
  const v4 = groups.length && groups[groups.length - 1].includes('.') ? groups.pop() : undefined
  if (v4 !== undefined && !isIpv4(v4)) return false
  const max = v4 === undefined ? 8 : 6
  return groups.length <= max && groups.every((g) => /^[\da-f]{1,4}$/i.test(g)) && (s.includes('::') ? groups.length < max : groups.length === max)
}

const toNumber = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)

/** A dotted mask's prefix length, or null when it isn't a contiguous mask (`255.0.255.0`, a wildcard). */
export function maskLength(mask: string): number | null {
  if (!isIpv4(mask)) return null
  const n = toNumber(mask)
  for (let len = 0; len <= 32; len++) if (n === lengthNumber(len)) return len
  return null
}

const lengthNumber = (len: number) => (len === 0 ? 0 : (0xffffffff - (2 ** (32 - len) - 1)) >>> 0)

/** The dotted mask for a prefix length from 0 to 32. */
export function lengthMask(len: number): string {
  const n = lengthNumber(len)
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.')
}

/** An IPv4 prefix in the model's form (`10.0.0.0/24`) from IOS's `10.0.0.0 255.255.255.0` or `10.0.0.0/24`. */
export function ipv4Prefix(address: string, mask?: string): string | null {
  if (mask === undefined) {
    const m = /^([\d.]+)\/(\d{1,2})$/.exec(address)
    return m && isIpv4(m[1]) && Number(m[2]) <= 32 ? `${m[1]}/${Number(m[2])}` : null
  }
  const len = maskLength(mask)
  return isIpv4(address) && len !== null ? `${address}/${len}` : null
}

/** An IPv6 prefix or address with its length (`2001:DB8::/32`), lowercased as the model keeps it, or null. */
export function ipv6Prefix(text: string): { address: string; length: number } | null {
  const m = /^([\da-f:.]+)\/(\d{1,3})$/i.exec(text)
  if (!m || !isIpv6(m[1]) || Number(m[2]) > 128) return null
  return { address: m[1].toLowerCase(), length: Number(m[2]) }
}
