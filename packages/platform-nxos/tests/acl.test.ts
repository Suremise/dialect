// Access lists (model 0.5.1) beyond their fixture: NX-OS's numbering (remarks take sequence numbers too), port access
// lists on switch ports, what is left out whole and why (the per-term rule), names as own keys, and rendering filters
// NX-OS can't write; and a VRF's import and export maps (model 0.5.2), which go with its route targets.
import { describe, expect, it } from 'vitest'
import { checkFixture } from '@dialect/conformance'
import { buildLedger, MODEL_VERSION, type Device, type ParseResult } from '@dialect/core'
import plugin from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
const lines = (...l: string[]) => l.join('\n')
/** Each statement's disposition, by its line number. */
const at = (result: ParseResult, n: number) => result.dispositions[`L${n}`]
/** The kit's checks on `text` against its own parse: no error, a complete ledger, a stable round trip. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

describe('access lists (model 0.5.1)', () => {
  it('numbers an entry 10 after the highest, a remark\'s included, and keeps the remark as the next entry\'s description', () => {
    const text = lines('ip access-list F', '  10 permit tcp any any eq 22', '  remark the rest', '  permit ip any any')
    const terms = parse(text).model.filters?.ipv4?.F?.terms
    expect(Object.keys(terms ?? {})).toEqual(['10', '30'])
    expect(terms?.['30']).toEqual({ description: 'the rest', actions: { action: 'accept' } })
    expect(render(parse(text).model).text).toContain('  29 remark the rest\n  30 permit ip any any\n')
    expect(roundTrips(text)).toEqual([])
    // An entry at a remark's number is refused, as NX-OS refuses it: the access list is left out.
    const taken = parse(lines('ip access-list F', '  10 remark first', '  10 permit ip any any'))
    expect(taken.model.filters).toBeUndefined()
    expect(at(taken, 3)).toEqual({ kind: 'unsupported', reason: 'a sequence number the access list already has: NX-OS refuses the entry' })
  })

  it('applies a port access list on a switch port, coming in only, and writes it back in its port form', () => {
    const text = lines('ip access-list F', '  10 permit ip any any', 'interface Ethernet1/2', '  switchport', '  ip port access-group F in', 'interface Ethernet1/3', '  switchport', '  ip port access-group F out')
    const result = parse(text)
    expect(result.model.interfaces?.['Ethernet1/2']?.subinterfaces?.['0']?.filters).toEqual({ ipv4: { input: 'F' } })
    expect(at(result, 8)).toEqual({ kind: 'unsupported', reason: 'a port access list filters what comes in only' })
    expect(render(result.model).text).toContain('interface Ethernet1/2\n  switchport\n  ip port access-group F in\n')
    expect(roundTrips(text)).toEqual([])
    // From another platform, a switch port's outgoing filter has no NX-OS form.
    const out = render({ filters: { ipv4: { F: { implicitAction: 'deny', terms: { '10': { actions: { action: 'accept' } } } } } }, interfaces: { 'Ethernet1/4': { switching: { mode: 'access', accessVlan: 1 }, subinterfaces: { '0': { filters: { ipv4: { output: 'F' } } } } } }, vlans: { '1': {} } })
    expect(out.dispositions['interfaces["Ethernet1/4"].subinterfaces["0"].filters.ipv4.output']).toEqual({ kind: 'unsupported', reason: 'a switch port\'s access list filters what comes in only on NX-OS' })
  })

  it('leaves an entry out whole, and the access list with its attachments unless the entry is the last', () => {
    const odd = parse(lines('ip access-list F', '  10 permit ip any any packet-length gt 100', '  20 deny ip any any', 'interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/24', '  ip access-group F in'))
    expect(odd.model.filters).toBeUndefined()
    expect(at(odd, 3)).toEqual({ kind: 'unsupported', reason: 'left out whole: the entry on line 2 isn\'t converted, and the entries after it would see the packets it decides' })
    expect(at(odd, 7)).toEqual({ kind: 'unsupported', reason: 'names an access list that isn\'t converted' })
    expect(buildLedger(odd).complete).toBe(true)
    const last = lines('ip access-list F', '  10 permit tcp any any eq 22', '  20 permit ip any any packet-length gt 100')
    expect(parse(last).model.filters?.ipv4?.F?.terms).toEqual({ '10': { matches: { protocols: [6], destinationPorts: ['22'] }, actions: { action: 'accept' } } })
    expect(roundTrips(last)).toEqual([])
  })

  it('writes the full port range as a range, and takes a /0 as any, both ways, in both families', () => {
    const text = lines('ip access-list F', '  10 permit tcp any range 0 65535 any range 0 65535', '  20 permit udp 0.0.0.0/0 0.0.0.0/0 range 0 65535', 'ipv6 access-list F6', '  10 permit tcp ::/0 range 0 65535 ::/0 range 0 65535', '  20 deny ipv6 any any')
    const result = parse(text)
    expect(result.model.filters?.ipv4?.F?.terms?.['20']?.matches).toEqual({ protocols: [17], destinationPorts: ['0-65535'] })
    expect(result.model.filters?.ipv6?.F6?.terms?.['10']?.matches).toEqual({ protocols: [6], sourcePorts: ['0-65535'], destinationPorts: ['0-65535'] })
    expect(render(result.model).text).toContain('  10 permit tcp any range 0 65535 any range 0 65535\n')
    expect(roundTrips(text)).toEqual([])
  })

  it('warns where an IPv6 access list relies on its end, which some platforms open to neighbor discovery, and not with a final catch-all', () => {
    const relies = parse(lines('ipv6 access-list F', '  10 permit tcp any any eq 22'))
    expect(relies.diagnostics.map((d) => [d.code, d.field])).toEqual([['nxos.ipv6-acl-neighbor-discovery', 'filters.ipv6.F']])
    expect(render(relies.model).diagnostics.map((d) => d.code)).toEqual(['nxos.filter-implicit-deny', 'nxos.ipv6-acl-neighbor-discovery'])
    const explicit = parse(lines('ipv6 access-list F', '  10 permit tcp any any eq 22', '  20 deny ipv6 any any'))
    expect(explicit.diagnostics).toEqual([])
    expect(render(explicit.model).diagnostics).toEqual([])
  })

  it('keeps any name as an own key, and leaves Object.prototype alone', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const text = lines('ip access-list __proto__', '  10 permit ip any any', 'ipv6 access-list constructor', '  10 permit ipv6 any any', 'interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/24', '  ip access-group __proto__ in', '  ipv6 traffic-filter constructor out')
    const filters = parse(text).model.filters!
    expect(Object.hasOwn(filters.ipv4!, '__proto__')).toBe(true)
    expect(Object.hasOwn(filters.ipv6!, 'constructor')).toBe(true)
    expect(roundTrips(text)).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
  })

  it('never writes a flag that must be clear, a description with no number free before its entry, or a term it can\'t say whole', () => {
    const model: Device = {
      filters: {
        ipv4: {
          CLEAR: { implicitAction: 'deny', terms: { '10': { matches: { protocols: [6], tcpFlags: { set: ['syn'], clear: ['ack'] } }, actions: { action: 'accept' } }, '20': { actions: { action: 'accept' } } } },
          TIGHT: { implicitAction: 'deny', terms: { '1': { actions: { action: 'accept' } }, '2': { description: 'no room', actions: { action: 'discard' } }, '3': { actions: { action: 'accept' } } } }
        }
      }
    }
    const result = render(model)
    expect(result.text).toBe('\n')
    expect(result.dispositions['filters.ipv4.TIGHT.terms["2"].description']).toEqual({ kind: 'unsupported', reason: 'left out whole: term 2 can\'t be written (a description with no sequence number free before the entry for its remark), and leaving it out would change what the terms after it see' })
  })
})

describe('a VRF\'s import and export maps (model 0.5.2)', () => {
  const vrf = (...families: string[][]) => lines('vrf context V', '  rd 65000:1', ...families.flatMap(([family, ...inside]) => [`  address-family ${family} unicast`, '    route-target both 65000:1', ...inside.map((s) => `    ${s}`)]))

  it('keeps a map every family names that resolves, filtering after the route targets', () => {
    const text = lines(vrf(['ipv4', 'import map IN'], ['ipv6', 'import map IN']), 'route-map IN permit 10')
    expect(parse(text).model.networkInstances?.V).toMatchObject({ importPolicies: ['IN'], vrfPolicyMode: 'after-route-targets', routeTargets: { import: ['65000:1'], export: ['65000:1'] } })
    expect(roundTrips(text)).toEqual([])
  })

  it('leaves the route targets out with a map that differs between families or doesn\'t resolve, and with a leak to another VRF', () => {
    const differ = parse(lines(vrf(['ipv4', 'import map A'], ['ipv6', 'import map B']), 'route-map A permit 10', 'route-map B permit 10'))
    expect(differ.model.networkInstances?.V).toEqual({ type: 'vrf', routeDistinguisher: '65000:1' })
    expect(at(differ, 5)).toEqual({ kind: 'unsupported', reason: 'maps that differ between the address families: the model holds one each way for the VRF' })
    const undefinedMap = parse(vrf(['ipv4', 'export map NOPE']))
    expect(undefinedMap.model.networkInstances?.V?.routeTargets).toBeUndefined()
    const leak = parse(lines(vrf(['ipv4', 'import map A', 'import vrf default map A']), 'route-map A permit 10'))
    expect(leak.model.networkInstances?.V?.routeTargets).toBeUndefined()
    expect(leak.model.networkInstances?.V?.importPolicies).toBeUndefined()
  })

  it('never writes a direction\'s route targets without its map when the map can\'t be written, which would widen what they carry', () => {
    const policies = { P: { fallThrough: 'reject' as const, terms: { '10': { matches: { protocols: ['connected' as const] }, actions: { flow: 'accept' as const } } } }, A: { fallThrough: 'reject' as const, terms: { '10': { actions: { flow: 'accept' as const } } } }, B: { fallThrough: 'reject' as const, terms: { '10': { actions: { flow: 'accept' as const } } } } }
    const result = render({ routingPolicy: { policies }, networkInstances: { V: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'], export: ['65000:2'] }, importPolicies: ['P'], exportPolicies: ['A', 'B'], vrfPolicyMode: 'after-route-targets' } } })
    expect(result.text).not.toContain('route-target')
    expect(result.text).not.toMatch(/ (import|export) map /)
    for (const leaf of ['import', 'export']) expect(result.dispositions[`networkInstances.V.routeTargets.${leaf}`]).toMatchObject({ kind: 'unsupported' })
    const ok = render({ routingPolicy: { policies }, networkInstances: { V: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'] }, importPolicies: ['A'], vrfPolicyMode: 'after-route-targets' } } })
    expect(ok.text).toContain('    route-target import 65000:1\n    import map A\n')
  })
})