// modelProblems(), isRouteDistinguisher(), isVlanId(), isAsNumber() and model 0.5.0's isIpAddress(), parsePrefix(),
// communityType() and isPositionKey(): what a model must hold beyond its types (validate.ts).
import { describe, expect, it } from 'vitest'
import { communityType, deserializeModel, fieldPath, isAsNumber, isIpAddress, isPortRange, isPositionKey, isRouteDistinguisher, isVlanId, modelProblems, parsePrefix, populatedLeaves, serializeModel, type CommunityType, type Device, type PrefixMatchForm, type RegexDialect } from '../src'

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

describe('isIpAddress, parsePrefix, communityType and isPositionKey (model 0.5.0)', () => {
  it('takes IPv4 and IPv6 addresses, with :: and a final dotted part, and refuses the rest', () => {
    for (const ok of ['192.0.2.1', '0.0.0.0', '::', '::1', '2001:db8::', '2001:DB8::1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::ffff:192.0.2.1', '1:2:3:4:5:6:192.0.2.1'])
      expect(isIpAddress(ok), ok).toBe(true)
    for (const bad of ['', '192.0.2', '192.0.2.256', '192.0.2.01', ':::', '1::2::3', ':1', '1:2:3:4:5:6:7:8:9', '::1:2:3:4:5:6:7:8', '12345::', 'g::1', '::192.0.2.256', '1:2:3:4:5:6:7:192.0.2.1', ' ::1'])
      expect(isIpAddress(bad), bad).toBe(false)
    expect(isIpAddress(1)).toBe(false)
  })

  it('reads a prefix with no host bits set, and its family and length', () => {
    expect(parsePrefix('10.0.0.0/8')).toEqual({ family: 'ipv4', length: 8 })
    expect(parsePrefix('0.0.0.0/0')).toEqual({ family: 'ipv4', length: 0 })
    expect(parsePrefix('192.0.2.1/32')).toEqual({ family: 'ipv4', length: 32 })
    expect(parsePrefix('2001:db8::/32')).toEqual({ family: 'ipv6', length: 32 })
    expect(parsePrefix('::/0')).toEqual({ family: 'ipv6', length: 0 })
    for (const bad of ['10.0.0.1/8', '10.0.0.0/33', '10.0.0.0', '10.0.0.0/', '10.0.0.0/08', '2001:db8::1/32', '2001:db8::/129', 'x/8', undefined]) expect(parsePrefix(bad), String(bad)).toBeNull()
  })

  it('says which kind a community is, in the model\'s forms only', () => {
    for (const [value, type] of [
      ['65000:100', 'standard'],
      ['0:0', 'standard'],
      ['65535:65535', 'standard'],
      ['no-export', 'standard'],
      ['graceful-shutdown', 'standard'],
      ['target:65000:100', 'extended'],
      ['origin:192.0.2.1:100', 'extended'],
      ['target:4200000000:1', 'extended'],
      ['large:65000:1:2', 'large'],
      ['large:4294967295:0:4294967295', 'large']
    ] as const)
      expect(communityType(value), value).toBe(type)
    for (const bad of ['', '65536:1', '65000', '65000:1:2', 'rt 65000:1', 'target:65000', 'soo:65000:1', 'large:1:2', 'large:4294967296:0:0', 'NO-EXPORT', 'local-AS', 'internet', ' 65000:1'])
      expect(communityType(bad), bad).toBeNull()
  })

  it('takes positions from 0 to 4294967294, written plainly', () => {
    for (const ok of ['0', '1', '10', '65535', '4294967294']) expect(isPositionKey(ok), ok).toBe(true)
    for (const bad of ['', '01', '-1', '+1', '1.0', '1e3', '4294967295', 'a', ' 1']) expect(isPositionKey(bad), bad).toBe(false)
  })
})

describe('modelProblems, model 0.5.0', () => {
  const CANARY = 'CANARY_SECRET'
  /** Each problem as [code, field], and none of the messages quoting a value. */
  const problems = (device: Device, options?: Parameters<typeof modelProblems>[1]) => {
    const found = modelProblems(device, options)
    expect(found.every((d) => d.severity === 'error' && !d.message.includes(CANARY))).toBe(true)
    return found.map((d) => [d.code, d.field])
  }
  const at = (...path: string[]) => fieldPath('routingPolicy', ...path)
  const valid: Device = {
    routingPolicy: {
      prefixLists: {
        ipv4: {
          LOOPBACKS: { description: 'loopbacks', entries: { '5': { action: 'permit', prefix: '192.0.2.0/24', minLength: 32, maxLength: 32, form: 'ge' }, '10': { action: 'deny', prefix: '0.0.0.0/0', minLength: 0, maxLength: 32, form: 'le' } } },
          EMPTY: {}
        },
        ipv6: { LOOPBACKS: { entries: { '1': { action: 'permit', prefix: '2001:db8::/32', minLength: 64, maxLength: 128, form: 'ge' } } } }
      },
      communitySets: {
        CUSTOMER: { entries: { '1': { action: 'permit', members: ['65000:100', 'no-export'] } } },
        RT: { entries: { '1': { action: 'permit', members: ['target:65000:1', 'large:65000:1:2'] } } },
        REGEX: { type: 'standard', regexDialect: 'cisco', entries: { '10': { action: 'deny', regexes: ['_65000:9[0-9]_'] }, '20': { action: 'permit', regexes: ['_65000:.*_'] } } }
      },
      asPathSets: { FROM_PEER: { regexDialect: 'junos', entries: { '1': { action: 'permit', regex: '65001 .*' } } } },
      policies: {
        IN: {
          fallThrough: 'next-policy',
          terms: {
            '1': { name: 'customers', matches: { prefixLists: { ipv4: ['LOOPBACKS'], ipv6: ['LOOPBACKS'] }, prefixListMatch: 'orlonger', communitySets: ['CUSTOMER', 'REGEX'], asPathSets: ['FROM_PEER'], protocols: ['bgp'], neighbors: ['192.0.2.2', '2001:db8::2'], tags: [0, 4294967295], family: 'ipv4' }, actions: { localPreference: 200, med: 0, communityAdd: { values: ['65000:1'], sets: ['RT'] }, communityDelete: { sets: ['REGEX'] }, asPathPrepend: [65000, 65000], nextHop: '192.0.2.1', tag: 7, flow: 'accept' } },
            '2': { name: 'filters', matches: { routeFilters: { '1': { prefix: '10.0.0.0/8', minLength: 8, maxLength: 32, form: 'orlonger' }, '2': { prefix: '2001:db8::/32', minLength: 33, maxLength: 128, form: 'longer' }, '3': { prefix: '172.16.0.0/12', minLength: 12, maxLength: 24, form: 'upto' }, '4': { prefix: '192.168.0.0/16', minLength: 20, maxLength: 24, form: 'prefix-length-range' }, '5': { prefix: '192.0.2.0/24', minLength: 24, maxLength: 24, form: 'exact' }, '6': { prefix: '198.51.100.0/24', minLength: 25, maxLength: 28, form: 'ge-le' }, '7': { prefix: '203.0.113.0/24', minLength: 24, maxLength: 24 } } }, actions: { communitySet: { values: ['65000:1'] }, nextHopSelf: true, flow: 'next-policy' } },
            '3': { actions: { flow: 'reject' } }
          }
        },
        EMPTY: { fallThrough: 'reject' }
      }
    },
    networkInstances: { default: { bgp: { groups: { peers: { importPolicies: ['IN'], addressFamilies: { 'ipv4-unicast': { exportPolicies: ['EMPTY', 'IN'] } } } }, neighbors: { '192.0.2.2': { group: 'peers', exportPolicies: ['EMPTY'] } } } } }
  }

  it('finds nothing wrong in prefix lists, sets and policies that resolve, in the model\'s forms', () => {
    expect(problems(valid)).toEqual([])
  })

  it('reports keys that aren\'t positions, wherever the model orders by position', () => {
    const device: Device = {
      routingPolicy: {
        prefixLists: { ipv4: { L: { entries: { '010': { action: 'permit', prefix: '10.0.0.0/8', minLength: 8, maxLength: 8 } } } } },
        communitySets: { C: { entries: { first: { action: 'permit', members: ['65000:1'] } } } },
        asPathSets: { A: { regexDialect: 'cisco', entries: { '-1': { action: 'permit', regex: '_65000_' } } } },
        policies: { P: { fallThrough: 'reject', terms: { [CANARY]: { actions: { flow: 'accept' } }, '1': { matches: { routeFilters: { '4294967295': { prefix: '10.0.0.0/8', minLength: 8, maxLength: 8 } } } } } } }
      }
    }
    expect(problems(device)).toEqual([
      ['model.position', at('prefixLists', 'ipv4', 'L', 'entries', '010')],
      ['model.position', at('communitySets', 'C', 'entries', 'first')],
      ['model.position', at('asPathSets', 'A', 'entries', '-1')],
      ['model.position', at('policies', 'P', 'terms', CANARY)],
      ['model.position', at('policies', 'P', 'terms', '1', 'matches', 'routeFilters', '4294967295')]
    ])
  })

  it('reports prefixes not in CIDR form, with host bits, or of the other family, and lengths out of range or against their form', () => {
    const entry = (prefix: string, minLength: number, maxLength: number, form?: PrefixMatchForm) => ({ action: 'permit' as const, prefix, minLength, maxLength, ...(form ? { form } : {}) })
    const device: Device = {
      routingPolicy: {
        prefixLists: {
          ipv4: {
            L: {
              entries: {
                '1': entry(CANARY, 8, 8),
                '2': entry('10.0.0.1/8', 8, 8),
                '3': entry('2001:db8::/32', 32, 32),
                '4': entry('10.0.0.0/8', 7, 8),
                '5': entry('10.0.0.0/8', 8, 33),
                '6': entry('10.0.0.0/8', 16, 12),
                '7': entry('10.0.0.0/8', 8, 24, 'orlonger'),
                '8': entry('10.0.0.0/8', 8, 32, 'ge'),
                '9': entry('10.0.0.0/8', 8, 8, 'longer'),
                '10': entry('10.0.0.0/8', 9, 9, 'exact'),
                '11': entry('10.0.0.0/8', 8, 8.5),
                '12': entry('10.0.0.0/8', 8, 8, 'bogus' as PrefixMatchForm)
              }
            }
          },
          ipv6: { L6: { entries: { '1': entry('10.0.0.0/8', 8, 8) } } }
        }
      }
    }
    const list = (key: string, leaf: string) => at('prefixLists', 'ipv4', 'L', 'entries', key, leaf)
    expect(problems(device)).toEqual([
      ['model.prefix', list('1', 'prefix')],
      ['model.prefix', list('2', 'prefix')],
      ['model.prefix', list('3', 'prefix')],
      ['model.prefix-length', list('4', 'minLength')],
      ['model.prefix-length', list('5', 'minLength')],
      ['model.prefix-length', list('6', 'minLength')],
      ['model.prefix-length', list('7', 'form')],
      ['model.prefix-length', list('8', 'form')],
      ['model.prefix-length', list('9', 'form')],
      ['model.prefix-length', list('10', 'form')],
      ['model.prefix-length', list('11', 'minLength')],
      ['model.prefix-length', list('12', 'form')],
      ['model.prefix', at('prefixLists', 'ipv6', 'L6', 'entries', '1', 'prefix')]
    ])
  })

  it('reports communities in no model form, regexes with no dialect, numbers out of range, and addresses that aren\'t', () => {
    const device: Device = {
      routingPolicy: {
        communitySets: { C: { entries: { '1': { action: 'permit', members: ['65000:1', CANARY] } } }, R: { entries: { '1': { action: 'permit', regexes: ['_65000_'] } } } },
        asPathSets: { A: { entries: { '1': { action: 'permit', regex: '_65000_' } } }, EMPTY: {}, PERL: { regexDialect: 'perl' as RegexDialect } },
        policies: {
          P: {
            fallThrough: 'reject',
            terms: {
              '1': {
                matches: { neighbors: ['192.0.2.2', CANARY], tags: [1, -1] },
                actions: { localPreference: 4294967296, med: 1.5, tag: -1, asPathPrepend: [65000, 0], nextHop: CANARY, communityAdd: { values: ['rt 65000:1'] }, communitySet: { values: ['65000:1'] }, communityDelete: { values: [CANARY] } }
              }
            }
          }
        }
      }
    }
    const term = (...path: string[]) => at('policies', 'P', 'terms', '1', ...path)
    expect(problems(device)).toEqual([
      ['model.community', at('communitySets', 'C', 'entries', '1', 'members')],
      ['model.community-type', at('communitySets', 'R', 'type')],
      ['model.regex-dialect', at('communitySets', 'R', 'regexDialect')],
      ['model.regex-dialect', at('asPathSets', 'A', 'regexDialect')],
      ['model.regex-dialect', at('asPathSets', 'PERL', 'regexDialect')],
      ['model.ip-address', term('matches', 'neighbors')],
      ['model.number', term('matches', 'tags')],
      ['model.number', term('actions', 'localPreference')],
      ['model.number', term('actions', 'med')],
      ['model.number', term('actions', 'tag')],
      ['model.as-number', term('actions', 'asPathPrepend')],
      ['model.ip-address', term('actions', 'nextHop')],
      ['model.community', term('actions', 'communityAdd', 'values')],
      ['model.community', term('actions', 'communityDelete', 'values')]
    ])
  })

  it('reports a term naming a prefix list, set or community set the model doesn\'t have, by family for prefix lists', () => {
    const device: Device = {
      routingPolicy: {
        prefixLists: { ipv4: { V4: {} }, ipv6: { V6: {} } },
        communitySets: { C: {} },
        policies: { P: { fallThrough: 'reject', terms: { '1': { matches: { prefixLists: { ipv4: ['V4', 'V6'], ipv6: ['V6'] }, communitySets: ['C', CANARY], asPathSets: ['A'] }, actions: { communityAdd: { sets: ['C'] }, communitySet: { sets: [CANARY] }, communityDelete: { sets: ['toString'] } } } } } }
      }
    }
    const term = (...path: string[]) => at('policies', 'P', 'terms', '1', ...path)
    expect(problems(device)).toEqual([
      ['model.unknown-prefix-list', term('matches', 'prefixLists', 'ipv4')],
      ['model.unknown-community-set', term('matches', 'communitySets')],
      ['model.unknown-as-path-set', term('matches', 'asPathSets')],
      ['model.unknown-community-set', term('actions', 'communitySet', 'sets')],
      ['model.unknown-community-set', term('actions', 'communityDelete', 'sets')]
    ])
  })

  it('reports a BGP peer\'s or family\'s policy the model doesn\'t have, unless told to leave BGP policy names alone', () => {
    const bgp = ['networkInstances', 'blue', 'bgp'] as const
    const device: Device = {
      routingPolicy: { policies: { IN: { fallThrough: 'reject' } } },
      networkInstances: {
        blue: {
          type: 'vrf',
          bgp: {
            groups: { peers: { importPolicies: ['IN', CANARY], addressFamilies: { 'ipv6-unicast': { exportPolicies: ['OUT'] } } } },
            neighbors: { '192.0.2.2': { exportPolicies: ['IN'], addressFamilies: { 'ipv4-unicast': { importPolicies: ['IN'], exportPolicies: ['constructor'] } } } }
          }
        }
      }
    }
    expect(problems(device)).toEqual([
      ['model.unknown-policy', fieldPath(...bgp, 'groups', 'peers', 'importPolicies')],
      ['model.unknown-policy', fieldPath(...bgp, 'groups', 'peers', 'addressFamilies', 'ipv6-unicast', 'exportPolicies')],
      ['model.unknown-policy', fieldPath(...bgp, 'neighbors', '192.0.2.2', 'addressFamilies', 'ipv4-unicast', 'exportPolicies')]
    ])
    // Phase 2's models: policy names with no routing policy at all, as a plugin that doesn't parse it keeps them.
    expect(problems({ networkInstances: device.networkInstances }, { policyReferences: false })).toEqual([])
    expect(problems({ networkInstances: device.networkInstances }).map(([code]) => code)).toEqual(Array(5).fill('model.unknown-policy'))
  })

  it('keeps a regex-only community set\'s kind: standard, extended and large are three sets, through JSON and as leaves', () => {
    // Cisco's `ip community-list expanded C permit .*`, `ip extcommunity-list expanded …` and `ip large-community-list
    // expanded …`: the same pattern, matching different attributes.
    for (const type of ['standard', 'extended', 'large'] as const) {
      const device: Device = { routingPolicy: { communitySets: { C: { type, regexDialect: 'cisco', entries: { '10': { action: 'permit', regexes: ['.*'] } } } } } }
      expect(problems(device), type).toEqual([])
      expect(deserializeModel(serializeModel(device)).device.routingPolicy?.communitySets?.C.type).toBe(type)
      expect(populatedLeaves(device).map((l) => l.path)).toContain(at('communitySets', 'C', 'type'))
    }
  })

  it('reports a community set with a regex and no type, a type the model doesn\'t have, or members of another kind', () => {
    const device: Device = {
      routingPolicy: {
        communitySets: {
          UNTYPED: { regexDialect: 'cisco', entries: { '1': { action: 'permit', regexes: ['.*'] } } },
          BOGUS: { type: 'normal' as CommunityType },
          LARGE: { type: 'large', entries: { '1': { action: 'permit', members: ['large:65000:1:2', '65000:1'] } } },
          // Members alone say their kinds: a Junos community may mix them, with no type.
          MIXED: { entries: { '1': { action: 'permit', members: ['65000:1', 'target:65000:1', 'large:65000:1:2'] } } }
        }
      }
    }
    expect(problems(device)).toEqual([
      ['model.community-type', at('communitySets', 'UNTYPED', 'type')],
      ['model.community-type', at('communitySets', 'BOGUS', 'type')],
      ['model.community-type', at('communitySets', 'LARGE', 'entries', '1', 'members')]
    ])
  })

  it('reports a policy with no fall-through or an unknown one, an entry with no action or an unknown one, and an unknown flow', () => {
    const loose = JSON.parse(
      '{"routingPolicy":{"prefixLists":{"ipv4":{"L":{"entries":{"1":{"prefix":"10.0.0.0/8","minLength":8,"maxLength":8}}}}},"communitySets":{"C":{"entries":{"1":{"action":"allow","members":["65000:1"]}}}},"asPathSets":{"A":{"regexDialect":"cisco","entries":{"1":{"regex":"_1_"}}}},"policies":{"NONE":{"terms":{"1":{"actions":{"flow":"next-term"}}}},"BAD":{"fallThrough":"accept","terms":{"1":{"actions":{"flow":"continue"}}}},"NULL":{"fallThrough":null}}}}'
    ) as Device
    expect(problems(loose)).toEqual([
      ['model.action', at('prefixLists', 'ipv4', 'L', 'entries', '1', 'action')],
      ['model.action', at('communitySets', 'C', 'entries', '1', 'action')],
      ['model.action', at('asPathSets', 'A', 'entries', '1', 'action')],
      ['model.fall-through', at('policies', 'NONE', 'fallThrough')],
      ['model.fall-through', at('policies', 'BAD', 'fallThrough')],
      ['model.flow', at('policies', 'BAD', 'terms', '1', 'actions', 'flow')],
      ['model.fall-through', at('policies', 'NULL', 'fallThrough')]
    ])
  })

  it('reads a 0.5 model from JSON or a careless plugin without trusting its types', () => {
    const loose = JSON.parse('{"routingPolicy":{"prefixLists":{"ipv4":{"L":{"entries":{"1":{"action":"permit","prefix":7,"minLength":"8","maxLength":8}}}}},"communitySets":{"C":{"entries":{"1":{"action":"deny","members":"65000:1"}}}},"policies":{"P":{"fallThrough":"reject","terms":{"1":{"matches":{"prefixLists":{"ipv4":"L"},"communitySets":"D"},"actions":{"asPathPrepend":"65000","localPreference":"100"}}}}}}}') as Device
    expect(problems(loose)).toEqual([
      ['model.prefix', at('prefixLists', 'ipv4', 'L', 'entries', '1', 'prefix')],
      ['model.unknown-community-set', at('policies', 'P', 'terms', '1', 'matches', 'communitySets')],
      ['model.number', at('policies', 'P', 'terms', '1', 'actions', 'localPreference')],
      ['model.as-number', at('policies', 'P', 'terms', '1', 'actions', 'asPathPrepend')]
    ])
  })
})

describe('isPortRange (model 0.5.1)', () => {
  it('takes a port or a range, first below last, from 0 to 65535', () => {
    for (const ok of ['0', '22', '65535', '1024-65535', '0-1']) expect(isPortRange(ok), ok).toBe(true)
    for (const bad of ['', '65536', '-1', '22-22', '100-20', '01', '1-2-3', '1024-', '-80', 'ssh', ' 22', '22 ']) expect(isPortRange(bad), bad).toBe(false)
    expect(isPortRange(22)).toBe(false)
  })
})

describe('modelProblems, model 0.5.1', () => {
  const CANARY = 'CANARY_SECRET'
  const problems = (device: Device) => {
    const found = modelProblems(device)
    expect(found.every((d) => d.severity === 'error' && !d.message.includes(CANARY))).toBe(true)
    return found.map((d) => [d.code, d.field])
  }
  const at = (...path: string[]) => fieldPath('filters', ...path)

  it('finds nothing wrong in filters in the model\'s forms, applied in their family', () => {
    const device: Device = {
      interfaces: { 'ge-0/0/0': { subinterfaces: { '0': { filters: { ipv4: { input: 'EDGE', output: 'EDGE' }, ipv6: { input: 'EDGE6' } } } } } },
      routingPolicy: { prefixLists: { ipv4: { MGMT: {} } } },
      filters: {
        ipv4: {
          EDGE: {
            description: 'edge',
            implicitAction: 'discard',
            terms: {
              '1': { name: 'ssh', matches: { sourcePrefixLists: ['MGMT'], destinationPrefixes: ['192.0.2.1/32'], protocols: [6], destinationPorts: ['22'], sourcePorts: ['1024-65535'] }, actions: { action: 'accept', count: 'ssh', log: true } },
              '2': { matches: { protocols: [1], icmpTypes: [8, 0], icmpCodes: [0] }, actions: { action: 'accept' } },
              '3': { matches: { protocols: [6], tcpEstablished: true, tcpFlags: { set: ['syn'], clear: ['ack'] }, prefixes: ['10.0.0.0/8'], prefixLists: ['MGMT'], ports: ['80', '443'] }, actions: { action: 'next-term', count: 'web' } },
              '4': { matches: { fragment: 'non-initial', dscp: [0, 46, 63] }, actions: { action: 'reject' } },
              '5': { actions: { action: 'discard' } }
            }
          }
        },
        ipv6: { EDGE6: { implicitAction: 'deny', terms: { '10': { matches: { sourcePrefixes: ['2001:db8::/32'], protocols: [58] }, actions: { action: 'accept' } } } } }
      }
    }
    expect(problems(device)).toEqual([])
  })

  it('reports a filter with no implicit action, a term with no action, keys that aren\'t positions, and values out of range', () => {
    const loose = JSON.parse(
      '{"filters":{"ipv4":{"F":{"terms":{"01":{"actions":{"action":"accept"}},"1":{"actions":{}},"2":{"matches":{"protocols":[256],"icmpTypes":[-1],"icmpCodes":[1.5],"dscp":[64],"sourcePorts":["65536"],"destinationPorts":["80-80"],"ports":["ssh"],"tcpFlags":{"set":["SYN"],"clear":["ack"]},"fragment":"all"},"actions":{"action":"permit"}}}},"G":{"implicitAction":"reject"}}}}'
    ) as Device
    const term = (key: string, ...leaf: string[]) => at('ipv4', 'F', 'terms', key, ...leaf)
    expect(problems(loose)).toEqual([
      ['model.implicit-action', at('ipv4', 'F', 'implicitAction')],
      ['model.position', at('ipv4', 'F', 'terms', '01')],
      ['model.filter-action', term('1', 'actions', 'action')],
      ['model.filter-action', term('2', 'actions', 'action')],
      ['model.number', term('2', 'matches', 'protocols')],
      ['model.port-range', term('2', 'matches', 'sourcePorts')],
      ['model.port-range', term('2', 'matches', 'destinationPorts')],
      ['model.port-range', term('2', 'matches', 'ports')],
      ['model.number', term('2', 'matches', 'icmpTypes')],
      ['model.number', term('2', 'matches', 'icmpCodes')],
      ['model.number', term('2', 'matches', 'dscp')],
      ['model.tcp-flags', term('2', 'matches', 'tcpFlags', 'set')],
      ['model.fragment', term('2', 'matches', 'fragment')],
      ['model.implicit-action', at('ipv4', 'G', 'implicitAction')]
    ])
  })

  it('reports prefixes not in CIDR form or of the other family, and prefix lists the family doesn\'t have', () => {
    const device: Device = {
      routingPolicy: { prefixLists: { ipv4: { V4: {} }, ipv6: { V6: {} } } },
      filters: {
        ipv4: { F: { implicitAction: 'discard', terms: { '1': { matches: { sourcePrefixes: ['10.0.0.1/8'], destinationPrefixes: ['2001:db8::/32'], prefixes: [CANARY], sourcePrefixLists: ['V4'], destinationPrefixLists: ['V6'], prefixLists: [CANARY] }, actions: { action: 'accept' } } } } },
        ipv6: { F6: { implicitAction: 'deny', terms: { '1': { matches: { sourcePrefixes: ['10.0.0.0/8'], sourcePrefixLists: ['V6'] }, actions: { action: 'accept' } } } } }
      }
    }
    const term = (family: string, name: string, leaf: string) => at(family, name, 'terms', '1', 'matches', leaf)
    expect(problems(device)).toEqual([
      ['model.prefix', term('ipv4', 'F', 'sourcePrefixes')],
      ['model.prefix', term('ipv4', 'F', 'destinationPrefixes')],
      ['model.prefix', term('ipv4', 'F', 'prefixes')],
      ['model.unknown-prefix-list', term('ipv4', 'F', 'destinationPrefixLists')],
      ['model.unknown-prefix-list', term('ipv4', 'F', 'prefixLists')],
      ['model.prefix', term('ipv6', 'F6', 'sourcePrefixes')]
    ])
  })

  it('reports a subinterface applying a filter the model doesn\'t have in that family', () => {
    const device: Device = {
      interfaces: { e1: { subinterfaces: { '0': { filters: { ipv4: { input: 'F', output: 'F6' }, ipv6: { input: 'F', output: CANARY } } } } } },
      filters: { ipv4: { F: { implicitAction: 'discard' } }, ipv6: { F6: { implicitAction: 'deny' } } }
    }
    const attached = (family: string, direction: string) => fieldPath('interfaces', 'e1', 'subinterfaces', '0', 'filters', family, direction)
    expect(problems(device)).toEqual([
      ['model.unknown-filter', attached('ipv4', 'output')],
      ['model.unknown-filter', attached('ipv6', 'input')],
      ['model.unknown-filter', attached('ipv6', 'output')]
    ])
    expect(problems({ interfaces: device.interfaces }).map(([code]) => code)).toEqual(Array(4).fill('model.unknown-filter'))
  })
})
