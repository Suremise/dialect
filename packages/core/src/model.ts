// The shared device model: what every platform plugin parses into and renders from (the hub in docs/ARCHITECTURE.md).
// Shaped like OpenConfig (system, interfaces with subinterfaces and addresses, network instances with static routes),
// borrowing its structure and names, not its code, as plain readonly types serialised as JSON (serialize.ts).
//
// Conventions every type here keeps, because the coverage ledger walks the model generically (ledger.ts):
// - **Collections are maps keyed by their natural key** (an interface's name, an address, a prefix), never arrays of
//   objects, so each leaf has a stable path: `interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.addresses["192.0.2.1"].prefixLength`.
// - **Leaves** are strings, numbers, booleans and arrays of those (leaf-lists). A presence-only setting is a boolean
//   leaf (`true`). An entry configured with no options is an empty object (`ntp.servers["192.0.2.1"]: {}`): its key is
//   the configuration, and the ledger counts the empty object as a leaf (paths.ts), so it can't be dropped unnoticed.
// - **Absent means not configured.** Leave a field out rather than set it to null or a default the source didn't say.
//
// The model has its own version, MODEL_VERSION, separate from the package's. **Minor = additive only** (new optional
// fields and new object types); **major = breaking** (renames, changed meanings). That holds in 0.x too, unlike semver's
// caret convention: a plugin built for 0.1 declares `modelApi: '>=0.1.0 <1.0.0'` and keeps loading as 0.x grows,
// while the ledger reports any populated field it has never heard of as unrendered.

/** The shared model's version (docs/SPEC.md §4). Bump minor for additions, major for breaking changes. */
export const MODEL_VERSION = '0.1.0'

/** A map from a collection's natural key to its entries. */
export type Keyed<T> = Readonly<Record<string, T>>

/** A whole device's configuration. */
export interface Device {
  readonly system?: System
  /** By interface name, as the source platform writes it (`ge-0/0/0`, `GigabitEthernet0/0/1`). */
  readonly interfaces?: Keyed<Interface>
  /** By instance name; the global routing table is `default`. */
  readonly networkInstances?: Keyed<NetworkInstance>
}

export interface System {
  readonly hostname?: string
  readonly domainName?: string
  readonly ntp?: Ntp
  readonly logging?: Logging
  readonly snmp?: Snmp
}

export interface Ntp {
  /** By server address (an IP address or a host name). */
  readonly servers?: Keyed<NtpServer>
  readonly sourceInterface?: string
}

export interface NtpServer {
  readonly prefer?: boolean
  readonly version?: number
  /** The network instance the server is reached through, when not `default`. */
  readonly networkInstance?: string
}

/** Syslog severities, as RFC 5424 names them. */
export type SyslogSeverity = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'informational' | 'debug'

export interface Logging {
  /** Remote syslog hosts, by address. */
  readonly remoteServers?: Keyed<SyslogServer>
  readonly sourceInterface?: string
}

export interface SyslogServer {
  /** The lowest severity sent, for every facility. */
  readonly severity?: SyslogSeverity
  readonly facility?: string
  readonly port?: number
  readonly networkInstance?: string
}

export interface Snmp {
  readonly location?: string
  readonly contact?: string
  /** By community name. Community names are secrets: fixtures use placeholders (docs/SPEC.md §5). */
  readonly communities?: Keyed<SnmpCommunity>
}

export interface SnmpCommunity {
  readonly access?: 'read-only' | 'read-write'
  /** Client prefixes allowed to use it (leaf-list). */
  readonly clients?: readonly string[]
}

export type InterfaceType = 'ethernet' | 'aggregate' | 'loopback' | 'vlan' | 'management' | 'tunnel' | 'other'

export interface Interface {
  readonly type?: InterfaceType
  readonly description?: string
  /** False when administratively disabled (Junos `disable`, Cisco `shutdown`). */
  readonly enabled?: boolean
  readonly mtu?: number
  /** True when the interface carries 802.1Q-tagged subinterfaces (Junos `vlan-tagging`). */
  readonly vlanTagging?: boolean
  /** By index as a string: Junos unit numbers, Cisco subinterface numbers (`0` for an untagged unit). */
  readonly subinterfaces?: Keyed<Subinterface>
}

export interface Subinterface {
  readonly description?: string
  readonly enabled?: boolean
  /** The 802.1Q tag (Junos `vlan-id`, Cisco `encapsulation dot1Q`). */
  readonly vlanId?: number
  readonly ipv4?: AddressFamily
  readonly ipv6?: AddressFamily
}

export interface AddressFamily {
  /** By address without its prefix length (`192.0.2.1`, `2001:db8::1`). */
  readonly addresses?: Keyed<Address>
  readonly mtu?: number
}

export interface Address {
  readonly prefixLength: number
  /** Junos `primary`. */
  readonly primary?: boolean
}

export interface NetworkInstance {
  readonly type?: 'default' | 'vrf'
  /** By destination prefix in CIDR form (`0.0.0.0/0`, `2001:db8::/32`). */
  readonly staticRoutes?: Keyed<StaticRoute>
}

export interface StaticRoute {
  /** By an index of the plugin's choosing, as a string (`0`, `1`…), in the source's order. */
  readonly nextHops?: Keyed<NextHop>
  readonly description?: string
}

export interface NextHop {
  /** An IP address. */
  readonly address?: string
  readonly interface?: string
  /** Drop the traffic: silently (`discard`, Cisco `Null0`) or with an ICMP unreachable (`reject`). */
  readonly drop?: 'discard' | 'reject'
  /** Administrative distance (Junos `preference`, Cisco's distance). */
  readonly preference?: number
  readonly metric?: number
  readonly tag?: number
}
