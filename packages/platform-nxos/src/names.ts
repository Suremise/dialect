// Interface names as NX-OS writes them (`Ethernet1/1`, `port-channel10`, `loopback0`, `Vlan10`, `mgmt0`). The model
// keys interfaces by name as the source writes it, so names are kept as written, except that a space between type and
// number is closed up (`loopback 0` is `loopback0`, as NX-OS itself shows it). Mapping names between platforms is the
// user's (B9's interface map).
import type { InterfaceType, PortName } from '@dialect/core'

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

/** What an NX-OS interface name says, for another platform's suggested name (the core's PortName): `port-channel10` is aggregate 10. */
export function describeInterface(name: string): PortName | undefined {
  const m = /^po(?:rt-channel)?(\d+)$/i.exec(name)
  return m ? { type: 'aggregate', numbers: [Number(m[1])] } : undefined
}

/**
 * NX-OS's name for a port another platform described, as a suggestion the user confirms: an aggregate is
 * `port-channel` and its number. Every plugin describes an aggregate counted from 1, as Cisco does (Junos's `ae0` is 1),
 * so IOS-XE's `Port-channel5` and IOS-XR's `Bundle-Ether5` are `port-channel5`, and Junos's `ae0` is `port-channel1`.
 * A routed VLAN interface is described by its VLAN's ID (the core does, #80): Junos's `irb.100` is `Vlan100`.
 */
export function nameInterface(port: PortName): string | undefined {
  if (port.numbers.length !== 1) return undefined
  const n = port.numbers[0]
  if (port.type === 'irb-or-svi' || port.type === 'vlan') return Number.isInteger(n) && n >= 1 && n <= 4094 ? `Vlan${n}` : undefined
  if (port.type !== 'aggregate') return undefined
  return Number.isInteger(n) && n >= 1 && n <= 4096 ? `port-channel${n}` : undefined
}
