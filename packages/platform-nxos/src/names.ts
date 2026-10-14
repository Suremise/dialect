// Interface names as NX-OS writes them (`Ethernet1/1`, `port-channel10`, `loopback0`, `Vlan10`, `mgmt0`). The model
// keys interfaces by name as the source writes it, so names are kept as written, except that a space between type and
// number is closed up (`loopback 0` is `loopback0`, as NX-OS itself shows it). Mapping names between platforms is the
// user's (B9's interface map).
import type { InterfaceType } from '@dialect/core'

/**
 * The interface name starting at `words[i]`, and how many words it took: `Ethernet1/1` (one), or `loopback 0` (two, a
 * type with no number followed by a number).
 */
export function interfaceName(words: readonly string[], i: number): { name: string; used: number } | null {
  const w = words[i]
  if (w === undefined || !/^[A-Za-z]/.test(w)) return null
  const next = words[i + 1]
  if (/^[A-Za-z-]+$/.test(w) && next !== undefined && /^\d[\d/.]*$/.test(next)) return { name: w + next, used: 2 }
  return { name: w, used: 1 }
}

/** One interface, as `interface` takes it: not a range (`Ethernet1/1-4`) or a list. */
export const isInterfaceName = (name: string): boolean => /^[A-Za-z][A-Za-z-]*\d+(?:\/\d+)*(?:\.\d+)?$/.test(name)

/** A subinterface's parent and index: `Ethernet1/1.10` → `Ethernet1/1`, `10`. Null for a main interface. */
export function splitSubinterface(name: string): { parent: string; index: string } | null {
  const m = /^(.+\d)\.(\d+)$/.exec(name)
  return m ? { parent: m[1], index: String(Number(m[2])) } : null
}

/** The model's type for an interface, from its name; undefined when the name doesn't say. */
export function interfaceType(name: string): InterfaceType | undefined {
  const m = /^([A-Za-z-]+)\d/.exec(name)
  if (!m) return undefined
  const kind = m[1].toLowerCase()
  if (/^e(?:th(?:ernet)?)?$/.test(kind)) return 'ethernet'
  if (/^lo(?:opback)?$/.test(kind)) return 'loopback'
  if (/^po(?:rt-channel)?$/.test(kind)) return 'aggregate'
  if (/^vlan$/.test(kind)) return 'vlan'
  if (/^mgmt$/.test(kind)) return 'management'
  if (/^tunnel$/.test(kind)) return 'tunnel'
  return undefined
}

/** Whether NX-OS lets the interface be a switch port, so the render says `switchport` or `no switchport` on it. */
export const isSwitchable = (name: string): boolean => {
  const type = interfaceType(name)
  return type === 'ethernet' || type === 'aggregate'
}
