// Junos interface names (`ge-0/0/0`, `ae1`, `lo0`, `irb`). The model keys interfaces by name as the source writes it;
// mapping names between platforms is the user's (B9's interface map).
import type { InterfaceType, PortName } from '@dialect/core'

/** Words that can follow `interfaces` but aren't an interface. */
export const NOT_INTERFACES = new Set(['interface-range', 'interface-set', 'traceoptions', 'stacked-interface-set', 'apply-groups', 'apply-groups-except'])

const TYPES: Readonly<Record<string, InterfaceType>> = {
  ge: 'ethernet',
  xe: 'ethernet',
  et: 'ethernet',
  fe: 'ethernet',
  mge: 'ethernet',
  xle: 'ethernet',
  fte: 'ethernet',
  ae: 'aggregate',
  reth: 'aggregate',
  lo: 'loopback',
  irb: 'irb-or-svi',
  vlan: 'vlan',
  fxp: 'management',
  em: 'management',
  me: 'management',
  vme: 'management',
  gr: 'tunnel',
  ip: 'tunnel',
  lt: 'tunnel',
  st: 'tunnel',
  vt: 'tunnel',
  fti: 'tunnel'
}

/** The model's type for an interface, from its name; undefined when the name doesn't say. */
export function interfaceType(name: string): InterfaceType | undefined {
  const m = /^([a-z]+)(?:-?\d|$)/.exec(name)
  return m && Object.hasOwn(TYPES, m[1]) ? TYPES[m[1]] : undefined
}

/** Ethernet speeds in Mb/s, by name prefix. `et` is 40G, 100G or 400G by its optics: 100G is a guess, as all of these are. */
const SPEEDS: Readonly<Record<string, number>> = { fe: 100, ge: 1000, xe: 10000, xle: 40000, fte: 40000, et: 100000 }

/**
 * What an interface name says, for another platform's suggested name (the core's PortName): `ge-1/0/3` is 1000 Mb/s
 * Ethernet 1/0/3, `xe-0/0/0:2` a channel of one, `ae1` an aggregate, `lo0` a loopback, `fxp0` the management port.
 * Undefined for names with no number (`irb`, `vlan`) and the rest.
 */
export function describeInterface(name: string): PortName | undefined {
  const port = /^([a-z]+)-(\d+)\/(\d+)\/(\d+)(?::(\d+))?$/.exec(name)
  if (port) {
    const [, kind, ...rest] = port
    if (interfaceType(name) !== 'ethernet') return undefined
    const numbers = rest.filter((n) => n !== undefined).map(Number)
    return { type: 'ethernet', ...(Object.hasOwn(SPEEDS, kind) ? { speed: SPEEDS[kind] } : {}), numbers }
  }
  const single = /^(ae|lo|fxp|em|me)(\d+)$/.exec(name)
  if (!single) return undefined
  const type = interfaceType(name)
  return type ? { type, numbers: [Number(single[2])] } : undefined
}

/**
 * The Junos name for a port another plugin described, as a suggestion (convert never takes it silently). Only
 * aggregates so far, as the user decided: Cisco `Port-channelN`, `port-channelN` and `Bundle-EtherN` start at 1, Junos's
 * `ae` at 0, so N is `ae(N-1)`. Undefined for anything else.
 */
export function nameInterface(port: PortName): string | undefined {
  if (port.type !== 'aggregate' || port.numbers.length !== 1 || !Number.isInteger(port.numbers[0]) || port.numbers[0] < 1) return undefined
  return `ae${port.numbers[0] - 1}`
}
