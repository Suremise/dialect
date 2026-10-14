// Interface names as IOS writes them. The model keys interfaces by name as the source writes it, so names are kept as
// written (`Gi0/1` stays `Gi0/1`), except that a space between type and number is closed up (`loopback 1` is
// `loopback1`), as IOS itself shows it. Mapping names between platforms is the user's (B9's interface map).
import type { InterfaceType, PortName } from '@dialect/core'

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

/**
 * Whether `name` is an interface name as IOS writes one: a type in letters (and `-`), then numbers separated by `/` or
 * `:`, and optionally `.<subinterface>` (`GigabitEthernet0/0/1`, `Gi0/1.10`, `Serial0/0/0:0`, `Null0`). A malformed
 * address (`dead::beef::bad`) or a stray word isn't one.
 */
export function isInterfaceName(name: string): boolean {
  return /^[A-Za-z][A-Za-z-]*\d+(?:[/:]\d+)*(?:\.\d+)?$/.test(name)
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
  // A VLAN interface routes for the VLAN of its number (model 0.4.0).
  if (/^vl(?:an)?$/.test(kind)) return 'irb-or-svi'
  if (/^tu(?:nnel)?$/.test(kind)) return 'tunnel'
  if (ETHERNET.test(kind)) return 'ethernet'
  return undefined
}

/** What an IOS interface name says, for another platform's suggested name (the core's PortName): `Port-channel10` is aggregate 10. */
export function describeInterface(name: string): PortName | undefined {
  const m = /^po(?:rt-channel)?(\d+)$/i.exec(name)
  return m ? { type: 'aggregate', numbers: [Number(m[1])] } : undefined
}

/** IOS's Ethernet names by speed in Mb/s. */
const ETHERNET_NAMES: Readonly<Record<number, string>> = {
  10: 'Ethernet',
  100: 'FastEthernet',
  1000: 'GigabitEthernet',
  2500: 'TwoGigabitEthernet',
  5000: 'FiveGigabitEthernet',
  10000: 'TenGigabitEthernet',
  25000: 'TwentyFiveGigE',
  40000: 'FortyGigabitEthernet',
  100000: 'HundredGigE'
}

/**
 * IOS's name for a port another platform described, as a suggestion: Ethernet by its speed and numbers
 * (`GigabitEthernet0/0/0`, a channel as `:n`), `Port-channel`, `Loopback` and `Tunnel` by their number, `Vlan` by its
 * VLAN's ID (a `vlan` or `irb-or-svi` port), and
 * `GigabitEthernet0` for management port 0. Undefined when IOS has no likely name (an Ethernet port of unknown speed,
 * Port-channel 0, which IOS doesn't have).
 */
export function nameInterface(port: PortName): string | undefined {
  const n = port.numbers
  if (port.type === 'ethernet') {
    const base = port.speed !== undefined && Object.hasOwn(ETHERNET_NAMES, port.speed) ? ETHERNET_NAMES[port.speed] : undefined
    if (!base || n.length < 1) return undefined
    return n.length === 4 ? `${base}${n.slice(0, 3).join('/')}:${n[3]}` : `${base}${n.join('/')}`
  }
  if (n.length !== 1) return undefined
  // Every plugin describes an aggregate counted from 1, as Cisco does: Junos's `ae0` is aggregate 1, `Port-channel1`.
  if (port.type === 'aggregate') return Number.isInteger(n[0]) && n[0] >= 1 ? `Port-channel${n[0]}` : undefined
  if (port.type === 'loopback') return `Loopback${n[0]}`
  if (port.type === 'tunnel') return `Tunnel${n[0]}`
  // A routed VLAN interface is described by its VLAN's ID: Junos `irb.100` for VLAN 100 is `Vlan100`.
  if (port.type === 'vlan' || port.type === 'irb-or-svi') return n[0] >= 1 && n[0] <= 4094 ? `Vlan${n[0]}` : undefined
  if (port.type === 'management') return n[0] === 0 ? 'GigabitEthernet0' : undefined
  return undefined
}
