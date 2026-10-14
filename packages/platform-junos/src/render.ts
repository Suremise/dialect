// The shared model → hierarchical Junos, for the phase 1 areas and 0.4's VLANs, switch ports and IRB. Every populated
// leaf of model 0.3, and of those, gets a disposition: `rendered` with the line it went to, `unsupported` with why
// (Junos can't say it, or this renderer can't yet), or `not-applicable` (Junos implies it). Fields it doesn't render
// yet (0.4's OSPF and BGP) are left without one, so the ledger reports them as unrendered rather than this renderer
// claiming them.
//
// Diagnostics never quote the model's keys or values, nor carry a field path with them: a community name is a secret.
//
// A VRF can't be committed on Junos without a route distinguisher and route targets: one the model gives without them
// is written with what it has, and each missing part is a needs-input item (`routeDistinguisherInputId()`,
// `routeTargetInputId()`), answered through Context.inputs. Nothing is made up.
import { fieldPath, isAsNumber, isRouteDistinguisher, isVlanId, populatedLeaves, type AddressFamily, type Bgp, type BgpGroup, type BgpPeer, type Ospf, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NeedsInput, type NetworkInstance, type NextHop, type RenderResult, type StaticRoute, type Subinterface, type Switching } from '@dialect/core'
import { isIpv4, isIpv6, parsePrefix } from './addresses'
import { fromJunos, targetFromJunos, toJunos } from './communities'
import { SEVERITIES } from './parse'
import { quote } from './words'

type Segments = readonly string[]

/** A statement to write: a leaf (`host-name r1;`) or a container, and the fields it says. */
interface Out {
  readonly text: string
  readonly children: Out[] | null
  readonly fields: Segments[]
}

const JUNOS_SEVERITY: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SEVERITIES).map(([junos, model]) => [model, junos]))
/** The facilities `facility-override` takes. */
const FACILITIES = new Set(['authorization', 'daemon', 'ftp', 'kernel', 'user', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'])
const INTEGER = /^\d+$/
const ROUTE_SETTINGS = ['preference', 'metric', 'tag'] as const
/** A VLAN key as the model writes one: a VLAN ID from 1 to 4094 (`"10"`). */
const isVlanKey = (key: string): boolean => /^[1-9]\d*$/.test(key) && isVlanId(Number(key))
/** A trunk's allowed VLAN: an ID, or a range of them, first below last (`"20-30"`). */
const isVlanEntry = (entry: string): boolean => {
  const [first, last, ...rest] = entry.split('-')
  return !rest.length && isVlanKey(first) && (last === undefined || (isVlanKey(last) && Number(first) < Number(last)))
}

/** The needs-input id for a VRF's route distinguisher, which the model doesn't give. */
export const routeDistinguisherInputId = (instance: string): string => `junos.route-distinguisher:${instance}`
/** The needs-input id for a VRF's route target, for the side (or sides) the model doesn't give. */
export const routeTargetInputId = (instance: string): string => `junos.vrf-target:${instance}`
/** The needs-input id for an OSPF interface's key, which the model flags but never carries. */
export const ospfKeyInputId = (instance: string, area: string, ref: string): string => `junos.ospf-key:${instance}:${area}:${ref}`
/** The needs-input id for a BGP group's or neighbor's key, which the model flags but never carries. */
export const bgpKeyInputId = (instance: string, kind: 'group' | 'neighbor', name: string): string => `junos.bgp-key:${instance}:${kind}:${name}`

export function render(model: Device, context: Context): RenderResult {
  const dispositions: Record<string, FieldDisposition> = {}
  const diagnostics: Diagnostic[] = []
  const needsInput: NeedsInput[] = []
  /** The user's answer for a needs-input item, in the model's form, or null (none, or not one): `read` takes it. */
  const answer = (id: string, read: (value: string) => string | null): string | null => {
    const inputs = context.inputs
    const given = inputs && Object.hasOwn(inputs, id) ? inputs[id] : undefined
    if (given === undefined) return null
    const value = read(given.trim())
    if (value === null) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.input-form', message: "An answer for a VRF isn't in the form asked for, so it isn't used." })
    return value
  }

  const leaf = (text: string, ...fields: Segments[]): Out => ({ text, children: null, fields })
  const box = (text: string, children: Out[], ...fields: Segments[]): Out => ({ text, children, fields })
  const skip = (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => {
    dispositions[fieldPath(...field)] = { kind, reason }
  }
  /** Every populated leaf under `at` (of `value`), as unsupported: a part the renderer can't write at all. */
  const skipAll = (value: unknown, at: Segments, reason: string) => {
    for (const l of populatedLeaves(value, [...at])) dispositions[l.path] = { kind: 'unsupported', reason }
  }
  /** An object configured with nothing in it is a leaf of its own (`{}`). */
  const isEmpty = (value: object | undefined) => value !== undefined && populatedLeaves(value, ['x']).every((l) => l.path === 'x')
  const emptyContainer = (value: object | undefined, at: Segments) => {
    if (value !== undefined && isEmpty(value)) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }
  /** The fields to mark on an entry's own statement: the entry itself when it was configured with nothing in it. */
  const self = (value: object, at: Segments): Segments[] => (isEmpty(value) ? [at] : [])

  const top: Out[] = []

  // ---- system: host name, domain, DNS, NTP, syslog

  const system = model.system
  if (system) {
    emptyContainer(system, ['system'])
    const out: Out[] = []
    if (system.hostname !== undefined) out.push(leaf(`host-name ${quote(system.hostname)}`, ['system', 'hostname']))
    if (system.domainName !== undefined) out.push(leaf(`domain-name ${quote(system.domainName)}`, ['system', 'domainName']))
    const dns = system.dns
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        else out.push(leaf(dns.search.length === 1 ? `domain-search ${quote(dns.search[0])}` : `domain-search [ ${dns.search.map(quote).join(' ')} ]`, ['system', 'dns', 'search']))
      }
      const servers: Out[] = []
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        if (!isIpv4(address) && !isIpv6(address)) {
          skipAll(server, at, 'a name server that is not an address')
          continue
        }
        const fields = self(server, at)
        let text = address
        if (server.networkInstance !== undefined) {
          text += ` routing-instance ${quote(server.networkInstance)}`
          fields.push([...at, 'networkInstance'])
        }
        servers.push(leaf(text, ...fields))
      }
      if (servers.length) out.push(box('name-server', servers))
    }
    if (system.ntp) out.push(...ntpOf(system.ntp))
    if (system.logging) out.push(...syslogOf(system.logging))
    if (out.length) top.push(box('system', out))
  }

  function ntpOf(ntp: NonNullable<NonNullable<Device['system']>['ntp']>): Out[] {
    const at = ['system', 'ntp']
    emptyContainer(ntp, at)
    emptyContainer(ntp.servers, [...at, 'servers'])
    if (ntp.sourceInterface !== undefined) skip([...at, 'sourceInterface'], 'unsupported', 'Junos sends NTP from a source address, not an interface')
    const servers: Out[] = []
    for (const [address, server] of Object.entries(ntp.servers ?? {})) {
      const s = [...at, 'servers', address]
      const fields = self(server, s)
      let text = `server ${quote(address)}`
      if (server.version !== undefined) {
        text += ` version ${server.version}`
        fields.push([...s, 'version'])
      }
      if (server.prefer !== undefined) {
        if (server.prefer) text += ' prefer'
        fields.push([...s, 'prefer'])
      }
      if (server.networkInstance !== undefined) {
        text += ` routing-instance ${quote(server.networkInstance)}`
        fields.push([...s, 'networkInstance'])
      }
      servers.push(leaf(text, ...fields))
    }
    return servers.length ? [box('ntp', servers)] : []
  }

  function syslogOf(logging: NonNullable<NonNullable<Device['system']>['logging']>): Out[] {
    const at = ['system', 'logging']
    emptyContainer(logging, at)
    emptyContainer(logging.remoteServers, [...at, 'remoteServers'])
    if (logging.sourceInterface !== undefined) skip([...at, 'sourceInterface'], 'unsupported', 'Junos sends syslog from a source address, not an interface')
    const hosts: Out[] = []
    for (const [address, server] of Object.entries(logging.remoteServers ?? {})) {
      const s = [...at, 'remoteServers', address]
      const out: Out[] = []
      if (server.severity !== undefined) {
        if (Object.hasOwn(JUNOS_SEVERITY, server.severity)) out.push(leaf(`any ${JUNOS_SEVERITY[server.severity]}`, [...s, 'severity']))
        else skip([...s, 'severity'], 'unsupported', 'not a syslog severity')
      }
      if (server.facility !== undefined) {
        if (FACILITIES.has(server.facility)) out.push(leaf(`facility-override ${server.facility}`, [...s, 'facility']))
        else skip([...s, 'facility'], 'unsupported', "not a facility Junos's facility-override takes")
      }
      if (server.port !== undefined) out.push(leaf(`port ${server.port}`, [...s, 'port']))
      if (server.networkInstance !== undefined) out.push(leaf(`routing-instance ${quote(server.networkInstance)}`, [...s, 'networkInstance']))
      hosts.push(out.length ? box(`host ${quote(address)}`, out) : leaf(`host ${quote(address)}`, ...self(server, s)))
    }
    return hosts.length ? [box('syslog', hosts)] : []
  }

  // ---- VLAN names: Junos keys a VLAN by its name, the model by its ID

  /** Each VLAN's name on Junos, by the model's key: its own, or `vlan<ID>` for one without (or whose name another VLAN took first). */
  const vlanNames = new Map<string, string>()
  {
    const taken = new Set<string>()
    const valid = Object.entries(model.vlans ?? {}).filter(([key]) => isVlanKey(key))
    for (const [key, vlan] of valid) {
      if (vlan.name === undefined || vlan.name === '' || taken.has(vlan.name)) continue
      taken.add(vlan.name)
      vlanNames.set(key, vlan.name)
    }
    for (const [key] of valid) {
      if (vlanNames.has(key)) continue
      let name = `vlan${Number(key)}`
      for (let n = 2; taken.has(name); n++) name = `vlan${Number(key)}-${n}`
      taken.add(name)
      vlanNames.set(key, name)
    }
  }
  /** A VLAN as `vlan members` names it: by its name when the model has it, else by its ID. */
  const memberName = (entry: string): string => (entry === '1-4094' ? 'all' : vlanNames.get(String(Number(entry))) ?? entry)

  // ---- interfaces

  const interfaces: Out[] = []
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) interfaces.push(interfaceOf(name, iface))
  emptyContainer(model.interfaces, ['interfaces'])
  if (interfaces.length) top.push(box('interfaces', interfaces))

  function interfaceOf(name: string, iface: Interface): Out {
    const at = ['interfaces', name]
    const out: Out[] = []
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', "Junos gives an interface's type by its name")
    if (iface.description !== undefined) out.push(leaf(`description ${quote(iface.description)}`, [...at, 'description']))
    if (iface.enabled === false) out.push(leaf('disable', [...at, 'enabled']))
    else if (iface.enabled) skip([...at, 'enabled'], 'not-applicable', 'a Junos interface is enabled unless disabled')
    if (iface.vlanTagging) out.push(leaf('vlan-tagging', [...at, 'vlanTagging']))
    else if (iface.vlanTagging === false) skip([...at, 'vlanTagging'], 'not-applicable', 'a Junos interface is untagged unless vlan-tagging is set')
    if (iface.mtu !== undefined) out.push(leaf(`mtu ${iface.mtu}`, [...at, 'mtu']))
    const switching = iface.switching ? switchingOf(iface.switching, [...at, 'switching']) : null
    if (switching?.native) out.push(switching.native)
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])
    let unit0 = false
    const units = out.length
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      const s = [...at, 'subinterfaces', index]
      if (!INTEGER.test(index)) {
        skipAll(sub, s, 'a Junos unit is a number')
        continue
      }
      // A switch port is unit 0's family ethernet-switching.
      const own = Number(index) === 0 && switching ? [switching.family] : []
      unit0 ||= own.length > 0
      out.push(unitOf(index, sub, s, own))
    }
    if (switching && !unit0) out.splice(units, 0, box('unit 0', [switching.family]))
    // An interface with nothing to write but its type is still configured: `ge-0/0/0;`.
    return out.length ? box(quote(name), out) : leaf(quote(name), ...self(iface, at))
  }

  /**
   * A switch port (ELS): unit 0's `family ethernet-switching` with its `interface-mode` and `vlan members`, and the
   * interface's `native-vlan-id`. `vlan members` is an access port's VLAN, or a trunk's (Junos's default mode is
   * access), so the VLANs of the mode the port isn't in have no place.
   */
  function switchingOf(sw: Switching, at: Segments): { family: Out; native: Out | null } {
    const out: Out[] = []
    const trunk = sw.mode === 'trunk'
    if (sw.mode !== undefined) out.push(leaf(`interface-mode ${sw.mode}`, [...at, 'mode']))
    const members = (entries: readonly string[], field: Segments) => out.push(box('vlan', [entries.length === 1 ? leaf(`members ${quote(entries[0])}`, field) : leaf(`members [ ${entries.map(quote).join(' ')} ]`, field)]))
    if (sw.accessVlan !== undefined) {
      if (trunk) skip([...at, 'accessVlan'], 'unsupported', "a trunk's vlan members are its VLANs on Junos: an access VLAN has no place on one")
      else if (!isVlanId(sw.accessVlan)) skip([...at, 'accessVlan'], 'unsupported', 'not a VLAN ID')
      else members([memberName(String(sw.accessVlan))], [...at, 'accessVlan'])
    }
    if (sw.allowedVlans !== undefined) {
      if (!trunk) skip([...at, 'allowedVlans'], 'unsupported', "an access port's vlan members is its one VLAN on Junos: a trunk's VLANs have no place on one")
      else if (!sw.allowedVlans.length) skip([...at, 'allowedVlans'], 'not-applicable', 'no VLANs: nothing to write')
      else if (!sw.allowedVlans.every(isVlanEntry)) skip([...at, 'allowedVlans'], 'unsupported', 'not VLAN IDs or ranges of them')
      else members(sw.allowedVlans.map(memberName), [...at, 'allowedVlans'])
    }
    let native: Out | null = null
    if (sw.nativeVlan !== undefined) {
      if (!trunk) skip([...at, 'nativeVlan'], 'unsupported', 'Junos takes a native VLAN on a trunk only')
      else if (!isVlanId(sw.nativeVlan)) skip([...at, 'nativeVlan'], 'unsupported', 'not a VLAN ID')
      else native = leaf(`native-vlan-id ${sw.nativeVlan}`, [...at, 'nativeVlan'])
    }
    return { family: out.length ? box('family ethernet-switching', out) : leaf('family ethernet-switching', ...self(sw, at)), native }
  }

  function unitOf(index: string, sub: Subinterface, at: Segments, own: readonly Out[] = []): Out {
    const out: Out[] = []
    if (sub.description !== undefined) out.push(leaf(`description ${quote(sub.description)}`, [...at, 'description']))
    if (sub.enabled === false) out.push(leaf('disable', [...at, 'enabled']))
    else if (sub.enabled) skip([...at, 'enabled'], 'not-applicable', 'a Junos unit is enabled unless disabled')
    if (sub.vlanId !== undefined) out.push(leaf(`vlan-id ${sub.vlanId}`, [...at, 'vlanId']))
    if (sub.ipv4) out.push(familyOf(sub.ipv4, [...at, 'ipv4'], false))
    if (sub.ipv6) out.push(familyOf(sub.ipv6, [...at, 'ipv6'], true))
    out.push(...own)
    return out.length ? box(`unit ${index}`, out, ...self(sub, at)) : leaf(`unit ${index}`, ...self(sub, at))
  }

  function familyOf(family: AddressFamily, at: Segments, v6: boolean): Out {
    const out: Out[] = []
    emptyContainer(family.addresses, [...at, 'addresses'])
    if (family.mtu !== undefined) out.push(leaf(`mtu ${family.mtu}`, [...at, 'mtu']))
    for (const [address, a] of Object.entries(family.addresses ?? {})) {
      const f = [...at, 'addresses', address]
      const p = parsePrefix(`${address}/${a.prefixLength}`)
      if (!p || p.v6 !== v6) {
        skipAll(a, f, `not an ${v6 ? 'IPv6' : 'IPv4'} address and prefix length`)
        continue
      }
      if (a.primary === false) skip([...f, 'primary'], 'not-applicable', 'an address is primary only when marked')
      const text = `address ${address}/${a.prefixLength}`
      out.push(a.primary ? box(text, [leaf('primary', [...f, 'primary'])], [...f, 'prefixLength']) : leaf(text, [...f, 'prefixLength']))
    }
    const name = `family ${v6 ? 'inet6' : 'inet'}`
    return out.length ? box(name, out) : leaf(name, ...self(family, at))
  }

  // ---- SNMP

  const snmp = system?.snmp
  if (snmp) {
    const at = ['system', 'snmp']
    emptyContainer(snmp, at)
    emptyContainer(snmp.communities, [...at, 'communities'])
    const out: Out[] = []
    if (snmp.location !== undefined) out.push(leaf(`location ${quote(snmp.location)}`, [...at, 'location']))
    if (snmp.contact !== undefined) out.push(leaf(`contact ${quote(snmp.contact)}`, [...at, 'contact']))
    for (const [name, community] of Object.entries(snmp.communities ?? {})) {
      const c = [...at, 'communities', name]
      const inner: Out[] = []
      if (community.access !== undefined) inner.push(leaf(`authorization ${community.access}`, [...c, 'access']))
      if (community.clients !== undefined) {
        const bad = community.clients.find((client) => !parsePrefix(client) && !isIpv4(client) && !isIpv6(client))
        // Written without its clients, a community would answer every client: leave it out whole instead.
        if (!community.clients.length || bad !== undefined) {
          skipAll(community, c, community.clients.length ? 'a client that is not an address or prefix: left out rather than open to every client' : 'no clients allowed: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.snmp-community-clients', message: "An SNMP community's client list can't be written, so the community isn't written either." })
          continue
        }
        inner.push(box('clients', community.clients.map((client) => leaf(client)), [...c, 'clients']))
      }
      out.push(inner.length ? box(`community ${quote(name)}`, inner) : leaf(`community ${quote(name)}`, ...self(community, c)))
    }
    if (out.length) top.push(box('snmp', out))
  }

  // ---- static routes and routing instances

  // Each routing instance's units: `interface ge-0/0/0.0` in the instance, from the subinterfaces that name it.
  const instanceModel = model.networkInstances
  const members = new Map<string, Out[]>()
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) {
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      // A unit that isn't a number is left out whole (interfaceOf).
      if (sub.networkInstance === undefined || !INTEGER.test(index)) continue
      const field = ['interfaces', name, 'subinterfaces', index, 'networkInstance']
      const instance = sub.networkInstance
      if (instance === 'default') skip(field, 'not-applicable', 'the global routing table: a unit is in it unless in a routing instance')
      else if (!instanceModel || !Object.hasOwn(instanceModel, instance)) skip(field, 'unsupported', "names a routing instance the model doesn't have")
      else members.set(instance, [...(members.get(instance) ?? []), leaf(`interface ${quote(`${name}.${index}`)}`, field)])
    }
  }

  const instances: Out[] = []
  emptyContainer(model.networkInstances, ['networkInstances'])
  for (const [name, instance] of Object.entries(model.networkInstances ?? {})) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    const out: Out[] = []
    if (instance.type !== undefined) {
      if (isDefault && instance.type === 'default') skip([...at, 'type'], 'not-applicable', 'the global routing table')
      else if (!isDefault && (instance.type === 'vrf' || instance.type === 'virtual-router')) out.push(leaf(`instance-type ${instance.type}`, [...at, 'type']))
      else skip([...at, 'type'], 'unsupported', isDefault ? 'the global routing table is not a VRF' : 'not a Junos instance type')
    }
    if (!isDefault) out.push(...(members.get(name) ?? []))
    out.push(...vpnOf(name, instance, at, isDefault))
    const options = routingOptionsOf(instance, at, isDefault ? '' : `${name}.`)
    const protocols = protocolsOf(name, instance, at)
    if (isDefault) {
      if (options) top.push(options)
      if (protocols) top.push(protocols)
      if (!options && !protocols && isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, configured empty')
      continue
    }
    if (options) out.push(options)
    if (protocols) out.push(protocols)
    instances.push(out.length ? box(quote(name), out, ...self(instance, at)) : leaf(quote(name), ...self(instance, at)))
  }
  if (instances.length) top.push(box('routing-instances', instances))

  // ---- VLANs: each by its name, with its ID and the IRB unit that routes for it

  const routed = new Map<string, Out>()
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) {
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      if (sub.routedVlan === undefined || !INTEGER.test(index)) continue
      const field = ['interfaces', name, 'subinterfaces', index, 'routedVlan']
      const key = String(sub.routedVlan)
      if (name !== 'irb') skip(field, 'unsupported', 'Junos routes for a VLAN on a unit of irb: name the interface irb in the interface map')
      else if (!isVlanId(sub.routedVlan) || !vlanNames.has(key)) skip(field, 'unsupported', "names a VLAN the model doesn't have")
      else if (routed.has(key)) skip(field, 'unsupported', 'Junos gives a VLAN one l3-interface: another unit routes for it')
      else routed.set(key, leaf(`l3-interface irb.${index}`, field))
    }
  }

  const vlans: Out[] = []
  emptyContainer(model.vlans, ['vlans'])
  for (const [key, vlan] of Object.entries(model.vlans ?? {})) {
    const at = ['vlans', key]
    if (!vlanNames.has(key)) {
      skipAll(vlan, at, 'not keyed by a VLAN ID from 1 to 4094')
      continue
    }
    const name = vlanNames.get(key)!
    const fields: Segments[] = [...self(vlan, at)]
    if (vlan.name !== undefined) {
      if (vlan.name === name) fields.push([...at, 'name'])
      else skip([...at, 'name'], 'unsupported', vlan.name === '' ? 'an empty VLAN name: Junos names every VLAN' : 'another VLAN has the same name, which Junos keys VLANs by')
    }
    const out: Out[] = []
    if (vlan.description !== undefined) out.push(leaf(`description ${quote(vlan.description)}`, [...at, 'description']))
    out.push(leaf(`vlan-id ${Number(key)}`))
    if (routed.has(key)) out.push(routed.get(key)!)
    vlans.push(box(quote(name), out, ...fields))
  }
  if (vlans.length) top.push(box('vlans', vlans))

  /**
   * A VRF's route distinguisher and `vrf-target`. Junos takes one route target each way (`vrf-target`, or its `import`
   * and `export`): more need vrf-import and vrf-export policies, which come later. A VRF missing either is written
   * with the user's answer, or without it and a needs-input item.
   */
  function vpnOf(name: string, instance: NetworkInstance, at: Segments, isDefault: boolean): Out[] {
    const out: Out[] = []
    const rdField = [...at, 'routeDistinguisher']
    const rtField = (side: 'import' | 'export') => [...at, 'routeTargets', side]
    const notHere = isDefault ? 'the global routing table has no route distinguisher or route targets' : instance.type === 'virtual-router' ? 'a virtual router has no route distinguisher or route targets' : null
    if (notHere) {
      if (instance.routeDistinguisher !== undefined) skip(rdField, 'unsupported', notHere)
      for (const side of ['import', 'export'] as const) if (instance.routeTargets?.[side] !== undefined) skip(rtField(side), 'unsupported', notHere)
      return out
    }
    const isVrf = instance.type === 'vrf'

    let rd: string | null = null
    if (instance.routeDistinguisher !== undefined) {
      if (isRouteDistinguisher(instance.routeDistinguisher)) out.push(leaf(`route-distinguisher ${toJunos(instance.routeDistinguisher)}`, rdField))
      else skip(rdField, 'unsupported', 'not a route distinguisher in a form the model has')
    } else if (isVrf && (rd = answer(routeDistinguisherInputId(name), fromJunos)) !== null) out.push(leaf(`route-distinguisher ${toJunos(rd)}`))
    else if (isVrf) needsInput.push({ id: routeDistinguisherInputId(name), kind: 'other', message: 'This VRF needs a route distinguisher on Junos (ASN:nn or IP:nn), which the source doesn\'t give.', field: fieldPath(...at) })

    // Each side's one target, or null when it has none Junos can write here.
    const sides: Record<'import' | 'export', string | null> = { import: null, export: null }
    for (const side of ['import', 'export'] as const) {
      const list = instance.routeTargets?.[side]
      if (list === undefined) continue
      if (!list.length) skip(rtField(side), 'not-applicable', 'no route targets: nothing to write')
      else if (list.length > 1) skip(rtField(side), 'unsupported', 'more than one route target needs a vrf-import or vrf-export policy, which comes later')
      else if (!isRouteDistinguisher(list[0])) skip(rtField(side), 'unsupported', 'not a route target in a form the model has')
      else sides[side] = list[0]
    }
    // A side with no target Junos can write takes the user's answer, if any; while one is missing, it is asked for.
    if (isVrf && (sides.import === null || sides.export === null)) {
      const given = answer(routeTargetInputId(name), (value) => targetFromJunos(value) ?? fromJunos(value))
      if (given === null) needsInput.push({ id: routeTargetInputId(name), kind: 'other', message: "This VRF needs a route target on Junos (target:ASN:nn or target:IP:nn) for the routes it imports or exports, which the source doesn't give.", field: fieldPath(...at) })
      // Every side still without a target Junos can write takes it: left out, empty, malformed or more than one.
      else for (const side of ['import', 'export'] as const) if (sides[side] === null) sides[side] = given
    }
    const given = (side: 'import' | 'export'): Segments[] => (instance.routeTargets?.[side]?.length === 1 && isRouteDistinguisher(instance.routeTargets[side][0]) ? [rtField(side)] : [])
    if (sides.import !== null && sides.import === sides.export) out.push(leaf(`vrf-target target:${toJunos(sides.import)}`, ...given('import'), ...given('export')))
    else {
      const inner: Out[] = []
      for (const side of ['import', 'export'] as const) if (sides[side] !== null) inner.push(leaf(`${side} target:${toJunos(sides[side])}`, ...given(side)))
      if (inner.length) out.push(box('vrf-target', inner))
    }
    return out
  }

  function routingOptionsOf(instance: NetworkInstance, at: Segments, rib: string): Out | null {
    emptyContainer(instance.staticRoutes, [...at, 'staticRoutes'])
    const v4: Out[] = []
    const v6: Out[] = []
    for (const [prefix, route] of Object.entries(instance.staticRoutes ?? {})) {
      const r = [...at, 'staticRoutes', prefix]
      const p = parsePrefix(prefix)
      if (!p) {
        skipAll(route, r, 'not a destination prefix')
        continue
      }
      const out = routeOf(prefix, route, r, p.v6)
      if (out) (p.v6 ? v6 : v4).push(out)
    }
    const out: Out[] = [...routerOf(instance, at)]
    if (v4.length) out.push(box('static', v4))
    if (v6.length) out.push(box(`rib ${rib}inet6.0`, [box('static', v6)]))
    return out.length ? box('routing-options', out) : null
  }

  function routeOf(prefix: string, route: StaticRoute, at: Segments, v6: boolean): Out | null {
    if (route.description !== undefined) skip([...at, 'description'], 'unsupported', 'Junos static routes have no description')
    emptyContainer(route.nextHops, [...at, 'nextHops'])
    const hops = Object.entries(route.nextHops ?? {})
    if (!hops.length) {
      if (isEmpty(route)) skip(at, 'unsupported', 'a route with no next hop')
      return null
    }
    const isAddress = (s: string) => (v6 ? isIpv6(s) : isIpv4(s))
    const out: Out[] = []

    // Junos discards or rejects a route's traffic, or forwards it: with other next hops, a drop is left out.
    const drops = hops.filter(([, h]) => h.drop !== undefined)
    const written = hops.length > 1 ? hops.filter(([, h]) => h.drop === undefined) : hops
    if (hops.length > 1) {
      for (const [index, hop] of drops) skipAll(hop, [...at, 'nextHops', index], 'a Junos discard or reject route has no other next hop')
      if (drops.length) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.drop-with-next-hops', message: 'A static route with both a discard or reject and other next hops is written with its other next hops only.' })
    }

    // A setting every hop has, with the same value, is the route's; otherwise each hop that has it says it itself.
    const shared = new Set<string>()
    for (const setting of ROUTE_SETTINGS) {
      const values = written.map(([, h]) => h[setting])
      if (values.length && values[0] !== undefined && values.every((v) => v === values[0])) {
        shared.add(setting)
        out.push(leaf(`${setting} ${values[0]}`, ...written.map(([index]) => [...at, 'nextHops', index, setting])))
      }
    }

    for (const [index, hop] of written) {
      const h = [...at, 'nextHops', index]
      if (hop.drop !== undefined) {
        out.push(leaf(hop.drop, [...h, 'drop']))
        if (hop.address !== undefined) skip([...h, 'address'], 'unsupported', `a ${hop.drop} route has no next-hop address`)
        if (hop.interface !== undefined) skip([...h, 'interface'], 'unsupported', `a ${hop.drop} route has no interface`)
        continue
      }
      if ((hop.address !== undefined && !isAddress(hop.address)) || (hop.address === undefined && hop.interface === undefined)) {
        skipAll(hop, h, hop.address === undefined ? 'a next hop with no address, interface or discard' : "a next-hop address of another family than the route's")
        continue
      }
      out.push(hopOf(hop, h, shared))
    }
    return out.length ? box(`route ${prefix}`, out) : null
  }

  function hopOf(hop: NextHop, at: Segments, shared: ReadonlySet<string>): Out {
    const own = ROUTE_SETTINGS.filter((s) => hop[s] !== undefined && !shared.has(s))
    const target = hop.address ?? hop.interface!
    const targetField = [...at, hop.address !== undefined ? 'address' : 'interface']
    // A plain next hop when it has nothing of its own; a qualified next hop for its own settings or an interface beside its address.
    if (!own.length && (hop.address === undefined || hop.interface === undefined)) return leaf(`next-hop ${quote(target)}`, targetField)
    const inner: Out[] = []
    if (hop.address !== undefined && hop.interface !== undefined) inner.push(leaf(`interface ${quote(hop.interface)}`, [...at, 'interface']))
    for (const s of own) inner.push(leaf(`${s} ${hop[s]}`, [...at, s]))
    return box(`qualified-next-hop ${quote(target)}`, inner, targetField)
  }

  // ---- OSPF and BGP

  /**
   * An instance's `router-id` and `autonomous-system`: Junos has one router ID per routing instance, which its OSPF and
   * BGP share, and BGP's local AS is the instance's.
   */
  function routerOf(instance: NetworkInstance, at: Segments): Out[] {
    const out: Out[] = []
    const ids = (['ospf', 'bgp'] as const).filter((p) => instance[p]?.routerId !== undefined)
    const fields: Segments[] = []
    let written: string | undefined
    for (const p of ids) {
      const value = instance[p]!.routerId!
      const field = [...at, p, 'routerId']
      if (!isIpv4(value)) skip(field, 'unsupported', 'not a router ID (an IPv4 address)')
      else if (written === undefined || written === value) {
        written = value
        fields.push(field)
      } else skip(field, 'unsupported', "Junos has one router ID per routing instance, and OSPF's is another")
    }
    if (written !== undefined) out.push(leaf(`router-id ${written}`, ...fields))
    const as = instance.bgp?.localAs
    if (as !== undefined) {
      if (isAsNumber(as)) out.push(leaf(`autonomous-system ${as}`, [...at, 'bgp', 'localAs']))
      else skip([...at, 'bgp', 'localAs'], 'unsupported', 'not an AS number from 1 to 4294967295')
    }
    return out
  }

  /** A key the model flags but never carries: asked for, and written from the user's answer. */
  function keyOf(id: string, field: Segments, write: (key: string) => Out): Out | null {
    const given = context.inputs && Object.hasOwn(context.inputs, id) ? context.inputs[id] : undefined
    if (given !== undefined && given !== '') return write(given)
    needsInput.push({ id, kind: 'secret', message: "This needs its key on Junos, which isn't carried over from the source.", field: fieldPath(...field) })
    skip(field, 'unsupported', "the key isn't carried over: it is asked for")
    return null
  }

  function protocolsOf(name: string, instance: NetworkInstance, at: Segments): Out | null {
    const out: Out[] = []
    if (instance.ospf) out.push(ospfOf(name, instance.ospf, [...at, 'ospf']))
    if (instance.bgp) {
      out.push(bgpOf(name, instance.bgp, [...at, 'bgp']))
    }
    return out.length ? box('protocols', out) : null
  }

  function ospfOf(instance: string, ospf: Ospf, at: Segments): Out {
    emptyContainer(ospf.areas, [...at, 'areas'])
    if (ospf.processId !== undefined) skip([...at, 'processId'], 'not-applicable', 'Junos runs one OSPF per routing instance, with no process ID')
    const areas: Out[] = []
    let network = false
    for (const [id, area] of Object.entries(ospf.areas ?? {})) {
      const a = [...at, 'areas', id]
      if (!isIpv4(id)) {
        skipAll(area, a, 'not an OSPF area ID in dotted form')
        continue
      }
      const inner: Out[] = []
      if (area.type === 'stub' || area.type === 'nssa') inner.push(leaf(area.type, [...a, 'type']))
      else if (area.type === 'normal') skip([...a, 'type'], 'not-applicable', 'an area is normal unless stub or NSSA')
      if (area.authentication === 'simple' || area.authentication === 'md5') inner.push(leaf(`authentication-type ${area.authentication}`, [...a, 'authentication']))
      else if (area.authentication !== undefined) skip([...a, 'authentication'], 'unsupported', 'Junos gives an area simple or MD5 authentication; key chains come later')
      emptyContainer(area.interfaces, [...a, 'interfaces'])
      for (const [ref, ifc] of Object.entries(area.interfaces ?? {})) {
        const f = [...a, 'interfaces', ref]
        const lines: Out[] = []
        const own: Segments[] = [...self(ifc, f)]
        if (ifc.enabledBy === 'interface') own.push([...f, 'enabledBy'])
        else if (ifc.enabledBy === 'network') {
          skip([...f, 'enabledBy'], 'not-applicable', 'Junos enables OSPF per interface')
          network = true
        }
        if (ifc.passive === true) lines.push(leaf('passive', [...f, 'passive']))
        else if (ifc.passive === false) skip([...f, 'passive'], 'not-applicable', 'an OSPF interface is active unless passive')
        if (ifc.cost !== undefined) lines.push(leaf(`metric ${ifc.cost}`, [...f, 'cost']))
        if (ifc.networkType === 'point-to-point') lines.push(leaf('interface-type p2p', [...f, 'networkType']))
        else if (ifc.networkType === 'broadcast') skip([...f, 'networkType'], 'not-applicable', 'broadcast is Junos’s OSPF default on LAN interfaces, with no interface-type of its own')
        if (ifc.helloInterval !== undefined) lines.push(leaf(`hello-interval ${ifc.helloInterval}`, [...f, 'helloInterval']))
        if (ifc.deadInterval !== undefined) lines.push(leaf(`dead-interval ${ifc.deadInterval}`, [...f, 'deadInterval']))
        if (ifc.authentication === 'simple' || ifc.authentication === 'md5') {
          const kind = ifc.authentication
          const key = keyOf(ospfKeyInputId(instance, id, ref), [...f, 'authentication'], (k) => box('authentication', [leaf(kind === 'md5' ? `md5 1 key ${quote(k)}` : `simple-password ${quote(k)}`)], [...f, 'authentication']))
          if (key) lines.push(key)
        } else if (ifc.authentication !== undefined) skip([...f, 'authentication'], 'unsupported', 'OSPF key chains come later on Junos')
        inner.push(lines.length ? box(`interface ${quote(ref)}`, lines, ...own) : leaf(`interface ${quote(ref)}`, ...own))
      }
      areas.push(inner.length ? box(`area ${id}`, inner, ...self(area, a)) : leaf(`area ${id}`, ...self(area, a)))
    }
    // Semantic: a network statement takes in every interface in its range, later ones too; Junos names each interface.
    if (network) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.ospf-enabled-by-network', message: 'OSPF was enabled by network statements, which also take in interfaces added later in their ranges: Junos enables it on the interfaces named here only.' })
    // With no areas, `ospf;` still says OSPF runs here, so its router ID comes back with it.
    return areas.length ? box('ospf', areas, ...self(ospf, at)) : leaf('ospf', ...self(ospf, at))
  }

  function bgpOf(instance: string, bgp: Bgp, at: Segments): Out {
    emptyContainer(bgp.groups, [...at, 'groups'])
    emptyContainer(bgp.neighbors, [...at, 'neighbors'])
    const groups = new Map<string, { readonly name: string; readonly group?: BgpGroup; readonly at?: Segments; readonly neighbors: Out[] }>()
    for (const [name, group] of Object.entries(bgp.groups ?? {})) groups.set(name, { name, group, at: [...at, 'groups', name], neighbors: [] })
    let policies = false
    const peerOf = (peer: BgpPeer, p: Segments): Out[] => {
      const out: Out[] = []
      if (peer.description !== undefined) out.push(leaf(`description ${quote(peer.description)}`, [...p, 'description']))
      if (peer.localAddress !== undefined) {
        if (isIpv4(peer.localAddress) || isIpv6(peer.localAddress)) out.push(leaf(`local-address ${peer.localAddress}`, [...p, 'localAddress']))
        else skip([...p, 'localAddress'], 'unsupported', 'not an address')
      }
      if (peer.updateSource !== undefined) skip([...p, 'updateSource'], 'unsupported', 'Junos sources a BGP session from an address (local-address), not an interface')
      if (peer.multihop !== undefined) out.push(peer.multihop.ttl !== undefined ? box('multihop', [leaf(`ttl ${peer.multihop.ttl}`, [...p, 'multihop', 'ttl'])]) : leaf('multihop', ...self(peer.multihop, [...p, 'multihop'])))
      for (const [family, af] of Object.entries(peer.addressFamilies ?? {})) {
        const f = [...p, 'addressFamilies', family]
        if (family !== 'ipv4-unicast' && family !== 'ipv6-unicast') {
          skipAll(af, f, 'not an address family the model has')
          continue
        }
        for (const side of ['importPolicies', 'exportPolicies'] as const) if (af?.[side] !== undefined) skip([...f, side], 'unsupported', "Junos applies a peer's import and export policies to all its families: per family they come later")
        out.push(box(`family ${family === 'ipv4-unicast' ? 'inet' : 'inet6'}`, [leaf('unicast', ...self(af ?? {}, f))]))
      }
      for (const side of ['importPolicies', 'exportPolicies'] as const) {
        const list = peer[side]
        if (list === undefined) continue
        if (!list.length) {
          skip([...p, side], 'not-applicable', 'no policies: nothing to write')
          continue
        }
        policies = true
        const word = side === 'importPolicies' ? 'import' : 'export'
        out.push(leaf(list.length === 1 ? `${word} ${quote(list[0])}` : `${word} [ ${list.map(quote).join(' ')} ]`, [...p, side]))
      }
      if (peer.peerAs !== undefined) {
        if (isAsNumber(peer.peerAs)) out.push(leaf(`peer-as ${peer.peerAs}`, [...p, 'peerAs']))
        else skip([...p, 'peerAs'], 'unsupported', 'not an AS number from 1 to 4294967295')
      }
      if (peer.authentication === true) {
        const key = keyOf(bgpKeyInputId(instance, p[p.length - 2] === 'groups' ? 'group' : 'neighbor', p[p.length - 1]), [...p, 'authentication'], (k) => leaf(`authentication-key ${quote(k)}`, [...p, 'authentication']))
        if (key) out.push(key)
      } else if (peer.authentication === false) skip([...p, 'authentication'], 'not-applicable', 'no key')
      return out
    }

    // Each neighbor in its group: Junos has every neighbor in one. One the model gives without a group goes in `ibgp` or
    // `ebgp`, by whether its peer AS is the local AS.
    for (const [address, neighbor] of Object.entries(bgp.neighbors ?? {})) {
      const n = [...at, 'neighbors', address]
      if (!isIpv4(address) && !isIpv6(address)) {
        skipAll(neighbor, n, 'a BGP neighbor that is not an address')
        continue
      }
      const internal = neighbor.peerAs !== undefined && bgp.localAs !== undefined ? neighbor.peerAs === bgp.localAs : undefined
      const name = neighbor.group ?? (internal === undefined ? 'peers' : internal ? 'ibgp' : 'ebgp')
      if (!groups.has(name)) groups.set(name, { name, neighbors: [] })
      const group = groups.get(name)!
      const fields: Segments[] = [...self(neighbor, n)]
      if (neighbor.group !== undefined) fields.push([...n, 'group'])
      const inner = peerOf(neighbor, n)
      group.neighbors.push(inner.length ? box(`neighbor ${address}`, inner, ...fields) : leaf(`neighbor ${address}`, ...fields))
    }

    const out: Out[] = []
    for (const { name, group, at: g, neighbors } of groups.values()) {
      const inner: Out[] = []
      // Without a type, Junos tells internal from external by the peer AS, as the model's other platforms do.
      if (group?.type === 'internal' || group?.type === 'external') inner.push(leaf(`type ${group.type}`, [...g!, 'type']))
      else if (group?.type !== undefined) skip([...g!, 'type'], 'unsupported', 'not a BGP group type')
      if (group && g) inner.push(...peerOf(group, g))
      inner.push(...neighbors)
      out.push(inner.length ? box(`group ${quote(name)}`, inner, ...(group && g ? self(group, g) : [])) : leaf(`group ${quote(name)}`, ...(group && g ? self(group, g) : [])))
    }
    if (policies) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.policy-by-name', message: "BGP import and export policies are written by name only: their bodies (policy-options) aren't converted yet, and Junos commits a reference only to a policy it has." })
    // With no groups, `bgp;` still says BGP runs here, so its AS number and router ID come back with it.
    return out.length ? box('bgp', out) : leaf('bgp', ...self(bgp, at))
  }

  // ---- write it out

  const lines: string[] = []
  const write = (nodes: readonly Out[], depth: number) => {
    const indent = '    '.repeat(depth)
    for (const n of nodes) {
      const line = n.children && n.children.length ? `${indent}${n.text} {` : `${indent}${n.text};`
      lines.push(line)
      const at = lines.length
      for (const f of n.fields) dispositions[fieldPath(...f)] = { kind: 'rendered', span: { startLine: at, startColumn: indent.length + 1, endLine: at, endColumn: line.length + 1 } }
      if (n.children && n.children.length) {
        write(n.children, depth + 1)
        lines.push(`${indent}}`)
      }
    }
  }
  write(top, 0)
  return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }
}
