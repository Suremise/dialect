// modelProblems(), isRouteDistinguisher(), isVlanId() and isAsNumber(): what a model must hold beyond its types
// (validate.ts).
import { describe, expect, it } from 'vitest'
import { fieldPath, isAsNumber, isRouteDistinguisher, isVlanId, modelProblems, type Device } from '../src'

describe('isRouteDistinguisher', () => {
  it('takes the three forms: ASN:nn, IP:nn and ASN4:nn, at their bounds', () => {
    for (const ok of ['65000:100', '0:0', '65535:4294967295', '192.0.2.1:100', '0.0.0.0:65535', '255.255.255.255:0', '65536:65535', '4200000000:100', '4294967295:0'])
      expect(isRouteDistinguisher(ok), ok).toBe(true)
  })

  it('refuses anything else', () => {
    for (const bad of [
      '', '65000', ':100', '65000:', '65000:100:1', 'target:65000:100', '65000 :100', ' 65000:100', '-1:100', '+1:100', '065000:100', '65000:0100',
      // Out of range: the assigned number for ASN:nn, IP:nn and ASN4:nn, and the AS itself.
      '65535:4294967296', '192.0.2.1:65536', '65536:65536', '4294967296:0', '4200000000:4294967295',
      // Not an IPv4 address, nor asdot.
      '192.0.2:100', '192.0.2.256:100', '192.0.2.01:100', '1.10:100', '2001:db8::1:100', 'blue:100', '65000L:100'
    ])
      expect(isRouteDistinguisher(bad), bad).toBe(false)
    for (const notText of [undefined, null, 65000, ['65000:100']]) expect(isRouteDistinguisher(notText)).toBe(false)
  })
})

describe('modelProblems', () => {
  const vrf = (networkInstance: string): Device => ({ interfaces: { eth0: { subinterfaces: { '0': { networkInstance }, '10': { vlanId: 10 } } } } })
  const field = fieldPath('interfaces', 'eth0', 'subinterfaces', '0', 'networkInstance')

  it('finds nothing wrong in an empty model, or one whose subinterfaces name declared VRFs', () => {
    expect(modelProblems({})).toEqual([])
    expect(modelProblems({ ...vrf('blue'), networkInstances: { blue: { type: 'vrf' } } })).toEqual([])
  })

  it('reports a subinterface naming a network instance the model doesn\'t have, on its field, without the name', () => {
    for (const device of [vrf('blue'), { ...vrf('blue'), networkInstances: { red: { type: 'vrf' } } }]) {
      const problems = modelProblems(device as Device)
      expect(problems).toEqual([{ severity: 'error', category: 'semantic', code: 'model.unknown-network-instance', message: 'A subinterface names a network instance the model doesn\'t have.', field }])
    }
  })

  it('reports `default` as a subinterface\'s network instance: the default table is said by leaving it out', () => {
    expect(modelProblems({ ...vrf('default'), networkInstances: { default: { type: 'default' } } }).map((d) => [d.code, d.field])).toEqual([['model.default-network-instance', field]])
  })

  it('reports malformed route distinguishers and route targets, once per field, never quoting them', () => {
    const secret = 'CANARY_SECRET'
    const device: Device = {
      networkInstances: {
        good: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1', '192.0.2.1:7'], export: ['4200000000:1'] } },
        bad: { type: 'vrf', routeDistinguisher: secret, routeTargets: { import: ['65000:1', secret, 'x'], export: [secret] } }
      }
    }
    const problems = modelProblems(device)
    expect(problems.map((d) => [d.code, d.field])).toEqual([
      ['model.route-distinguisher', 'networkInstances.bad.routeDistinguisher'],
      ['model.route-target', 'networkInstances.bad.routeTargets.import'],
      ['model.route-target', 'networkInstances.bad.routeTargets.export']
    ])
    expect(problems.every((d) => d.severity === 'error' && !d.message.includes(secret))).toBe(true)
  })

  it('reads a model from JSON or a careless plugin without trusting its types', () => {
    const loose = JSON.parse('{"interfaces":{"eth0":{"subinterfaces":{"0":{"networkInstance":7}}}},"networkInstances":{"7":{},"v":{"routeDistinguisher":1,"routeTargets":{"import":"65000:1"}}}}') as Device
    expect(modelProblems(loose).map((d) => d.code)).toEqual(['model.unknown-network-instance', 'model.route-distinguisher'])
  })
})

describe('isVlanId and isAsNumber', () => {
  it('take integers in range, at their bounds, and nothing else', () => {
    for (const ok of [1, 10, 4094]) expect(isVlanId(ok), String(ok)).toBe(true)
    for (const bad of [0, 4095, -1, 1.5, NaN, '10', undefined]) expect(isVlanId(bad), String(bad)).toBe(false)
    for (const ok of [1, 65000, 65536, 4200000000, 4294967295]) expect(isAsNumber(ok), String(ok)).toBe(true)
    for (const bad of [0, 4294967296, -1, 65000.5, '65000', '1.10', undefined]) expect(isAsNumber(bad), String(bad)).toBe(false)
  })
})

describe('modelProblems, model 0.4.0', () => {
  const CANARY = 'CANARY_SECRET'
  const address = { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
  /** Each problem as [code, field], and none of the messages quoting a value. */
  const problems = (device: Device) => {
    const found = modelProblems(device)
    expect(found.every((d) => d.severity === 'error' && !d.message.includes(CANARY))).toBe(true)
    return found.map((d) => [d.code, d.field])
  }

  it('finds nothing wrong in VLANs, switch ports and routed VLANs that resolve', () => {
    const device: Device = {
      interfaces: {
        'ge-0/0/1': { switching: { mode: 'access', accessVlan: 10 } },
        'ge-0/0/2': { switching: { mode: 'trunk', allowedVlans: ['10', '20', '100-4094', '1-4094'], nativeVlan: 20 } },
        irb: { type: 'irb-or-svi', subinterfaces: { '10': { ...address, routedVlan: 10 }, '20': { routedVlan: 20 } } }
      },
      vlans: { '10': { name: 'users' }, '20': {} }
    }
    expect(problems(device)).toEqual([])
  })

  it('reports VLAN IDs out of range or not integers, and VLANs keyed by anything but their ID', () => {
    const device: Device = {
      interfaces: { 'ge-0/0/1': { switching: { accessVlan: 4095, nativeVlan: 1.5 } }, irb: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 0 } } } },
      vlans: { [CANARY]: {}, '010': {}, '4095': {}, '0': {}, '1': {} }
    }
    expect(problems(device)).toEqual([
      ['model.vlan-id', fieldPath('interfaces', 'ge-0/0/1', 'switching', 'accessVlan')],
      ['model.vlan-id', fieldPath('interfaces', 'ge-0/0/1', 'switching', 'nativeVlan')],
      ['model.vlan-id', fieldPath('interfaces', 'irb', 'subinterfaces', '0', 'routedVlan')],
      // In key order: JavaScript puts integer-like keys first.
      ['model.vlan-id', fieldPath('vlans', '0')],
      ['model.vlan-id', fieldPath('vlans', '4095')],
      ['model.vlan-id', fieldPath('vlans', CANARY)],
      ['model.vlan-id', fieldPath('vlans', '010')]
    ])
  })

  it('reports an access, native, routed or single trunk VLAN the model doesn\'t have, and ranges in no form, once per list', () => {
    const missing: Device = {
      interfaces: {
        'ge-0/0/1': { switching: { mode: 'access', accessVlan: 10 } },
        'ge-0/0/2': { switching: { mode: 'trunk', allowedVlans: ['20', '30'], nativeVlan: 40 } },
        Vlan50: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 50 } } }
      },
      vlans: { '20': {} }
    }
    expect(problems(missing)).toEqual([
      ['model.unknown-vlan', fieldPath('interfaces', 'ge-0/0/1', 'switching', 'accessVlan')],
      ['model.unknown-vlan', fieldPath('interfaces', 'ge-0/0/2', 'switching', 'nativeVlan')],
      ['model.unknown-vlan', fieldPath('interfaces', 'ge-0/0/2', 'switching', 'allowedVlans')],
      ['model.unknown-vlan', fieldPath('interfaces', 'Vlan50', 'subinterfaces', '0', 'routedVlan')]
    ])
    // A range carries whichever of its VLANs exist: none needs declaring.
    expect(problems({ interfaces: { e1: { switching: { allowedVlans: ['2-4094'] } } } })).toEqual([])
    for (const bad of [[CANARY], ['30-20'], ['20-20'], ['0-10'], ['1-4095'], ['10-'], ['010'], [' 10'], ['10,20']])
      expect(problems({ interfaces: { e1: { switching: { allowedVlans: bad } } }, vlans: { '10': {}, '20': {} } }), bad.join()).toEqual([['model.vlan-range', fieldPath('interfaces', 'e1', 'switching', 'allowedVlans')]])
  })

  it('reports an irb-or-svi interface that routes for no VLAN, and a routed VLAN on another type', () => {
    expect(problems({ interfaces: { irb: { type: 'irb-or-svi', subinterfaces: { '0': address } } } })).toEqual([['model.irb-without-vlan', fieldPath('interfaces', 'irb', 'type')]])
    expect(problems({ interfaces: { irb: { type: 'irb-or-svi' } } })).toEqual([['model.irb-without-vlan', fieldPath('interfaces', 'irb', 'type')]])
    expect(problems({ interfaces: { Vlan10: { type: 'vlan', subinterfaces: { '0': { routedVlan: 10 } } } }, vlans: { '10': {} } })).toEqual([['model.routed-vlan-interface', fieldPath('interfaces', 'Vlan10', 'subinterfaces', '0', 'routedVlan')]])
  })

  const ospf = (instance: object): Device => ({ interfaces: { 'ge-0/0/0': { subinterfaces: { '0': address, '10': {} } }, lo0: {} }, networkInstances: { default: instance } })

  it('finds nothing wrong in OSPF and BGP whose references resolve', () => {
    const device = ospf({
      ospf: { routerId: '192.0.2.1', areas: { '0.0.0.0': { interfaces: { 'ge-0/0/0.0': {}, 'ge-0/0/0.10': {}, 'ge-0/0/0': {}, lo0: { passive: true } } } } },
      bgp: { localAs: 65000, routerId: '192.0.2.1', groups: { peers: { peerAs: 4200000000, updateSource: 'lo0' } }, neighbors: { '10.0.0.2': { group: 'peers', updateSource: 'ge-0/0/0.0' }, '10.0.0.3': { peerAs: 65001 } } }
    })
    expect(problems(device)).toEqual([])
  })

  it('reports router IDs and areas in no form, and OSPF interfaces naming no interface or subinterface', () => {
    const device = ospf({ ospf: { routerId: CANARY, areas: { '0': { interfaces: { 'ge-0/0/0.5': {}, 'ge-0/0/1.0': {}, [CANARY]: {} } } } }, bgp: { routerId: '192.0.2' } })
    const area = ['networkInstances', 'default', 'ospf', 'areas', '0'] as const
    expect(problems(device)).toEqual([
      ['model.router-id', fieldPath('networkInstances', 'default', 'ospf', 'routerId')],
      ['model.ospf-area', fieldPath(...area)],
      ['model.unknown-interface', fieldPath(...area, 'interfaces', 'ge-0/0/0.5')],
      ['model.unknown-interface', fieldPath(...area, 'interfaces', 'ge-0/0/1.0')],
      ['model.unknown-interface', fieldPath(...area, 'interfaces', CANARY)],
      ['model.router-id', fieldPath('networkInstances', 'default', 'bgp', 'routerId')]
    ])
  })

  it('reports AS numbers out of range, update sources naming no interface, and neighbors in a group the instance doesn\'t have', () => {
    const device = ospf({
      bgp: { localAs: 0, groups: { peers: { peerAs: 4294967296, updateSource: CANARY } }, neighbors: { '10.0.0.2': { peerAs: 65000.5, group: CANARY }, '10.0.0.3': { group: 'peers', updateSource: 'lo0.0' } } }
    })
    const bgp = ['networkInstances', 'default', 'bgp'] as const
    expect(problems(device)).toEqual([
      ['model.as-number', fieldPath(...bgp, 'localAs')],
      ['model.as-number', fieldPath(...bgp, 'groups', 'peers', 'peerAs')],
      ['model.unknown-interface', fieldPath(...bgp, 'groups', 'peers', 'updateSource')],
      ['model.as-number', fieldPath(...bgp, 'neighbors', '10.0.0.2', 'peerAs')],
      ['model.unknown-bgp-group', fieldPath(...bgp, 'neighbors', '10.0.0.2', 'group')],
      ['model.unknown-interface', fieldPath(...bgp, 'neighbors', '10.0.0.3', 'updateSource')]
    ])
    // A group in another instance isn't this one's.
    const elsewhere: Device = { networkInstances: { default: { bgp: { groups: { peers: {} } } }, blue: { type: 'vrf', bgp: { neighbors: { '10.0.0.2': { group: 'peers' } } } } } }
    expect(problems(elsewhere)).toEqual([['model.unknown-bgp-group', fieldPath('networkInstances', 'blue', 'bgp', 'neighbors', '10.0.0.2', 'group')]])
  })

  it('reads a 0.4 model from JSON or a careless plugin without trusting its types', () => {
    const loose = JSON.parse('{"interfaces":{"e1":{"switching":{"accessVlan":"10","allowedVlans":"10"}}},"vlans":{"10":{}},"networkInstances":{"default":{"bgp":{"localAs":"65000","neighbors":{"10.0.0.2":{"group":7}}}}}}') as Device
    expect(problems(loose)).toEqual([
      ['model.vlan-id', fieldPath('interfaces', 'e1', 'switching', 'accessVlan')],
      ['model.as-number', fieldPath('networkInstances', 'default', 'bgp', 'localAs')],
      ['model.unknown-bgp-group', fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'group')]
    ])
  })
})
