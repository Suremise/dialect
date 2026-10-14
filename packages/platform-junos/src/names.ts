// Junos interface names (`ge-0/0/0`, `ae1`, `lo0`, `irb`). The model keys interfaces by name as the source writes it;
// mapping names between platforms is the user's (B9's interface map).
import type { InterfaceType } from '@dialect/core'

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
  irb: 'vlan',
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
