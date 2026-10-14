// Interface names as IOS-XR writes them: `GigabitEthernet0/0/0/0`, `TenGigE0/1/0/3`, `Bundle-Ether1`, `Loopback0`,
// `MgmtEth0/RP0/CPU0/0`, `tunnel-te1`, and subinterfaces `GigabitEthernet0/0/0/0.100`. The model keys interfaces by name
// as the source writes it; mapping names between platforms is the user's (B9's interface map).
import type { InterfaceType } from '@dialect/core'

/** One interface, as `interface` takes it: a type, then numbers separated by `/` (a slot may be `RP0` or `CPU0`). */
export const isInterfaceName = (name: string): boolean => /^[A-Za-z][A-Za-z-]*\d+(?:\/(?:[A-Za-z]+)?\d+)*(?:\.\d+)?$/.test(name)

/** A subinterface's parent and index: `Bundle-Ether1.10` → `Bundle-Ether1`, `10`. Null for a main interface. */
export function splitSubinterface(name: string): { parent: string; index: string } | null {
  const m = /^(.+\d)\.(\d+)$/.exec(name)
  return m ? { parent: m[1], index: String(Number(m[2])) } : null
}

/** The model's type for an interface, from its name; undefined when the name doesn't say. */
export function interfaceType(name: string): InterfaceType | undefined {
  const m = /^([A-Za-z-]+)\d/.exec(name)
  if (!m) return undefined
  const kind = m[1].toLowerCase()
  if (/^(?:gigabitethernet|(?:ten|twentyfive|forty|fifty|hundred|twohundred|fourhundred)gige|fastethernet|gi|te|hu)$/.test(kind)) return 'ethernet'
  if (kind === 'bundle-ether') return 'aggregate'
  if (kind === 'loopback') return 'loopback'
  if (kind === 'mgmteth') return 'management'
  if (/^tunnel-(?:ip|te)$/.test(kind)) return 'tunnel'
  return undefined
}
