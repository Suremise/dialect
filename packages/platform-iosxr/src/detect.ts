// How likely a text is an IOS-XR configuration, from 0 to 1, for auto-detect. IOS-XR, IOS and NX-OS share most of
// their look (indented blocks, `!` separators, `interface`, `hostname`), so this counts what is IOS-XR's own (`ipv4
// address`, four-part interface names, `Bundle-Ether`, `MgmtEth`, `router static`, RPL's `route-policy`/`end-policy`
// and `end-set`, `!! IOS XR Configuration`, RANCID's `cisco-xr`) and discounts what belongs to the others (IOS's `ip
// address` and `ip route`, NX-OS's `feature` and `vrf context`) and to Junos.

const SIGNS: readonly (readonly [RegExp, number])[] = [
  // RANCID's header names the platform it fetched the configuration from; IOS-XR's own header names itself.
  [/^!RANCID-CONTENT-TYPE: cisco-xr\s*$/m, 0.7],
  [/^!! IOS XR Configuration/m, 0.7],
  [/^\s+ipv4 address /m, 0.4],
  [/^interface \S+\d+\/\d+\/\d+\/\d+/m, 0.4],
  [/^interface (?:Bundle-Ether\d|MgmtEth\d|(?:TenGigE|TwentyFiveGigE|FortyGigE|HundredGigE)\d+\/)/m, 0.3],
  [/^router static\s*$/m, 0.3],
  [/^end-policy\s*$/m, 0.4],
  [/^end-set\s*$/m, 0.4],
  [/^domain (?:name|name-server|list|lookup|vrf) /m, 0.2],
  [/^logging \S+ vrf \S+/m, 0.2],
  [/^\s+(?:import|export) route-target\b/m, 0.3],
  [/^ipv[46] access-list \S+\s*$/m, 0.2],
  [/^\s+\d+ (?:permit|deny) ipv[46] /m, 0.3],
  [/^hostname \S+\s*$/m, 0.1]
]

const OTHERS: readonly (readonly [RegExp, number])[] = [
  // Junos: braces or set lines.
  [/^\s*[\w-]+(?: [\w./:-]+)* \{\s*$/m, 0.1],
  [/^set (?:system|interfaces|protocols|routing-options) /m, 0.1],
  // IOS / IOS-XE.
  [/^!RANCID-CONTENT-TYPE: cisco\s*$/m, 0.3],
  // IOS-XR says `ipv4 address`, `ipv4 access-list` and `router static`: never IOS's forms.
  [/^\s+ip address /m, 0.3],
  [/^ip access-list /m, 0.3],
  [/^ip route /m, 0.4],
  [/^(?:ip vrf|vrf definition) /m, 0.3],
  // NX-OS.
  [/^!RANCID-CONTENT-TYPE: cisco-nx\s*$/m, 0.3],
  [/^feature \S+/m, 0.3],
  [/^vrf context /m, 0.3]
]

export function detect(text: string): number {
  let score = 0
  for (const [re, weight] of SIGNS) if (re.test(text)) score += weight
  for (const [re, factor] of OTHERS) if (re.test(text)) score *= factor
  return Math.round(Math.min(1, score) * 100) / 100
}
