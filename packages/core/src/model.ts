// The shared device model: what every platform plugin parses into and renders from (the hub in docs/ARCHITECTURE.md).
// Shaped like OpenConfig (system, interfaces with subinterfaces and addresses, VLANs, network instances with static
// routes, OSPF and BGP, routing policy), borrowing its structure and names, not its code, as plain readonly types serialised as JSON (serialize.ts).
//
// Conventions every type here keeps, because the coverage ledger walks the model generically (ledger.ts):
// - **Collections are maps keyed by their natural key** (an interface's name, an address, a prefix), never arrays of
//   objects, so each leaf has a stable path: `interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.addresses["192.0.2.1"].prefixLength`.
// - **Leaves** are strings, numbers, booleans and arrays of those (leaf-lists). A presence-only setting is a boolean
//   leaf (`true`). An entry configured with no options is an empty object (`ntp.servers["192.0.2.1"]: {}`): its key is
//   the configuration, and the ledger counts the empty object as a leaf (paths.ts), so it can't be dropped unnoticed.
// - **Absent means not configured.** Leave a field out rather than set it to null or a default the source didn't say.
// - **A key can be any string a configuration holds**, `__proto__`, `constructor` and `toString` included. Code that
//   builds or reads a keyed map uses null-prototype objects (`Object.create(null)`) or a `Map`, and own-property checks
//   (`Object.hasOwn`), never `map[key] ??= {}` on a plain object, which follows `Object.prototype` for such a key.
//   JSON.parse already makes `__proto__` an own property, and the core's walks read own properties only.
//
// The model has its own version, MODEL_VERSION, separate from the package's. **Minor = additive only** (new optional
// fields and new object types); **major = breaking** (renames, changed meanings). That holds in 0.x too, unlike semver's
// caret convention: a plugin built for 0.1 declares `modelApi: '>=0.1.0 <1.0.0'` and keeps loading as 0.x grows,
// while the ledger reports any populated field it has never heard of as unrendered.

/** The shared model's version (docs/SPEC.md §4). Bump minor for additions, major for breaking changes. */
export const MODEL_VERSION = '0.5.0'

/** A map from a collection's natural key to its entries. */
export type Keyed<T> = Readonly<Record<string, T>>

/** A whole device's configuration. */
export interface Device {
  readonly system?: System
  /** By interface name, as the source platform writes it (`ge-0/0/0`, `GigabitEthernet0/0/1`). */
  readonly interfaces?: Keyed<Interface>
  /**
   * By VLAN ID, as a decimal string from `1` to `4094` (`"10"`): the device's VLANs, after OpenConfig `vlans`. Junos
   * names its VLANs and gives each an ID; the model keys them by the ID, which every platform has, and keeps the name.
   * Since model 0.4.0.
   */
  readonly vlans?: Keyed<Vlan>
  /** By instance name; the global routing table is `default`. */
  readonly networkInstances?: Keyed<NetworkInstance>
  /** Prefix lists, community and AS-path sets, and routing policies. Since model 0.5.0. */
  readonly routingPolicy?: RoutingPolicy
}

export interface System {
  readonly hostname?: string
  readonly domainName?: string
  /** Since model 0.2.0. */
  readonly dns?: Dns
  readonly ntp?: Ntp
  readonly logging?: Logging
  readonly snmp?: Snmp
}

/** Name resolution, after OpenConfig `system/dns` (since model 0.2.0). */
export interface Dns {
  /** By server address, in the order the source lists them. */
  readonly servers?: Keyed<DnsServer>
  /** Domains to search, in order (Junos `domain-search`, IOS `ip domain list`). */
  readonly search?: readonly string[]
}

export interface DnsServer {
  /** The network instance the server is reached through, when not `default` (IOS `ip name-server vrf V`). */
  readonly networkInstance?: string
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

/**
 * What an interface is. `irb-or-svi` (since model 0.4.0) is a routed VLAN interface: Junos `irb`, whose units each
 * route for a VLAN, Cisco `interface Vlan10`. Plugins built for 0.1 to 0.3 call those `vlan`, which stays as it was.
 */
export type InterfaceType = 'ethernet' | 'aggregate' | 'loopback' | 'vlan' | 'irb-or-svi' | 'management' | 'tunnel' | 'other'

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
  /** Its layer 2 settings, when it is a switch port (Junos `family ethernet-switching`, Cisco `switchport`). Since model 0.4.0. */
  readonly switching?: Switching
}

/** A switch port's mode: an access port carries one VLAN, untagged; a trunk carries several, tagged. */
export type SwitchportMode = 'access' | 'trunk'

/**
 * A switch port, after OpenConfig `switched-vlan`: Junos `unit 0 family ethernet-switching` (ELS) and Cisco
 * `switchport`. An access port's frames are untagged, in its access VLAN; a trunk's are tagged with their VLAN, except
 * the native VLAN's, which are untagged. The settings of the mode the port isn't in are kept as the source has them.
 * Since model 0.4.0.
 */
export interface Switching {
  readonly mode?: SwitchportMode
  /** The VLAN ID an access port is in (Junos `vlan members`, Cisco `switchport access vlan`). */
  readonly accessVlan?: number
  /**
   * The VLANs a trunk carries, as single IDs (`"10"`) and ranges (`"20-30"`, first below last), from 1 to 4094, in the
   * source's order: Junos `vlan members`, Cisco `switchport trunk allowed vlan`. Every VLAN is `"1-4094"`. A single ID
   * names an entry of `Device.vlans`; a range carries whichever of its VLANs exist.
   */
  readonly allowedVlans?: readonly string[]
  /** The VLAN ID whose frames a trunk carries untagged (Junos `native-vlan-id`, Cisco `switchport trunk native vlan`). */
  readonly nativeVlan?: number
}

/** A VLAN (since model 0.4.0). */
export interface Vlan {
  /** Junos's name for it, the key its config uses (`vlans v10 { vlan-id 10; }`), Cisco's `name`. */
  readonly name?: string
  readonly description?: string
}

export interface Subinterface {
  readonly description?: string
  readonly enabled?: boolean
  /** The 802.1Q tag (Junos `vlan-id`, Cisco `encapsulation dot1Q`). */
  readonly vlanId?: number
  readonly ipv4?: AddressFamily
  readonly ipv6?: AddressFamily
  /**
   * The network instance (VRF) the subinterface routes in, when not `default`: NX-OS `vrf member V`, IOS
   * `vrf forwarding V`, IOS-XR `vrf V`, Junos `routing-instances V interface ge-0/0/0.0`. A main interface's own L3 is
   * subinterface `0`. It names an entry of `Device.networkInstances` (modelProblems() checks). Since model 0.3.0.
   */
  readonly networkInstance?: string
  /**
   * The VLAN ID this subinterface routes for, on an `irb-or-svi` interface: Junos `vlans V l3-interface irb.10` on unit
   * 10, Cisco `interface Vlan10` on subinterface `0`. It names an entry of `Device.vlans` (modelProblems() checks).
   * Since model 0.4.0.
   */
  readonly routedVlan?: number
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

/**
 * What a network instance is: the global table, a VRF (an L3VPN instance, with a route distinguisher on platforms that
 * need one), or a virtual router (its own table, no VPN: Junos `instance-type virtual-router`). `virtual-router` since
 * model 0.3.0.
 */
export type NetworkInstanceType = 'default' | 'vrf' | 'virtual-router'

export interface NetworkInstance {
  readonly type?: NetworkInstanceType
  /**
   * The route distinguisher, as `ASN:nn` (a 2-byte AS and a 4-byte number), `IP:nn` (an IPv4 address and a 2-byte
   * number) or `ASN4:nn` (a 4-byte AS in plain form and a 2-byte number): `65000:100`, `192.0.2.1:100`,
   * `4200000000:100`. isRouteDistinguisher() says which strings are one. Since model 0.3.0.
   */
  readonly routeDistinguisher?: string
  /** Route targets, in the same three forms as the route distinguisher, without a `target:` prefix. Since model 0.3.0. */
  readonly routeTargets?: RouteTargets
  /** By destination prefix in CIDR form (`0.0.0.0/0`, `2001:db8::/32`). */
  readonly staticRoutes?: Keyed<StaticRoute>
  /** OSPF version 2 in this instance. Since model 0.4.0. */
  readonly ospf?: Ospf
  /** BGP in this instance. Since model 0.4.0. */
  readonly bgp?: Bgp
}

/** A VRF's route targets (leaf-lists, in the source's order). Since model 0.3.0. */
export interface RouteTargets {
  readonly import?: readonly string[]
  readonly export?: readonly string[]
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

// ---- OSPF and BGP (since model 0.4.0)
//
// A reference to an interface (an OSPF interface's key, a BGP update source) is written `name` or `name.<subinterface>`,
// as a next hop's `interface` is: `ge-0/0/0.0`, `GigabitEthernet0/0/0`. It names an interface of the model, and with a
// subinterface index that isn't part of a key, one of its subinterfaces (modelProblems() checks). Secrets are never
// carried: an OSPF or BGP key is a flag saying the source had one, so the target asks for it (a needs-input item).

/** OSPF version 2 in a network instance, after OpenConfig `ospfv2` (since model 0.4.0). */
export interface Ospf {
  /** Cisco's process number or tag (`router ospf 1`, NX-OS `router ospf UNDERLAY`); Junos has none. */
  readonly processId?: string
  /** An IPv4 address (`192.0.2.1`). */
  readonly routerId?: string
  /** By area ID in dotted form (`0.0.0.0`): Cisco's `area 0` is `0.0.0.0`, its `area 10` is `0.0.0.10`. */
  readonly areas?: Keyed<OspfArea>
}

/** An area's type: a stub area takes no external routes, an NSSA takes them from its own ASBRs only. */
export type OspfAreaType = 'normal' | 'stub' | 'nssa'

/**
 * How OSPF authenticates: plain text, MD5 with a key ID, or a key chain (Junos `keychain`, Cisco `key-chain`). The key
 * itself never: the target asks for it.
 */
export type OspfAuthentication = 'simple' | 'md5' | 'key-chain'

export interface OspfArea {
  readonly type?: OspfAreaType
  /** Authentication for the whole area (Cisco `area 0 authentication`), flagged only. */
  readonly authentication?: OspfAuthentication
  /** By interface reference (`ge-0/0/0.0`, `GigabitEthernet0/0/1`): the interfaces OSPF runs on in this area. */
  readonly interfaces?: Keyed<OspfInterface>
}

/** OSPF's network type on an interface. */
export type OspfNetworkType = 'point-to-point' | 'broadcast'

export interface OspfInterface {
  /**
   * How the source put the interface in the area: on the interface itself (Junos `area 0 interface ge-0/0/0.0`, Cisco
   * `ip ospf 1 area 0`) or with a `network` statement matching its address (Cisco `network 192.0.2.0 0.0.0.255 area
   * 0`), which also takes in any later interface in that range. A renderer that can't say it the same way raises a
   * semantic warning.
   */
  readonly enabledBy?: 'interface' | 'network'
  /** Advertised, but forms no adjacency (Junos `passive`, Cisco `passive-interface`). */
  readonly passive?: boolean
  readonly cost?: number
  readonly networkType?: OspfNetworkType
  /** In seconds. */
  readonly helloInterval?: number
  /** In seconds. */
  readonly deadInterval?: number
  /** Flagged only: the key is never carried. */
  readonly authentication?: OspfAuthentication
}

/** BGP in a network instance, after OpenConfig `bgp` (since model 0.4.0). */
export interface Bgp {
  /** The local AS number, in plain form (`65000`, `4200000000`), from 1 to 4294967295. */
  readonly localAs?: number
  /** An IPv4 address. */
  readonly routerId?: string
  /** Peer groups by name: Junos `group`, Cisco `peer-group` (IOS-XR's `neighbor-group`, NX-OS's `template peer`). */
  readonly groups?: Keyed<BgpGroup>
  /** By the neighbor's address (`192.0.2.2`, `2001:db8::2`). */
  readonly neighbors?: Keyed<BgpNeighbor>
  /**
   * What the source platform does with an eBGP peer's routes when no policy applies: its default, not configuration
   * (RFC 8212). A parser sets the side(s) that apply when the instance has an eBGP peer without an import or export
   * policy; a renderer whose own default differs raises a semantic warning. Since model 0.4.1.
   */
  readonly ebgpDefaultPolicy?: BgpDefaultPolicy
}

/**
 * A platform's default for an eBGP peer with no policy, per direction (since model 0.4.1): `accept` takes the routes
 * (Junos, IOS-XE), `reject` drops them (IOS-XR, after RFC 8212).
 */
export interface BgpDefaultPolicy {
  /** Routes received from an eBGP peer with no import policy. */
  readonly import?: 'accept' | 'reject'
  /** Routes sent to an eBGP peer with no export policy: `accept` advertises them. */
  readonly export?: 'accept' | 'reject'
}

/** What a group and a neighbor both say; a neighbor's own setting wins over its group's. */
export interface BgpPeer {
  /** The peer's AS number, in plain form, from 1 to 4294967295. */
  readonly peerAs?: number
  readonly description?: string
  /** The local address the session is sourced from (Junos `local-address`). */
  readonly localAddress?: string
  /** The interface the session is sourced from, as a reference (Cisco `update-source Loopback0`). */
  readonly updateSource?: string
  /** eBGP multihop; an empty object when the source gives no TTL. */
  readonly multihop?: BgpMultihop
  /** By address family: the families the session carries. */
  readonly addressFamilies?: Readonly<Partial<Record<BgpAddressFamilyName, BgpAddressFamily>>>
  /**
   * Import policies by name, in order (Junos `import`). Each names an entry of `Device.routingPolicy.policies` (since
   * model 0.5.0, modelProblems() checks, for a plugin that parses routing policy).
   */
  readonly importPolicies?: readonly string[]
  /** Export policies by name, in order (Junos `export`). */
  readonly exportPolicies?: readonly string[]
  /** Flagged only: the session has a password (Junos `authentication-key`, Cisco `password`), never carried. */
  readonly authentication?: boolean
}

export interface BgpMultihop {
  readonly ttl?: number
}

/** The address families phase 2 covers. */
export type BgpAddressFamilyName = 'ipv4-unicast' | 'ipv6-unicast'

/**
 * A peer's address family, with the policies the source applies to that family only (Cisco's `neighbor … route-map`
 * under `address-family ipv4`). Configured with nothing else, it is an empty object.
 */
export interface BgpAddressFamily {
  readonly importPolicies?: readonly string[]
  readonly exportPolicies?: readonly string[]
}

export interface BgpGroup extends BgpPeer {
  /** Junos's group type: `internal` (iBGP) or `external` (eBGP). */
  readonly type?: 'internal' | 'external'
}

export interface BgpNeighbor extends BgpPeer {
  /** The group it is in: names an entry of `groups` (modelProblems() checks). */
  readonly group?: string
}

// ---- Routing policy (since model 0.5.0)
//
// After OpenConfig `routing-policy` (defined sets and policy definitions) and `bgp-policy` (community and AS-path sets),
// simplified. Device-wide: Junos `policy-options`, Cisco's prefix lists, community and AS-path lists and route maps,
// IOS-XR's sets and route policies.
//
// **Ordered collections are keyed by position:** a policy's terms, a prefix list's entries, a set's entries. A key is a
// decimal number with no sign or leading zero, from 0 to 4294967294 (modelProblems() checks): the source's sequence
// number where it has one (a route map's `permit 10`, a prefix list's `seq 5`), else its place counting from 1 (Junos
// terms and prefix lists, IOS-XR sets). JavaScript and JSON keep such keys in numeric order, whatever order they were
// added in, so the model's order is the keys' order and a field's path stays the same. A name the source gives (a
// Junos term's) is a leaf of its own.
//
// **Regular expressions are never translated:** each is kept as written, with the dialect it is written in
// (`RegexDialect`). A renderer of another dialect leaves it `unsupported`, or translates it and says so with a
// semantic warning on its field; it never writes it as if it were its own.

/** Prefix lists, community and AS-path sets, and policies (since model 0.5.0). */
export interface RoutingPolicy {
  /** Per address family, by name: Cisco's `ip prefix-list` and `ipv6 prefix-list`; a Junos list goes in each family it has prefixes of. */
  readonly prefixLists?: PrefixLists
  /** By name: Junos `community`, Cisco `ip community-list`, `ip extcommunity-list` and `ip large-community-list`, IOS-XR `community-set`. */
  readonly communitySets?: Keyed<CommunitySet>
  /** By name: Junos `as-path` and `as-path-group`, Cisco `ip as-path access-list`, IOS-XR `as-path-set`. */
  readonly asPathSets?: Keyed<AsPathSet>
  /** By name: Junos `policy-statement`, Cisco `route-map`, IOS-XR `route-policy`. */
  readonly policies?: Keyed<Policy>
}

export interface PrefixLists {
  readonly ipv4?: Keyed<PrefixList>
  readonly ipv6?: Keyed<PrefixList>
}

/** A prefix list: the first entry that matches a route decides (permit or deny); none matching is a deny. */
export interface PrefixList {
  readonly description?: string
  /** By position (the source's `seq`, else its place from 1). An empty list is `{}`. */
  readonly entries?: Keyed<PrefixListEntry>
}

/**
 * The source's form of a prefix match, kept so a renderer can write it the same way where it can. Junos route filters:
 * `exact`, `orlonger`, `longer`, `upto`, `prefix-length-range`. Cisco prefix lists: `exact` (no `ge` or `le`), `ge`,
 * `le`, `ge-le`. Each is also said as a length range (`PrefixMatch`), which the form must agree with.
 */
export type PrefixMatchForm = 'exact' | 'orlonger' | 'longer' | 'upto' | 'prefix-length-range' | 'ge' | 'le' | 'ge-le'

/**
 * A prefix with the lengths it matches: routes within `prefix` whose length is from `minLength` to `maxLength`, both
 * always given, with the prefix's length ≤ `minLength` ≤ `maxLength` ≤ 32 (IPv4) or 128 (IPv6). `10.0.0.0/8 orlonger`
 * and `10.0.0.0/8 le 32` are `{ prefix: '10.0.0.0/8', minLength: 8, maxLength: 32 }`; an exact match is the prefix's
 * own length twice.
 */
export interface PrefixMatch {
  /** In CIDR form, with no host bits set (`10.0.0.0/8`, `2001:db8::/32`). */
  readonly prefix: string
  readonly minLength: number
  readonly maxLength: number
  /** How the source wrote it. Left out, a renderer chooses. */
  readonly form?: PrefixMatchForm
}

export interface PrefixListEntry extends PrefixMatch {
  /** Junos prefix lists only permit. */
  readonly action: 'permit' | 'deny'
}

/**
 * The regular-expression dialect a pattern is written in. `junos`: Junos's, which matches an AS path by whole AS
 * numbers (`65000 .*`) and a community member by one community (`65000:.*`). `cisco`: Cisco's (IOS, NX-OS, IOS-XR
 * `ios-regex`), which matches the path or the route's communities as a string of characters (`_65000_`).
 */
export type RegexDialect = 'junos' | 'cisco'

/**
 * A community set. A community is written in one form whatever the platform (communityType() says which it is):
 * standard `65000:100` (each part up to 65535) or a well-known name (`no-export`, `no-advertise`, `no-export-subconfed`
 * (Cisco `local-AS`), `graceful-shutdown`, `blackhole`, `accept-own`, `no-peer`, `llgr-stale`, `no-llgr`); extended
 * `target:65000:100` or `origin:192.0.2.1:100` (a route target or site of origin, in a route distinguisher's forms);
 * large `large:65000:1:2` (each part up to 4294967295).
 */
export interface CommunitySet {
  /**
   * By position. A route matches the first entry it fits (it carries every member and matches every regex), which
   * permits or denies it; none fitting is a deny. A Junos community is one entry, permit, whose members a route must
   * all carry.
   */
  readonly entries?: Keyed<CommunitySetEntry>
  /** The dialect of the entries' `regexes`: given whenever one has a regex. */
  readonly regexDialect?: RegexDialect
}

export interface CommunitySetEntry {
  readonly action: 'permit' | 'deny'
  /** Communities, in the model's forms: a route must carry each. */
  readonly members?: readonly string[]
  /** Patterns, in the set's `regexDialect`, as written: a route must match each. */
  readonly regexes?: readonly string[]
}

/** An AS-path set: the first entry whose regex matches a route's AS path permits or denies it; none matching is a deny. */
export interface AsPathSet {
  /** By position. */
  readonly entries?: Keyed<AsPathSetEntry>
  /** The dialect its regexes are written in: given whenever it has an entry. */
  readonly regexDialect?: RegexDialect
}

export interface AsPathSetEntry {
  readonly action: 'permit' | 'deny'
  /** As written, in the set's `regexDialect`. */
  readonly regex: string
}

/**
 * What a policy does with a route no term decides: the platform's semantics, not configuration, kept with the data as
 * BGP's `ebgpDefaultPolicy` is. `next-policy` (Junos): the next policy of the chain, and after the last, the
 * protocol's default policy. `reject`: Cisco's route map (an implicit deny) and IOS-XR's route policy (a drop).
 */
export type PolicyFallThrough = 'next-policy' | 'reject'

/**
 * A routing policy: terms in order, each matching routes and acting on them. A route goes through the terms until one
 * accepts or rejects it (or sends it to the next policy); a term with no flow action lets it go on to the next term.
 */
export interface Policy {
  /** By position: a route map's sequence number, a Junos term's place from 1. */
  readonly terms?: Keyed<PolicyTerm>
  /**
   * What happens to a route no term decides. A parser sets it on every policy; a renderer gives it a `not-applicable`
   * disposition and raises a semantic warning when its platform's differs.
   */
  readonly fallThrough?: PolicyFallThrough
}

/**
 * A term: Junos `term T { from …; then …; }` (a policy's `from` and `then` outside any term are its one unnamed term),
 * a route map's sequence (`route-map M permit 10` with its `match` and `set` lines), an IOS-XR `if … then … endif` in
 * its simple forms. Converted whole or not at all (docs/ARCHITECTURE.md, the per-term rule).
 */
export interface PolicyTerm {
  /** The Junos term's name. */
  readonly name?: string
  /** Every condition given must hold (and within a list, any of its entries). None given matches every route. */
  readonly matches?: PolicyMatches
  readonly actions?: PolicyActions
}

/** A route's source protocol, in the model's names (Junos `direct` and Cisco `connected` are `connected`). */
export type RouteProtocol = 'bgp' | 'ospf' | 'static' | 'connected' | 'local' | 'aggregate' | 'isis'

export interface PolicyMatches {
  /** Prefix lists by name, per family: a route matches when any of them permits it. */
  readonly prefixLists?: PolicyPrefixLists
  /**
   * How the lists' prefixes match: `exact` (by default), or the prefix and longer ones (`orlonger`, Junos
   * `prefix-list-filter L orlonger`) or only longer ones (`longer`).
   */
  readonly prefixListMatch?: 'exact' | 'orlonger' | 'longer'
  /** Inline prefixes (Junos `route-filter`), by position: a route matches when any of them does. */
  readonly routeFilters?: Keyed<PrefixMatch>
  /** Community sets by name: a route matches when any permits it. */
  readonly communitySets?: readonly string[]
  /** AS-path sets by name: a route matches when any permits it. */
  readonly asPathSets?: readonly string[]
  readonly protocols?: readonly RouteProtocol[]
  /** BGP neighbors' addresses. */
  readonly neighbors?: readonly string[]
  readonly tags?: readonly number[]
  /** Only routes of this family (Junos `family inet`). */
  readonly family?: 'ipv4' | 'ipv6'
}

export interface PolicyPrefixLists {
  /** Names of `RoutingPolicy.prefixLists.ipv4` entries. */
  readonly ipv4?: readonly string[]
  /** Names of `RoutingPolicy.prefixLists.ipv6` entries. */
  readonly ipv6?: readonly string[]
}

/**
 * Where a matched route goes once the term's other actions are done: `accept` or `reject` it (a route map's `permit`
 * or `deny`), on to the `next-term`, or to the `next-policy` of the chain. Left out, it goes on to the next term.
 */
export type PolicyFlow = 'accept' | 'reject' | 'next-term' | 'next-policy'

export interface PolicyActions {
  readonly flow?: PolicyFlow
  /** Local preference, from 0 to 4294967295. */
  readonly localPreference?: number
  /** MED (Junos `metric`), from 0 to 4294967295. */
  readonly med?: number
  /** Communities added to the route's. */
  readonly communityAdd?: CommunityValues
  /** Communities that replace the route's. */
  readonly communitySet?: CommunityValues
  /** Communities taken off the route. */
  readonly communityDelete?: CommunityValues
  /** AS numbers put in front of the AS path, in order (`65000 65000`). */
  readonly asPathPrepend?: readonly number[]
  /** An IP address. */
  readonly nextHop?: string
  /** The local address as next hop (Junos `next-hop self`). */
  readonly nextHopSelf?: boolean
  /** From 0 to 4294967295. */
  readonly tag?: number
}

/** Communities for an action: literal values (Cisco `set community 65000:1`), named sets (Junos `community add C`), or both. */
export interface CommunityValues {
  /** In the model's community forms. */
  readonly values?: readonly string[]
  /** Names of `RoutingPolicy.communitySets` entries. */
  readonly sets?: readonly string[]
}
