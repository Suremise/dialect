// Why a statement isn't converted, when the mapper found nothing more particular to say: every `unsupported` statement
// has a reason (#109), so the ledger never shows a bare "not converted". The reason comes from the statement's keywords
// alone, read at the places Junos puts a keyword, and is one of the fixed texts below: never a word of the statement,
// as a value can be a secret. Nor one a secret of the configuration is (#114): see unconvertedReason().

/** What the areas this mapper doesn't convert are, by their top-level keyword. */
const AREAS: Readonly<Record<string, string>> = {
  'logical-systems': 'logical systems come later: this converter reads the main configuration',
  security: 'SRX security (zones, policies, NAT) comes later',
  applications: 'SRX applications come later, with security policies',
  'class-of-service': 'class of service comes later',
  chassis: 'chassis settings (hardware, clustering, redundancy) belong to the device: the model has no place for them',
  'virtual-chassis': 'virtual chassis settings belong to the device: the model has no place for them',
  'multi-chassis': 'multichassis link aggregation (MC-LAG) comes later',
  'switch-options': 'switching options (EVPN-VXLAN, VTEP) come later',
  'bridge-domains': 'bridge domains come later: the model has VLANs',
  'forwarding-options': 'forwarding options (sampling, DHCP relay, storm control, hashing) come later',
  'event-options': 'event policies and scripts come later',
  access: 'access (address pools, profiles, RADIUS) comes later',
  services: 'services (flow monitoring, RPM, NAT) come later',
  poe: 'Power over Ethernet settings belong to the device: the model has no place for them',
  'ethernet-switching-options': 'non-ELS switching options come later: this converter reads ELS switching',
  'routing-instances': 'a routing instance setting this converter doesn\'t read yet',
  'policy-options': 'a routing policy statement this converter doesn\'t read yet',
  firewall: 'a firewall statement this converter doesn\'t read yet',
  vlans: 'a VLAN setting the model has no place for',
  version: 'not a software version this converter reads'
}

/** `system` settings, by the keyword after `system`. */
const SYSTEM: Readonly<Record<string, string>> = {
  login: 'users, login classes and the login message come later',
  'root-authentication': "the root password isn't converted: the model keeps no passwords",
  services: 'management services (SSH, NETCONF, the web interface) come later',
  syslog: 'syslog to files, users and the console comes later: the model has remote syslog hosts',
  ntp: 'an NTP setting this converter doesn\'t read yet (boot server, keys, source address)',
  'tacplus-server': 'AAA (TACACS+ and RADIUS servers) comes later',
  'radius-server': 'AAA (TACACS+ and RADIUS servers) comes later',
  'authentication-order': 'AAA (TACACS+ and RADIUS servers) comes later',
  accounting: 'AAA (TACACS+ and RADIUS servers) comes later',
  'name-server': 'a name server setting this converter doesn\'t read yet'
}

/** `snmp` settings, by the keyword after `snmp`. */
const SNMP: Readonly<Record<string, string>> = {
  v3: 'SNMPv3 comes later: the model has SNMP communities',
  'trap-group': 'SNMP traps come later',
  'trap-options': 'SNMP traps come later',
  view: 'SNMP views come later',
  'client-list': 'SNMP client lists by name come later: the model has a community\'s clients'
}

/** `routing-options` settings, by the keyword after `routing-options`. */
const ROUTING_OPTIONS: Readonly<Record<string, string>> = {
  static: 'a static route setting this converter doesn\'t read yet',
  aggregate: 'aggregate and generated routes come later',
  generate: 'aggregate and generated routes come later',
  'rib-groups': 'RIB groups (route leaking between tables) come later',
  'forwarding-table': 'forwarding table settings (load balancing export policies) come later',
  confederation: 'BGP confederations come later',
  'instance-import': 'routes imported between instances come later'
}

/** Routing protocols, by their keyword under `protocols`. */
const PROTOCOLS: Readonly<Record<string, string>> = {
  bgp: 'a BGP setting this converter doesn\'t read yet',
  ospf: 'an OSPF setting this converter doesn\'t read yet',
  ospf3: 'OSPFv3 comes later: the model has OSPFv2'
}

/** Layer 2 inside a routing instance (a mac-vrf or virtual switch). */
const INSTANCE_LAYER2 = new Set(['vlans', 'bridge-domains', 'switch-options', 'protocols-l2', 'vtep-source-interface', 'service-type'])

const GENERIC = "a statement this converter doesn't read"
/**
 * The reason of last resort, when a secret of the configuration is a word of every other (an SNMP community named
 * `comes`, say): a value one character long, which no secret of the conformance kit's (four characters or more) is.
 */
const LAST_RESORT = '—'

/**
 * Why `words` (a statement's full path, as `set` says it) isn't converted, in words of this file's alone, and never
 * containing one of `secrets` (secretValues()): a fixed text is a value of the config too when a secret is one of its
 * words.
 */
export function unconvertedReason(words: readonly string[], secrets: readonly string[] = []): string {
  const safe = (reason: string) => !secrets.some((s) => reason.includes(s))
  return [tableReason(words), GENERIC].find(safe) ?? LAST_RESORT
}

/** The keyword tables' reason for `words`. */
function tableReason(words: readonly string[]): string {
  const [top, next] = words
  if (top === 'system') return (next !== undefined && Object.hasOwn(SYSTEM, next) ? SYSTEM[next] : undefined) ?? 'a system setting the model has no place for'
  if (top === 'snmp') return (next !== undefined && Object.hasOwn(SNMP, next) ? SNMP[next] : undefined) ?? 'an SNMP setting the model has no place for'
  if (top === 'routing-options') return routingOptions(words.slice(1))
  if (top === 'protocols') return protocols(words.slice(1))
  if (top === 'interfaces') return interfaces(words.slice(2))
  if (top === 'routing-instances') {
    // routing-instances NAME …: the name is a value, then the instance's own keywords.
    const own = words.slice(2)
    if (own[0] === 'protocols') return protocols(own.slice(1))
    if (own[0] === 'routing-options') return routingOptions(own.slice(1))
    if (own[0] !== undefined && INSTANCE_LAYER2.has(own[0])) return 'Layer 2 in a routing instance (mac-vrf, virtual switch) comes later'
  }
  if (top !== undefined && Object.hasOwn(AREAS, top)) return AREAS[top]
  return GENERIC
}

const routingOptions = (r: readonly string[]): string => (r[0] !== undefined && Object.hasOwn(ROUTING_OPTIONS, r[0]) ? ROUTING_OPTIONS[r[0]] : 'a routing option the model has no place for')

const protocols = (r: readonly string[]): string => (r[0] !== undefined && Object.hasOwn(PROTOCOLS, r[0]) ? PROTOCOLS[r[0]] : 'routing protocols other than OSPF and BGP come later')

/** An interface's statement after its name. */
function interfaces(r: readonly string[]): string {
  if (r[0] === 'unit') {
    const u = r.slice(2)
    if (u[0] === 'family') return u[1] === 'inet' || u[1] === 'inet6' ? 'an address family setting the model has no place for' : 'families other than inet, inet6 and ethernet-switching come later'
    return 'a unit setting the model has no place for'
  }
  if (r[0] === 'encapsulation' || r[0] === 'flexible-vlan-tagging' || r[0] === 'stacked-vlan-tagging') return 'interface encapsulations other than vlan-tagging come later'
  if (r[0] === 'esi') return 'EVPN multihoming (ESI) comes later'
  if (r[0] === 'gigether-options' || r[0] === 'ether-options') return 'Ethernet settings (speed, autonegotiation, flow control) come later'
  if (r[0] === 'apply-macro') return "apply-macro: data for commit scripts, which the model doesn't keep"
  return 'an interface setting the model has no place for'
}

// The secret values of a Junos configuration, hierarchical or set, as the conformance kit's patterns find them: hashes
// (`$1$…`, `$9$…`), SNMP communities, and `secret`, `authentication-key` (an NTP key's `… type md5 value X` too),
// `encrypted-password`, `simple-password`, a pre-shared key's `ascii-text` and `hexadecimal`, and a quoted `key`. Looser
// than the kit's where that costs nothing: a closing quote or a community's `{` isn't needed, as the kit also parses the
// configuration cut just after a secret, or with a quote opened after it. A word taken for a secret that isn't one only
// takes a reason's next choice.
const SECRETS: readonly RegExp[] = [
  /(\$(?:\d+|sha1|y|2[aby]?)\$[^\s"';]+)/g,
  /(?<![\w-])community[ \t]+("?[^\s";{]+)/gi,
  /(?<![\w-])authentication-key[ \t]+\d+[ \t]+type[ \t]+\S+[ \t]+value[ \t]+("?[^\s";]+)/gi,
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal)[ \t]+("?[^\s";]+)/gi,
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal|key)[ \t]+"([^"\n]+)/gi
]

/**
 * The secret values in `text`, for unconvertedReason() to keep out of a reason: four characters or more, as the kit
 * takes them (a shorter one is a word of many reasons and no secret).
 */
export function secretValues(text: string): string[] {
  const out = new Set<string>()
  for (const pattern of SECRETS)
    for (const m of text.matchAll(pattern)) {
      // A quote at either end isn't the secret's, as the kit takes it: `"comes"`, or `"comes` cut short.
      const value = m[m.length - 1].replace(/^"+/, '').replace(/"+$/, '')
      if (value.length >= 4) out.add(value)
    }
  return [...out]
}
