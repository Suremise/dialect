// How likely a text is a Junos configuration, from 0 to 1, for auto-detect: hierarchical (`system {`, `unit 0 {`,
// `version …;`) or set form (`set system host-name r1`). What looks like IOS and its relatives (`interface
// GigabitEthernet0/1`, `hostname`, `!` separators) counts against it.

const SIGNS: readonly (readonly [RegExp, number])[] = [
  // Hierarchical.
  [/^(?:system|interfaces|routing-options|routing-instances|protocols|policy-options|firewall|snmp|chassis|security|vlans|groups)\s*\{\s*$/m, 0.5],
  [/^\s+unit \d+ \{\s*$/m, 0.2],
  [/^\s+family (?:inet6?|ethernet-switching)\b/m, 0.2],
  [/^\s+host-name \S+;\s*$/m, 0.2],
  [/^version \S+;\s*$/m, 0.2],
  [/^## Last commit: /m, 0.3],
  // Set form.
  [/^set (?:system|interfaces|routing-options|routing-instances|protocols|policy-options|firewall|snmp|chassis|security|vlans|groups|version|apply-groups) /m, 0.6],
  [/^set interfaces \S+ unit \d+ /m, 0.2],
  [/^set system host-name \S+/m, 0.2]
]

const OTHERS: readonly (readonly [RegExp, number])[] = [
  [/^interface (?:GigabitEthernet|TenGigabitEthernet|FastEthernet|Ethernet|Loopback|Vlan|Port-channel|mgmt)\d/im, 0.2],
  [/^hostname \S+\s*$/m, 0.3],
  [/^!\s*$/m, 0.3],
  [/^\s+ip address \d/m, 0.3]
]

export function detect(text: string): number {
  let score = 0
  for (const [re, weight] of SIGNS) if (re.test(text)) score += weight
  for (const [re, factor] of OTHERS) if (re.test(text)) score *= factor
  return Math.round(Math.min(1, score) * 100) / 100
}
