// How likely a text is an IOS / IOS-XE configuration, from 0 to 1, for auto-detect. IOS, NX-OS and IOS-XR share most of
// their look (indented blocks, `!` separators, `interface`, `hostname`), so this counts what is IOS's own (a dotted
// mask on `ip address`, `ip route`, `service timestamps`, a `^C` banner) and discounts what belongs to the others
// (NX-OS `feature`, IOS-XR `ipv4 address` and four-part interface names) and to Junos (braces, `set` lines).

const SIGNS: readonly (readonly [RegExp, number])[] = [
  [/^\s+ip address \d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+/m, 0.4],
  [/^ip route (?:vrf \S+ )?\d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+/m, 0.3],
  [/^service timestamps /m, 0.3],
  [/^banner \w+ \^C/m, 0.3],
  // Access lists: IOS names a list's kind (NX-OS and IOS-XR don't), and its entries' addresses take wildcards.
  [/^ip access-list (?:standard|extended) \S+\s*$/m, 0.3],
  [/^access-list \d+ (?:permit|deny|remark) /m, 0.3],
  [/^\s+(?:\d+ )?(?:permit|deny) (?!ipv4 )\S+ (?:any|host \S+|\d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+) .*\d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+/m, 0.2],
  [/^version 1\d\.\d+\s*$/m, 0.2],
  [/^interface [A-Za-z-]+\d/m, 0.2],
  [/^hostname \S+\s*$/m, 0.1],
  [/^!\s*$/m, 0.1],
  [/^end\s*$/m, 0.1]
]

const OTHERS: readonly (readonly [RegExp, number])[] = [
  // Junos: braces or set lines.
  [/^\s*[\w-]+(?: [\w./:-]+)* \{\s*$/m, 0.1],
  [/^set (?:system|interfaces|protocols|routing-options) /m, 0.1],
  // NX-OS.
  [/^feature \S+/m, 0.3],
  [/^vrf context /m, 0.3],
  // IOS-XR.
  [/^\s+ipv4 address /m, 0.3],
  [/^interface \S+\d+\/\d+\/\d+\/\d+/m, 0.3],
  [/^ipv4 access-list /m, 0.3],
  [/^!!/m, 0.5]
]

export function detect(text: string): number {
  let score = 0
  for (const [re, weight] of SIGNS) if (re.test(text)) score += weight
  for (const [re, factor] of OTHERS) if (re.test(text)) score *= factor
  return Math.round(Math.min(1, score) * 100) / 100
}
