// How likely a text is an NX-OS configuration, from 0 to 1, for auto-detect. NX-OS, IOS and IOS-XR share most of their
// look (indented blocks, `!` separators, `interface`, `hostname`), so this counts what is NX-OS's own (`feature`,
// `vrf context`, `vrf member`, `use-vrf`, addresses in prefix notation, `Ethernet1/1` and `mgmt0`, a `version 9.3(3)`
// line, `show running-config`'s `!Command:` header, RANCID's `cisco-nx`) and discounts what belongs to the others (IOS dotted masks,
// `service timestamps`, `vrf definition`; IOS-XR `ipv4 address` and four-part interface names) and to Junos.

const SIGNS: readonly (readonly [RegExp, number])[] = [
  // RANCID's header names the platform it fetched the configuration from.
  [/^!RANCID-CONTENT-TYPE: cisco-nx\s*$/m, 0.6],
  [/^feature \S+/m, 0.5],
  [/^vrf context \S+/m, 0.3],
  [/^\s+vrf member \S+/m, 0.3],
  [/ use-vrf \S+/m, 0.25],
  [/^switchname \S+/m, 0.4],
  [/^!Command: show running-config/m, 0.3],
  [/^version \d+\.\d+\(\d+\)/m, 0.3],
  [/^\s+ip address \d+\.\d+\.\d+\.\d+\/\d+/m, 0.25],
  [/^ip route \d+\.\d+\.\d+\.\d+\/\d+ /m, 0.2],
  [/^interface (?:Ethernet|mgmt)\d+(?:\/\d+)?\s*$/m, 0.2],
  [/^interface (?:port-channel|loopback|Vlan)\d+\s*$/m, 0.1],
  [/^hostname \S+\s*$/m, 0.1],
]

const OTHERS: readonly (readonly [RegExp, number])[] = [
  // Junos: braces or set lines.
  [/^\s*[\w-]+(?: [\w./:-]+)* \{\s*$/m, 0.1],
  [/^set (?:system|interfaces|protocols|routing-options) /m, 0.1],
  // IOS / IOS-XE.
  [/^!RANCID-CONTENT-TYPE: cisco\s*$/m, 0.3],
  [/^\s+ip address \d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+\s*$/m, 0.5],
  [/^service timestamps /m, 0.3],
  [/^(?:ip vrf|vrf definition) /m, 0.3],
  [/^end\s*$/m, 0.6],
  // IOS-XR.
  [/^!RANCID-CONTENT-TYPE: cisco-xr\s*$/m, 0.3],
  [/^\s+ipv4 address /m, 0.3],
  [/^interface \S+\d+\/\d+\/\d+\/\d+/m, 0.3]
]

export function detect(text: string): number {
  let score = 0
  for (const [re, weight] of SIGNS) if (re.test(text)) score += weight
  for (const [re, factor] of OTHERS) if (re.test(text)) score *= factor
  return Math.round(Math.min(1, score) * 100) / 100
}
