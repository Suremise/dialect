// The shared model → IOS / IOS-XE text, for the phase 1 areas and model 0.4's VLANs, switch ports, VLAN interfaces,
// OSPF and BGP. Every populated leaf of those areas gets a disposition: `rendered` with the line it went to,
// `unsupported` with why (IOS can't say it, or this renderer can't yet), or `not-applicable` (IOS implies it). Fields of
// a later model version are left without one, so the ledger reports them as unrendered rather than this renderer
// claiming them. VLANs come first, then VRFs; VRFs are defined (`vrf definition`) before the interfaces in them, and an
// interface's `vrf forwarding` comes before its addresses, which it would otherwise clear. Routing protocols follow the
// interfaces, whose blocks carry their own OSPF lines. Secrets (OSPF keys, BGP passwords) are never in the model: each
// is a needs-input item, written only once answered.
import { fieldPath, isAsNumber, isRouteDistinguisher, isVlanId, populatedLeaves, type AddressFamily, type Bgp, type BgpAddressFamilyName, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NeedsInput, type NetworkInstance, type RenderResult, type BgpPeer, type RouteTargets, type StaticRoute, type Subinterface } from '@dialect/core'
import { isIpv4, lengthMask } from './addresses'
import { SEVERITIES } from './parse'

type Segments = readonly (string | number)[]

const IOS_SEVERITY: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SEVERITIES).map(([ios, model]) => [model, ios]))

/**
 * An interface reference as IOS writes it. The model's references are `name` or `name.<subinterface>`, and IOS has no
 * subinterface 0: its addresses are the main interface's (a Junos `ge-0/0/0.0` renamed to `Gi0/0/0.0`), so `.0` is the
 * main interface.
 */
const ref = (name: string) => name.replace(/\.0$/, '')

/** An entry of a trunk's allowed VLANs: an ID (`10`) or a range (`20-30`, first below last), from 1 to 4094. */
const isVlanRange = (entry: string) => {
  const m = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(entry)
  return m !== null && isVlanId(Number(m[1])) && (m[2] === undefined || (isVlanId(Number(m[2])) && Number(m[1]) < Number(m[2])))
}

/** The needs-input id for an OSPF interface's key (or key chain's name), which no source carries. */
export const ospfKeyInputId = (instance: string, reference: string) => `ospf-key:${instance}:${reference}`
/** The needs-input id for a BGP peer's password, which no source carries. */
export const bgpPasswordInputId = (instance: string, kind: 'groups' | 'neighbors', key: string) => `bgp-password:${instance}:${kind}:${key}`

/** A word IOS reads back as one: quoted when it has a space in it. */
const word = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

export function render(model: Device, context: Context): RenderResult {
  const lines: string[] = []
  const dispositions: Record<string, FieldDisposition> = {}
  const diagnostics: Diagnostic[] = []

  /** Writes a line, marking the fields it says as rendered there. */
  const emit = (line: string, ...fields: Segments[]) => {
    lines.push(line)
    const n = lines.length
    for (const f of fields) dispositions[fieldPath(...f)] = { kind: 'rendered', span: { startLine: n, startColumn: 1, endLine: n, endColumn: line.length + 1 } }
  }
  const separator = () => {
    if (lines.length && lines[lines.length - 1] !== '!') lines.push('!')
  }
  const skip = (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => {
    dispositions[fieldPath(...field)] = { kind, reason }
  }
  /** Every populated leaf under `at` (of `value`), as unsupported: a part the renderer can't write at all. */
  const skipAll = (value: unknown, at: Segments, reason: string) => {
    for (const leaf of populatedLeaves(value, [...at])) dispositions[leaf.path] = { kind: 'unsupported', reason }
  }
  /** An object configured with nothing in it is a leaf of its own (`{}`): mark it with what became of it. */
  const isEmpty = (value: object | undefined) => value !== undefined && populatedLeaves(value, ['x']).every((l) => l.path === 'x')
  const emptyContainer = (value: object | undefined, at: Segments) => {
    if (value !== undefined && isEmpty(value)) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }

  const system = model.system
  if (system) {
    emptyContainer(system, ['system'])
    if (system.hostname !== undefined) emit(`hostname ${system.hostname}`, ['system', 'hostname'])
    if (system.domainName !== undefined) emit(`ip domain name ${system.domainName}`, ['system', 'domainName'])
    const dns = system.dns
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        // A leaf-list is one field: marked on its first line.
        dns.search.forEach((domain, i) => emit(`ip domain list ${domain}`, ...(i === 0 ? [['system', 'dns', 'search']] : [])))
      }
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = 'ip name-server'
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        emit(`${line} ${address}`, ...fields)
      }
    }
  }

  // ---- VLANs: before the switch ports and VLAN interfaces that use them

  emptyContainer(model.vlans, ['vlans'])
  for (const [id, vlan] of Object.entries(model.vlans ?? {})) {
    const at = ['vlans', id]
    if (!isVlanId(Number(id)) || String(Number(id)) !== id) {
      skipAll(vlan, at, 'not a VLAN ID from 1 to 4094')
      continue
    }
    if (id === '1') {
      // IOS always has VLAN 1, the default, and can't rename it.
      if (isEmpty(vlan)) skip(at, 'not-applicable', 'IOS always has VLAN 1')
      else skipAll(vlan, at, 'IOS can\'t rename VLAN 1 or describe it')
      continue
    }
    separator()
    emit(`vlan ${id}`, ...(isEmpty(vlan) ? [at] : []))
    if (vlan.name !== undefined) {
      if (/^\S+$/.test(vlan.name)) emit(` name ${vlan.name}`, [...at, 'name'])
      else skip([...at, 'name'], 'unsupported', 'IOS VLAN names are one word')
    }
    if (vlan.description !== undefined) skip([...at, 'description'], 'unsupported', 'IOS VLANs have a name but no description')
  }

  // ---- VRF definitions: before the interfaces in them

  const instances = Object.entries(model.networkInstances ?? {})
  for (const [name, instance] of instances) if (name !== 'default') renderDefinition(name, instance)

  /** The address families a VRF needs: those of its interfaces' addresses and its routes, and IPv4 for a VPN. */
  function familiesOf(name: string, instance: NetworkInstance): ('ipv4' | 'ipv6')[] {
    const subs = Object.values(model.interfaces ?? {}).flatMap((i) => Object.values(i.subinterfaces ?? {})).filter((s) => s.networkInstance === name)
    const prefixes = Object.keys(instance.staticRoutes ?? {})
    const v4 = subs.some((s) => s.ipv4 !== undefined) || prefixes.some((p) => !p.includes(':')) || instance.routeDistinguisher !== undefined || instance.routeTargets !== undefined
    const v6 = subs.some((s) => s.ipv6 !== undefined) || prefixes.some((p) => p.includes(':'))
    return [...(v4 ? ['ipv4' as const] : []), ...(v6 ? ['ipv6' as const] : [])]
  }

  function renderDefinition(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    separator()
    const fields: Segments[] = isEmpty(instance) ? [at] : []
    if (instance.type === 'vrf') fields.push([...at, 'type'])
    else if (instance.type !== undefined) skip([...at, 'type'], 'unsupported', 'IOS\'s global table is unnamed, and every other instance is a VRF')
    emit(`vrf definition ${name}`, ...fields)
    if (instance.routeDistinguisher !== undefined) {
      if (isRouteDistinguisher(instance.routeDistinguisher)) emit(` rd ${instance.routeDistinguisher}`, [...at, 'routeDistinguisher'])
      else skip([...at, 'routeDistinguisher'], 'unsupported', 'not a route distinguisher in the form ASN:nn, IP:nn or ASN4:nn')
    }
    if (instance.routeTargets !== undefined) renderRouteTargets(instance.routeTargets, [...at, 'routeTargets'])
    for (const family of familiesOf(name, instance)) {
      emit(' !')
      emit(` address-family ${family}`)
      emit(' exit-address-family')
    }
  }

  /** A VRF's route targets, VRF-wide (the model's are the VRF's, for every family). Each list is one field, on its first line. */
  function renderRouteTargets(targets: RouteTargets, at: Segments) {
    emptyContainer(targets, at)
    for (const direction of ['import', 'export'] as const) {
      const values = targets[direction]
      if (values === undefined) continue
      if (!values.length) skip([...at, direction], 'not-applicable', 'an empty list: nothing to write')
      else if (!values.every(isRouteDistinguisher)) skip([...at, direction], 'unsupported', 'a route target not in the form ASN:nn, IP:nn or ASN4:nn')
      else values.forEach((v, i) => emit(` route-target ${direction} ${v}`, ...(i === 0 ? [[...at, direction]] : [])))
    }
  }

  // ---- OSPF, planned before the interfaces: its interface lines go in their blocks, the rest in `router ospf`

  /** A line still to write, with the fields it renders, and in `router ospf` its group (as IOS orders them). */
  type Line = { readonly text: string; readonly fields: Segments[]; readonly group?: number }
  /** OSPF's lines for each interface block, by `name|subinterface`. */
  const ospfLines = new Map<string, Line[]>()
  /** Each instance's `router ospf` block: its process number and lines. */
  const ospfBlocks: { readonly instance: string; readonly process: string; readonly lines: Line[]; readonly at: Segments }[] = []
  const needsInput: NeedsInput[] = []
  const inputs = context.inputs ?? {}
  const answer = (id: string) => (Object.hasOwn(inputs, id) && inputs[id].trim() !== '' ? inputs[id].trim() : undefined)
  planOspf()

  /** An interface reference (`Gi1`, `Gi1.10`, `Gi1.0`) as the model's interface and subinterface, when it has them. */
  function resolve(reference: string): { name: string; sub: string; subinterface: Subinterface | undefined } | undefined {
    const interfaces = model.interfaces ?? {}
    if (Object.hasOwn(interfaces, reference)) return { name: reference, sub: '0', subinterface: interfaces[reference].subinterfaces?.['0'] }
    const m = /^(.+)\.(\d+)$/.exec(reference)
    if (!m || !Object.hasOwn(interfaces, m[1])) return undefined
    const subs = interfaces[m[1]].subinterfaces
    if (m[2] !== '0' && !(subs && Object.hasOwn(subs, m[2]))) return undefined
    return { name: m[1], sub: m[2], subinterface: subs?.[m[2]] }
  }

  /** An address's primary IPv4 address, as renderFamily writes it: the one marked primary, or the first. */
  function primaryOf(sub: Subinterface | undefined) {
    const addresses = Object.entries(sub?.ipv4?.addresses ?? {})
    return (addresses.find(([, a]) => a.primary) ?? addresses[0])?.[0]
  }

  function planOspf() {
    // The global table's process first, as IOS shows them.
    const withOspf = Object.entries(model.networkInstances ?? {}).filter(([, ni]) => ni.ospf !== undefined).sort(([a], [b]) => Number(b === 'default') - Number(a === 'default'))
    // IOS numbers its processes, one a VRF here: the model's number where it is one and free, else the lowest free one.
    const given = new Set(withOspf.map(([, ni]) => ni.ospf!.processId).filter((p) => p !== undefined && /^[1-9]\d*$/.test(p) && Number(p) <= 65535))
    const used = new Set<string>()
    let next = 1
    for (const [instance, ni] of withOspf) {
      const ospf = ni.ospf!
      const at = ['networkInstances', instance, 'ospf']
      emptyContainer(ospf, at)
      let process = ospf.processId
      if (process === undefined || !given.has(process) || used.has(process)) {
        while (given.has(String(next)) || used.has(String(next))) next++
        if (ospf.processId !== undefined) skip([...at, 'processId'], 'unsupported', 'not an IOS process number from 1 to 65535 of its own: another is used')
        process = String(next)
      }
      used.add(process)
      const block: Line[] = []
      ospfBlocks.push({ instance, process, lines: block, at })
      if (ospf.routerId !== undefined) {
        if (isIpv4(ospf.routerId)) block.push({ text: ` router-id ${ospf.routerId}`, fields: [[...at, 'routerId']] })
        else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
      }
      let networkEnabled = false
      emptyContainer(ospf.areas, [...at, 'areas'])
      for (const [area, a] of Object.entries(ospf.areas ?? {})) {
        const areaAt = [...at, 'areas', area]
        if (!isIpv4(area)) {
          skipAll(a, areaAt, 'not an OSPF area in dotted form')
          continue
        }
        // As IOS shows it: `area 0`, `area 10`.
        const id = String(area.split('.').reduce((n, o) => n * 256 + Number(o), 0))
        emptyContainer(a, areaAt)
        emptyContainer(a.interfaces, [...areaAt, 'interfaces'])
        if (a.type === 'stub' || a.type === 'nssa') block.push({ text: ` area ${id} ${a.type}`, fields: [[...areaAt, 'type']], group: 1 })
        else if (a.type !== undefined) skip([...areaAt, 'type'], 'not-applicable', 'a normal area, IOS\'s default')
        if (a.authentication === 'simple' || a.authentication === 'md5') block.push({ text: ` area ${id} authentication${a.authentication === 'md5' ? ' message-digest' : ''}`, fields: [[...areaAt, 'authentication']], group: 1 })
        else if (a.authentication !== undefined) skip([...areaAt, 'authentication'], 'unsupported', 'IOS uses a key chain per interface, not per area')
        for (const [reference, i] of Object.entries(a.interfaces ?? {})) {
          const iAt = [...areaAt, 'interfaces', reference]
          const target = resolve(reference)
          if (!target) {
            skipAll(i, iAt, 'names an interface the model doesn\'t have')
            continue
          }
          const ifLines = ospfLines.get(`${target.name}|${target.sub}`) ?? []
          ospfLines.set(`${target.name}|${target.sub}`, ifLines)
          const written = target.sub === '0' ? target.name : `${target.name}.${target.sub}`
          const entry: Segments[] = isEmpty(i) ? [iAt] : []
          const primary = primaryOf(target.subinterface)
          if (i.enabledBy === 'network' && primary !== undefined) {
            // The source's range isn't in the model: an exact network statement takes in this interface alone.
            networkEnabled = true
            block.push({ text: ` network ${primary} 0.0.0.0 area ${id}`, fields: [[...iAt, 'enabledBy']], group: 2 })
          } else {
            if (i.enabledBy === 'network') skip([...iAt, 'enabledBy'], 'unsupported', 'enabled by a network statement, which needs an IPv4 address: written on the interface instead')
            ifLines.push({ text: ` ip ospf ${process} area ${id}`, fields: [...entry, ...(i.enabledBy === 'interface' ? [[...iAt, 'enabledBy']] : [])] })
          }
          if (i.passive === true) block.push({ text: ` passive-interface ${written}`, fields: [[...iAt, 'passive']], group: 3 })
          else if (i.passive === false) skip([...iAt, 'passive'], 'not-applicable', 'active, as IOS has an interface unless passive')
          const number = (leaf: 'cost' | 'helloInterval' | 'deadInterval', keyword: string) => {
            const value = i[leaf]
            if (value === undefined) return
            if (Number.isInteger(value) && value >= 1 && value <= 65535) ifLines.push({ text: ` ip ospf ${keyword} ${value}`, fields: [[...iAt, leaf]] })
            else skip([...iAt, leaf], 'unsupported', 'not a value from 1 to 65535')
          }
          number('cost', 'cost')
          if (i.networkType !== undefined) ifLines.push({ text: ` ip ospf network ${i.networkType}`, fields: [[...iAt, 'networkType']] })
          number('helloInterval', 'hello-interval')
          number('deadInterval', 'dead-interval')
          // A key is never carried: the user gives it (a needs-input item), and it is written only then.
          const authentication = i.authentication ?? (a.authentication === 'simple' || a.authentication === 'md5' ? a.authentication : undefined)
          if (i.authentication !== undefined) {
            const chain = i.authentication === 'key-chain' ? answer(ospfKeyInputId(instance, reference)) : undefined
            if (i.authentication !== 'key-chain' || chain !== undefined) ifLines.push({ text: ` ip ospf authentication${i.authentication === 'md5' ? ' message-digest' : i.authentication === 'key-chain' ? ` key-chain ${chain}` : ''}`, fields: [[...iAt, 'authentication']] })
            else skip([...iAt, 'authentication'], 'unsupported', 'needs the name of its key chain, which the source never carries: a needs-input item asks for it')
          }
          if (authentication !== undefined) {
            const inputId = ospfKeyInputId(instance, reference)
            const key = answer(inputId)
            if (key === undefined) needsInput.push({ id: inputId, kind: authentication === 'key-chain' ? 'other' : 'secret', message: authentication === 'key-chain' ? 'This OSPF interface authenticates with a key chain: give the name of the key chain to use.' : 'This OSPF interface authenticates: give its key, which the source never carries.', field: fieldPath(...iAt) })
            else if (authentication === 'simple') ifLines.push({ text: ` ip ospf authentication-key ${key}`, fields: [] })
            else if (authentication === 'md5') ifLines.push({ text: ` ip ospf message-digest-key 1 md5 ${key}`, fields: [] })
          }
        }
      }
      if (networkEnabled) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.ospf-network-exact', message: 'OSPF was enabled by network statements: each interface is written with an exact one (wildcard 0.0.0.0), so interfaces added later in the source\'s range aren\'t taken in.', field: fieldPath(...at) })
    }
  }

  /** Writes an interface block's OSPF lines. */
  const emitOspf = (name: string, sub: string) => {
    for (const l of ospfLines.get(`${name}|${sub}`) ?? []) emit(l.text, ...l.fields)
    ospfLines.delete(`${name}|${sub}`)
  }

  // ---- interfaces

  for (const [name, iface] of Object.entries(model.interfaces ?? {})) renderInterface(name, iface)
  emptyContainer(model.interfaces, ['interfaces'])
  // An OSPF interface whose block wasn't written (none should be): its fields say so.
  for (const left of ospfLines.values()) for (const l of left) for (const f of l.fields) skip(f, 'unsupported', 'on an interface IOS doesn\'t write')

  // ---- routing protocols, after the interfaces they name

  for (const block of ospfBlocks) {
    separator()
    const ospf = model.networkInstances![block.instance].ospf!
    emit(`router ospf ${block.process}${block.instance === 'default' ? '' : ` vrf ${block.instance}`}`, ...(ospf.processId === block.process ? [[...block.at, 'processId']] : []))
    // router-id, then the areas, the network statements and the passive interfaces (a stable sort keeps each in order).
    for (const l of [...block.lines].sort((a, b) => (a.group ?? 0) - (b.group ?? 0))) emit(l.text, ...l.fields)
  }
  renderBgp()

  function renderInterface(name: string, iface: Interface) {
    const at = ['interfaces', name]
    const subs = Object.entries(iface.subinterfaces ?? {})
    const main = iface.subinterfaces?.['0']
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', 'IOS gives an interface\'s type by its name')
    if (iface.vlanTagging !== undefined) skip([...at, 'vlanTagging'], 'not-applicable', 'IOS tags each subinterface (encapsulation dot1Q)')
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])

    // A VLAN interface says the VLAN it routes for by its name: `interface Vlan10` routes for VLAN 10.
    const routed = main?.routedVlan
    const routedField = [...at, 'subinterfaces', '0', 'routedVlan']
    const named = routed !== undefined && iface.type === 'irb-or-svi' && isVlanId(routed) && new RegExp(`^(?:Vlan|Vl)0*${routed}$`, 'i').test(name)
    if (routed !== undefined && !named) skip(routedField, 'unsupported', 'IOS routes a VLAN on the interface named for it (VlanN for VLAN N), and this one isn\'t')

    const hasOwn = iface.description !== undefined || iface.enabled !== undefined || iface.mtu !== undefined || iface.switching !== undefined || main !== undefined || ospfLines.has(`${name}|0`)
    if (hasOwn || !subs.some(([index]) => index !== '0')) {
      separator()
      emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []), ...(named ? [routedField] : []))
      if (iface.description !== undefined) emit(` description ${iface.description}`, [...at, 'description'])
      if (iface.mtu !== undefined) emit(` mtu ${iface.mtu}`, [...at, 'mtu'])
      if (iface.switching !== undefined) renderSwitching(iface, at)
      if (main) {
        const sub = [...at, 'subinterfaces', '0']
        if (isEmpty(main)) skip(sub, 'not-applicable', 'IOS has no unit 0 of its own: the main interface is it')
        if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'IOS has one description for the main interface')
        if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'IOS has one shutdown for the main interface')
        if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'IOS has no subinterface 0 to tag')
        if (renderMembership(main, sub)) renderAddresses(main, sub)
      }
      emitOspf(name, '0')
      if (iface.enabled !== undefined) emit(iface.enabled ? ' no shutdown' : ' shutdown', [...at, 'enabled'])
    }

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      separator()
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.routedVlan !== undefined) skip([...subAt, 'routedVlan'], 'unsupported', 'IOS routes a VLAN on its own Vlan interface, not on a subinterface')
      if (sub.description !== undefined) emit(` description ${sub.description}`, [...subAt, 'description'])
      if (sub.vlanId !== undefined) emit(` encapsulation dot1Q ${sub.vlanId}`, [...subAt, 'vlanId'])
      if (renderMembership(sub, subAt)) renderAddresses(sub, subAt)
      emitOspf(name, index)
      if (sub.enabled !== undefined) emit(sub.enabled ? ' no shutdown' : ' shutdown', [...subAt, 'enabled'])
    }
  }

  /** A switch port, in the order `show running-config` gives it: the VLANs, then the mode. */
  function renderSwitching(iface: Interface, at: Segments) {
    const s = iface.switching!
    const sw = [...at, 'switching']
    if (iface.type === 'irb-or-svi') {
      skipAll(s, sw, 'a VLAN interface routes: IOS can\'t make it a switch port')
      return
    }
    emit(' switchport', ...(isEmpty(s) ? [sw] : []))
    const vlan = (value: number | undefined, leaf: string, line: string) => {
      if (value === undefined) return
      if (isVlanId(value)) emit(`${line} ${value}`, [...sw, leaf])
      else skip([...sw, leaf], 'unsupported', 'not a VLAN ID from 1 to 4094')
    }
    vlan(s.accessVlan, 'accessVlan', ' switchport access vlan')
    vlan(s.nativeVlan, 'nativeVlan', ' switchport trunk native vlan')
    if (s.allowedVlans !== undefined) {
      if (s.allowedVlans.every(isVlanRange)) emit(` switchport trunk allowed vlan ${s.allowedVlans.length ? s.allowedVlans.join(',') : 'none'}`, [...sw, 'allowedVlans'])
      else skip([...sw, 'allowedVlans'], 'unsupported', 'not a list of VLAN IDs and ranges from 1 to 4094')
    }
    if (s.mode !== undefined) {
      if (s.mode === 'access' || s.mode === 'trunk') emit(` switchport mode ${s.mode}`, [...sw, 'mode'])
      else skip([...sw, 'mode'], 'unsupported', 'not a switch port mode IOS has')
    }
  }

  /**
   * `vrf forwarding V`, before the addresses (on IOS it clears those before it). Whether the addresses can follow: in a
   * VRF the model doesn't have, they would land in another table, so they are left out with it.
   */
  function renderMembership(sub: Subinterface, at: Segments): boolean {
    const vrf = sub.networkInstance
    if (vrf === undefined) return true
    const field = [...at, 'networkInstance']
    if (vrf === 'default') {
      skip(field, 'not-applicable', 'the global routing table, which interfaces are in unless they say otherwise')
      return true
    }
    if (model.networkInstances && Object.hasOwn(model.networkInstances, vrf)) {
      emit(` vrf forwarding ${vrf}`, field)
      return true
    }
    const reason = 'a VRF the model doesn\'t have'
    skip(field, 'unsupported', reason)
    for (const family of ['ipv4', 'ipv6'] as const) if (sub[family] !== undefined) skipAll(sub[family], [...at, family], `in a VRF IOS can't put the interface in (${reason}): left out rather than put in another table`)
    return false
  }

  function renderAddresses(sub: Subinterface, at: Segments) {
    renderFamily(sub.ipv4, [...at, 'ipv4'], 4)
    renderFamily(sub.ipv6, [...at, 'ipv6'], 6)
  }

  function renderFamily(family: AddressFamily | undefined, at: Segments, version: 4 | 6) {
    if (!family) return
    emptyContainer(family, at)
    emptyContainer(family.addresses, [...at, 'addresses'])
    const addresses = Object.entries(family.addresses ?? {})
    if (version === 6) {
      for (const [address, a] of addresses) {
        emit(` ipv6 address ${address}/${a.prefixLength}`, [...at, 'addresses', address, 'prefixLength'])
        if (a.primary !== undefined) skip([...at, 'addresses', address, 'primary'], 'not-applicable', 'IPv6 addresses have no primary on IOS')
      }
      if (family.mtu !== undefined) emit(` ipv6 mtu ${family.mtu}`, [...at, 'mtu'])
      return
    }
    // IOS has one primary address; the others are secondary. Without a primary in the model, the first is made it.
    const primaries = addresses.filter(([, a]) => a.primary)
    const primary = primaries[0]?.[0] ?? addresses[0]?.[0]
    if (addresses.length > 1 && !primaries.length) {
      // Value-free (AGENTS.md): an address can share its value with a secret, such as a community. The field says where.
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.primary-chosen', message: 'No primary address given: the first is written as the primary, the others as secondary.', field: fieldPath(...at, 'addresses') })
    }
    const ordered = addresses.filter(([a]) => a === primary).concat(addresses.filter(([a]) => a !== primary))
    for (const [address, a] of ordered) {
      const f = [...at, 'addresses', address]
      if (!Number.isInteger(a.prefixLength) || a.prefixLength < 0 || a.prefixLength > 32) {
        skipAll(a, f, 'not an IPv4 prefix length')
        continue
      }
      const isPrimary = address === primary
      const fields: Segments[] = [[...f, 'prefixLength']]
      if (a.primary !== undefined) {
        if (a.primary === isPrimary) fields.push([...f, 'primary'])
        else skip([...f, 'primary'], 'unsupported', 'IOS has one primary address')
      }
      emit(` ip address ${address} ${lengthMask(a.prefixLength)}${isPrimary ? '' : ' secondary'}`, ...fields)
    }
    if (family.mtu !== undefined) emit(` ip mtu ${family.mtu}`, [...at, 'mtu'])
  }

  // ---- static routes

  separator()
  for (const [name, instance] of instances) renderInstance(name, instance)
  emptyContainer(model.networkInstances, ['networkInstances'])

  /** The global table's settings and every instance's static routes (`ip route vrf V …`, after its definition). */
  function renderInstance(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    if (isDefault) {
      if (instance.type !== undefined) skip([...at, 'type'], 'not-applicable', 'the global routing table')
      if (isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, with nothing in it')
      if (instance.routeDistinguisher !== undefined) skip([...at, 'routeDistinguisher'], 'unsupported', 'the global routing table has no route distinguisher')
      if (instance.routeTargets !== undefined) skipAll(instance.routeTargets, [...at, 'routeTargets'], 'the global routing table has no route targets')
    }
    emptyContainer(instance.staticRoutes, [...at, 'staticRoutes'])
    for (const [prefix, route] of Object.entries(instance.staticRoutes ?? {})) renderRoute(isDefault ? '' : `vrf ${name} `, prefix, route, [...at, 'staticRoutes', prefix])
  }

  function renderRoute(vrf: string, prefix: string, route: StaticRoute, at: Segments) {
    const v6 = prefix.includes(':')
    const m = /^(.+)\/(\d+)$/.exec(prefix)
    if (!m || (!v6 && Number(m[2]) > 32)) {
      skipAll(route, at, 'not a prefix')
      return
    }
    const destination = v6 ? prefix : `${m[1]} ${lengthMask(Number(m[2]))}`
    const hops = Object.entries(route.nextHops ?? {})
    emptyContainer(route.nextHops, [...at, 'nextHops'])
    if (isEmpty(route)) skip(at, 'unsupported', 'a route with no next hop')
    let described = false
    for (const [index, hop] of hops) {
      const h = [...at, 'nextHops', index]
      const parts: string[] = []
      const fields: Segments[] = []
      if (hop.drop === 'discard') {
        parts.push('Null0')
        fields.push([...h, 'drop'])
        if (hop.interface !== undefined) skip([...h, 'interface'], 'unsupported', 'a discard route has no interface')
        if (hop.address !== undefined) skip([...h, 'address'], 'unsupported', 'a discard route has no next-hop address')
      } else {
        if (hop.drop !== undefined) skip([...h, 'drop'], 'unsupported', 'IOS has no reject route: Null0 discards')
        if (hop.interface !== undefined) {
          parts.push(ref(hop.interface))
          fields.push([...h, 'interface'])
        }
        if (hop.address !== undefined) {
          parts.push(hop.address)
          fields.push([...h, 'address'])
        }
      }
      if (!parts.length) {
        // A reject route says why above; its other leaves (a metric, a preference) go with it.
        skipAll(hop, h, hop.drop === 'reject' ? 'IOS has no reject route: Null0 discards' : 'a next hop with no address, interface or discard')
        continue
      }
      if (hop.preference !== undefined) {
        parts.push(String(hop.preference))
        fields.push([...h, 'preference'])
      }
      if (hop.tag !== undefined) {
        parts.push(`tag ${hop.tag}`)
        fields.push([...h, 'tag'])
      }
      if (hop.metric !== undefined) skip([...h, 'metric'], 'unsupported', 'IOS static routes have no metric')
      if (route.description !== undefined) {
        parts.push(`name ${word(route.description)}`)
        if (!described) fields.push([...at, 'description'])
        described = true
      }
      emit(`${v6 ? 'ipv6' : 'ip'} route ${vrf}${destination} ${parts.join(' ')}`, ...fields)
    }
    if (route.description !== undefined && !described) skip([...at, 'description'], 'unsupported', 'a route name needs a next hop to go on')
  }

  // ---- NTP, logging, SNMP

  if (system) {
    const ntp = system.ntp
    if (ntp) {
      separator()
      emptyContainer(ntp, ['system', 'ntp'])
      emptyContainer(ntp.servers, ['system', 'ntp', 'servers'])
      if (ntp.sourceInterface !== undefined) emit(`ntp source ${ref(ntp.sourceInterface)}`, ['system', 'ntp', 'sourceInterface'])
      for (const [address, server] of Object.entries(ntp.servers ?? {})) {
        const at = ['system', 'ntp', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = 'ntp server'
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        line += ` ${address}`
        if (server.version !== undefined) {
          line += ` version ${server.version}`
          fields.push([...at, 'version'])
        }
        if (server.prefer !== undefined) {
          if (server.prefer) line += ' prefer'
          fields.push([...at, 'prefer'])
        }
        emit(line, ...fields)
      }
    }

    const logging = system.logging
    if (logging) {
      separator()
      emptyContainer(logging, ['system', 'logging'])
      emptyContainer(logging.remoteServers, ['system', 'logging', 'remoteServers'])
      const at = ['system', 'logging']
      if (logging.sourceInterface !== undefined) emit(`logging source-interface ${ref(logging.sourceInterface)}`, [...at, 'sourceInterface'])
      const servers = Object.entries(logging.remoteServers ?? {})
      // IOS has one trap level and one facility for every host: write them when every host agrees.
      for (const field of ['facility', 'severity'] as const) {
        const values = new Set(servers.map(([, s]) => s[field]))
        const set = servers.filter(([, s]) => s[field] !== undefined)
        if (!set.length) continue
        if (values.size === 1 && (field === 'facility' || Object.hasOwn(IOS_SEVERITY, String(set[0][1][field])))) {
          const value = set[0][1][field]!
          emit(field === 'severity' ? `logging trap ${IOS_SEVERITY[value]}` : `logging facility ${value}`, ...set.map(([address]) => [...at, 'remoteServers', address, field]))
        } else {
          const why = values.size === 1 ? 'not a syslog severity IOS knows' : `IOS sets one ${field === 'severity' ? 'trap level' : 'facility'} for every syslog host, and these differ`
          for (const [address] of set) skip([...at, 'remoteServers', address, field], 'unsupported', why)
        }
      }
      for (const [address, server] of servers) {
        const s = [...at, 'remoteServers', address]
        const fields: Segments[] = isEmpty(server) ? [s] : []
        let line = `logging host ${address}`
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...s, 'networkInstance'])
        }
        if (server.port !== undefined) {
          line += ` transport udp port ${server.port}`
          fields.push([...s, 'port'])
        }
        emit(line, ...fields)
      }
    }

    const snmp = system.snmp
    if (snmp) {
      separator()
      emptyContainer(snmp, ['system', 'snmp'])
      emptyContainer(snmp.communities, ['system', 'snmp', 'communities'])
      if (snmp.location !== undefined) emit(`snmp-server location ${snmp.location}`, ['system', 'snmp', 'location'])
      if (snmp.contact !== undefined) emit(`snmp-server contact ${snmp.contact}`, ['system', 'snmp', 'contact'])
      for (const [name, community] of Object.entries(snmp.communities ?? {})) {
        const at = ['system', 'snmp', 'communities', name]
        const access = community.access === undefined ? '' : community.access === 'read-write' ? ' RW' : ' RO'
        if (community.clients !== undefined) {
          // Written without its access list, the community would answer every client: leave it out whole.
          skipAll(community, at, 'IOS limits a community\'s clients with an access list, which comes with filters: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.snmp-community-restricted', message: 'An SNMP community limited to some clients needs an access list, so it isn\'t written.', field: fieldPath(...at) })
          continue
        }
        emit(`snmp-server community ${word(name)}${access}`, ...(community.access !== undefined ? [[...at, 'access']] : isEmpty(community) ? [at] : []))
      }
    }
  }

  separator()
  lines.push('end')
  return { text: `${lines.join('\n')}\n`, dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }

  /**
   * One `router bgp ASN` for every instance's BGP, as IOS runs one AS: the global table's peers, then each address
   * family's activations and route maps, then each VRF's `address-family ipv4|ipv6 vrf V` with its peers. Neighbors
   * carry IPv4 only where an `activate` says so (`no bgp default ipv4-unicast`), as the model lists each one's families.
   */
  function renderBgp() {
    // The global table first: its peers and families, then each VRF's address families.
    const withBgp = Object.entries(model.networkInstances ?? {}).filter(([, ni]) => ni.bgp !== undefined).sort(([a], [b]) => Number(b === 'default') - Number(a === 'default'))
    if (!withBgp.length) return
    const as = model.networkInstances?.default?.bgp?.localAs ?? withBgp.map(([, ni]) => ni.bgp!.localAs).find((x) => x !== undefined)
    if (as === undefined || !isAsNumber(as)) {
      for (const [instance, ni] of withBgp) skipAll(ni.bgp, ['networkInstances', instance, 'bgp'], 'IOS needs the local AS number, from 1 to 4294967295, to run BGP')
      return
    }
    separator()
    const globalAs = model.networkInstances?.default?.bgp?.localAs
    emit(`router bgp ${as}`, ...(globalAs !== undefined ? [['networkInstances', 'default', 'bgp', 'localAs']] : []))
    /** A peer's settings (groups first, as IOS needs a peer group defined before a neighbor joins it). */
    const peerLines = (instance: string, bgp: Bgp, kind: 'groups' | 'neighbors', key: string, peer: BgpPeer & { type?: string; group?: string }, indent: string) => {
      const at = ['networkInstances', instance, 'bgp', kind, key]
      const n = `${indent}neighbor ${key}`
      if (kind === 'groups') emit(`${n} peer-group`, ...(isEmpty(peer) ? [at] : []))
      if (peer.peerAs !== undefined) {
        if (isAsNumber(peer.peerAs)) emit(`${n} remote-as ${peer.peerAs}`, [...at, 'peerAs'], ...(peer.type !== undefined ? [[...at, 'type']] : []))
        else skip([...at, 'peerAs'], 'unsupported', 'not an AS number from 1 to 4294967295')
      } else if (peer.type === 'internal' && bgp.localAs !== undefined) emit(`${n} remote-as ${as}`, [...at, 'type'])
      if (peer.type !== undefined && dispositions[fieldPath(...at, 'type')] === undefined) skip([...at, 'type'], 'not-applicable', 'IOS tells iBGP from eBGP by the remote AS')
      if (kind === 'neighbors' && peer.group !== undefined) {
        if (bgp.groups && Object.hasOwn(bgp.groups, peer.group)) emit(`${n} peer-group ${peer.group}`, [...at, 'group'])
        else skip([...at, 'group'], 'unsupported', 'names a peer group the model doesn\'t have')
      }
      if (peer.description !== undefined) emit(`${n} description ${peer.description}`, [...at, 'description'])
      if (peer.updateSource !== undefined) emit(`${n} update-source ${ref(peer.updateSource)}`, [...at, 'updateSource'])
      if (peer.localAddress !== undefined) skip([...at, 'localAddress'], 'unsupported', 'IOS sources a session from an interface (update-source), not an address')
      if (peer.multihop !== undefined) {
        const ttl = peer.multihop.ttl
        if (ttl === undefined) emit(`${n} ebgp-multihop`, ...(isEmpty(peer.multihop) ? [[...at, 'multihop']] : []))
        else if (Number.isInteger(ttl) && ttl >= 1 && ttl <= 255) emit(`${n} ebgp-multihop ${ttl}`, [...at, 'multihop', 'ttl'])
        else skip([...at, 'multihop', 'ttl'], 'unsupported', 'not a hop count from 1 to 255')
      }
      if (peer.authentication === true) {
        // The password is never carried: written only once the user gives it.
        const id = bgpPasswordInputId(instance, kind, key)
        const password = answer(id)
        if (password !== undefined) emit(`${n} password ${password}`, [...at, 'authentication'])
        else {
          skip([...at, 'authentication'], 'unsupported', 'needs its password, which the source never carries: a needs-input item asks for it')
          needsInput.push({ id, kind: 'secret', message: `This BGP ${kind === 'groups' ? 'peer group' : 'neighbor'} has a password: give it, as the source never carries it.`, field: fieldPath(...at, 'authentication') })
        }
      } else if (peer.authentication === false) skip([...at, 'authentication'], 'not-applicable', 'no password, IOS\'s default')
    }
    /** A peer's lines in an address family: `activate`, and its route maps (its own, or the peer's for every family). */
    const familyLines = (instance: string, kind: 'groups' | 'neighbors', key: string, peer: BgpPeer, family: BgpAddressFamilyName, indent: string) => {
      const at = ['networkInstances', instance, 'bgp', kind, key]
      const af = peer.addressFamilies?.[family]
      if (af === undefined) return
      const afAt = [...at, 'addressFamilies', family]
      emit(`${indent}neighbor ${key} activate`, ...(isEmpty(af) ? [afAt] : []))
      for (const [direction, leaf] of [['in', 'importPolicies'], ['out', 'exportPolicies']] as const) {
        const own = af[leaf]
        const policies = own ?? peer[leaf]
        const field = own !== undefined ? [...afAt, leaf] : [...at, leaf]
        if (policies === undefined) continue
        if (policies.length !== 1) {
          skip(field, 'unsupported', 'IOS applies one route map a direction')
          continue
        }
        // The peer's own policies go in each family it carries: rendered on the first.
        emit(`${indent}neighbor ${key} route-map ${policies[0]} ${direction}`, ...(own !== undefined || dispositions[fieldPath(...field)] === undefined ? [field] : []))
        if (own !== undefined || !policyWarned.has(fieldPath(...field))) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.route-map-name-only', message: 'A policy is written by name only, as a route map: its body isn\'t converted, so a route map of that name is needed.', field: fieldPath(...field) })
        policyWarned.add(fieldPath(...field))
      }
    }
    const policyWarned = new Set<string>()
    const familiesOfPeers = (bgp: Bgp) => (['ipv4-unicast', 'ipv6-unicast'] as const).filter((f) => [...Object.values(bgp.groups ?? {}), ...Object.values(bgp.neighbors ?? {})].some((p) => p.addressFamilies?.[f] !== undefined))
    /** Peer-level policies on a peer carrying no family: IOS applies route maps in an address family. */
    const unplaced = (instance: string, bgp: Bgp) => {
      for (const kind of ['groups', 'neighbors'] as const)
        for (const [key, peer] of Object.entries(bgp[kind] ?? {}))
          for (const leaf of ['importPolicies', 'exportPolicies'] as const) {
            const field = fieldPath('networkInstances', instance, 'bgp', kind, key, leaf)
            if (peer[leaf] !== undefined && dispositions[field] === undefined) skip(['networkInstances', instance, 'bgp', kind, key, leaf], 'unsupported', 'IOS applies a route map in an address family, and the peer carries none')
          }
    }
    const peersOf = (bgp: Bgp) => [...Object.entries(bgp.groups ?? {}).map(([k, p]) => ['groups', k, p] as const), ...Object.entries(bgp.neighbors ?? {}).map(([k, p]) => ['neighbors', k, p] as const)]

    for (const [instance, ni] of withBgp) {
      const bgp = ni.bgp!
      const at = ['networkInstances', instance, 'bgp']
      emptyContainer(bgp, at)
      emptyContainer(bgp.groups, [...at, 'groups'])
      emptyContainer(bgp.neighbors, [...at, 'neighbors'])
      if (bgp.localAs !== undefined && bgp.localAs !== as) {
        skipAll(bgp, at, 'IOS runs one BGP AS for the global table and every VRF, and this one differs')
        continue
      }
      if (instance === 'default') {
        if (bgp.routerId !== undefined) {
          if (isIpv4(bgp.routerId)) emit(` bgp router-id ${bgp.routerId}`, [...at, 'routerId'])
          else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
        }
        const peers = peersOf(bgp)
        if (peers.length) emit(' no bgp default ipv4-unicast')
        for (const [kind, key, peer] of peers) peerLines(instance, bgp, kind, key, peer, ' ')
        for (const family of familiesOfPeers(bgp)) {
          emit(' !')
          emit(` address-family ${family === 'ipv4-unicast' ? 'ipv4' : 'ipv6'}`)
          for (const [kind, key, peer] of peers) familyLines(instance, kind, key, peer, family, '  ')
          emit(' exit-address-family')
        }
        unplaced(instance, bgp)
        continue
      }
      // A VRF's BGP: its peers in an address family of the VRF, the first they carry (IPv4 by default).
      const families = familiesOfPeers(bgp)
      const peers = peersOf(bgp)
      for (const [index, family] of (families.length ? families : (['ipv4-unicast'] as const)).entries()) {
        emit(' !')
        emit(` address-family ${family === 'ipv4-unicast' ? 'ipv4' : 'ipv6'} vrf ${instance}`, ...(index === 0 && bgp.localAs !== undefined ? [[...at, 'localAs']] : []))
        if (index === 0 && bgp.routerId !== undefined) {
          if (isIpv4(bgp.routerId)) emit(`  bgp router-id ${bgp.routerId}`, [...at, 'routerId'])
          else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
        }
        for (const [kind, key, peer] of peers) {
          const first = (['ipv4-unicast', 'ipv6-unicast'] as const).find((f) => peer.addressFamilies?.[f] !== undefined) ?? 'ipv4-unicast'
          if (first === family) peerLines(instance, bgp, kind, key, peer, '  ')
          familyLines(instance, kind, key, peer, family, '  ')
        }
        emit(' exit-address-family')
      }
      unplaced(instance, bgp)
    }
  }
}
