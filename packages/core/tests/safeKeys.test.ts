// Keys are whatever a configuration says, so `__proto__`, `constructor` and `toString` must be ordinary keys to the
// core: through JSON, field paths and both ledger checks, with nothing read from or written to Object.prototype.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildLedger,
  checkFields,
  checkStatements,
  createRegistry,
  deserializeModel,
  fieldPath,
  MODEL_VERSION,
  modelProblems,
  pathSegments,
  populatedLeaves,
  serializeModel,
  type Device,
  type FieldDisposition,
  type ParseResult,
  type StatementDisposition,
  type SyntaxNode
} from '../src'

const KEYS = ['__proto__', 'constructor', 'toString'] as const

/** Object.prototype as it was before the tests, to show none of them changed it. */
let before: Map<string | symbol, PropertyDescriptor | undefined>
const prototypeNow = () => new Map(Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)]))
beforeAll(() => {
  before = prototypeNow()
})
afterAll(() => {
  expect(prototypeNow()).toEqual(before)
})

/**
 * A model with `key` as an interface, a VRF (with the interface in it), an SNMP community, a DNS server, a VLAN's name,
 * an OSPF interface (a reference to the interface), a BGP group and a neighbor's group, update source and policy, and
 * (model 0.5.0) a policy, prefix list, community set and AS-path set, which the policy's term names. Computed keys are
 * own properties.
 */
const deviceWith = (key: string): Device => ({
  system: {
    snmp: { communities: { [key]: { access: 'read-only' } } },
    dns: { servers: { [key]: {}, '192.0.2.53': { networkInstance: key } }, search: ['example.net'] }
  },
  interfaces: { [key]: { description: 'uplink', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } }, networkInstance: key } } } },
  vlans: { '10': { name: key } },
  networkInstances: {
    [key]: {
      type: 'vrf',
      routeDistinguisher: '65000:1',
      routeTargets: { import: ['65000:1'], export: ['65000:1'] },
      staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { address: '192.0.2.254' } } } },
      ospf: { areas: { '0.0.0.0': { interfaces: { [key]: {} } } } },
      bgp: { groups: { [key]: {} }, neighbors: { '192.0.2.2': { group: key, updateSource: key, importPolicies: [key] } } }
    }
  },
  routingPolicy: {
    prefixLists: { ipv4: { [key]: { entries: { '10': { action: 'permit', prefix: '10.0.0.0/8', minLength: 8, maxLength: 32, form: 'le' } } } } },
    communitySets: { [key]: { entries: { '1': { action: 'permit', members: ['65000:1'] } } } },
    asPathSets: { [key]: { regexDialect: 'junos', entries: { '1': { action: 'permit', regex: '65000 .*' } } } },
    policies: { [key]: { fallThrough: 'reject', terms: { '10': { matches: { prefixLists: { ipv4: [key] }, communitySets: [key], asPathSets: [key] }, actions: { flow: 'accept', communityAdd: { sets: [key] } } } } } }
  }
})

const policyPath = (...path: string[]) => fieldPath('routingPolicy', ...path)

const expectedPaths = (key: string) => [
  fieldPath('system', 'snmp', 'communities', key, 'access'),
  fieldPath('system', 'dns', 'servers', key),
  fieldPath('system', 'dns', 'servers', '192.0.2.53', 'networkInstance'),
  fieldPath('system', 'dns', 'search'),
  fieldPath('interfaces', key, 'description'),
  fieldPath('interfaces', key, 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength'),
  fieldPath('interfaces', key, 'subinterfaces', '0', 'networkInstance'),
  fieldPath('vlans', '10', 'name'),
  fieldPath('networkInstances', key, 'type'),
  fieldPath('networkInstances', key, 'routeDistinguisher'),
  fieldPath('networkInstances', key, 'routeTargets', 'import'),
  fieldPath('networkInstances', key, 'routeTargets', 'export'),
  fieldPath('networkInstances', key, 'staticRoutes', '0.0.0.0/0', 'nextHops', '0', 'address'),
  fieldPath('networkInstances', key, 'ospf', 'areas', '0.0.0.0', 'interfaces', key),
  fieldPath('networkInstances', key, 'bgp', 'groups', key),
  fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'group'),
  fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'updateSource'),
  fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'importPolicies'),
  ...['action', 'prefix', 'minLength', 'maxLength', 'form'].map((leaf) => policyPath('prefixLists', 'ipv4', key, 'entries', '10', leaf)),
  policyPath('communitySets', key, 'entries', '1', 'action'),
  policyPath('communitySets', key, 'entries', '1', 'members'),
  policyPath('asPathSets', key, 'regexDialect'),
  policyPath('asPathSets', key, 'entries', '1', 'action'),
  policyPath('asPathSets', key, 'entries', '1', 'regex'),
  policyPath('policies', key, 'fallThrough'),
  policyPath('policies', key, 'terms', '10', 'matches', 'prefixLists', 'ipv4'),
  policyPath('policies', key, 'terms', '10', 'matches', 'communitySets'),
  policyPath('policies', key, 'terms', '10', 'matches', 'asPathSets'),
  policyPath('policies', key, 'terms', '10', 'actions', 'flow'),
  policyPath('policies', key, 'terms', '10', 'actions', 'communityAdd', 'sets')
]

describe.each(KEYS)('the key %s', (key) => {
  it('is an own key of the model, not its prototype', () => {
    const device = deviceWith(key)
    expect(Object.hasOwn(device.interfaces!, key)).toBe(true)
    expect(Object.getPrototypeOf(device.interfaces)).toBe(Object.prototype)
  })

  it('round-trips through JSON, as an own property, twice over', () => {
    const device = deviceWith(key)
    const once = deserializeModel(serializeModel(device)).device
    const twice = deserializeModel(serializeModel(once)).device
    for (const d of [once, twice]) {
      expect(d).toEqual(device)
      const instance = d.networkInstances![key]
      const policy = d.routingPolicy!
      for (const map of [d.interfaces!, d.networkInstances!, d.system!.snmp!.communities!, d.system!.dns!.servers!, instance.ospf!.areas!['0.0.0.0'].interfaces!, instance.bgp!.groups!, policy.prefixLists!.ipv4!, policy.communitySets!, policy.asPathSets!, policy.policies!]) {
        expect(Object.hasOwn(map, key)).toBe(true)
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
      }
      expect(populatedLeaves(d).map((l) => l.path)).toEqual(expectedPaths(key))
    }
  })

  it('has field paths that read back to the same segments', () => {
    for (const path of expectedPaths(key)) expect(fieldPath(...pathSegments(path))).toBe(path)
    expect(pathSegments(fieldPath('interfaces', key, 'description'))).toEqual(['interfaces', key, 'description'])
  })

  it('is a leaf the model-side check accounts for: rendered when given, unrendered when not', () => {
    const device = deserializeModel(serializeModel(deviceWith(key))).device
    const all = Object.fromEntries(expectedPaths(key).map((p): [string, FieldDisposition] => [p, { kind: 'rendered' }]))
    const full = checkFields(device, all)
    expect(full.unrendered).toEqual([])
    expect(full.strayPaths).toEqual([])
    // An empty dispositions record has `toString` and `constructor` on its prototype: they must not count.
    expect(checkFields(device, {}).unrendered.map((f) => f.path)).toEqual(expectedPaths(key))
  })

  it('is a statement id the source-side check accounts for, and the ledger is complete only when it has one', () => {
    const tree: SyntaxNode[] = [{ id: key, label: `interfaces ${key}`, children: [{ id: `${key} description`, label: `interfaces ${key} description uplink` }] }]
    const dispositions: Record<string, StatementDisposition> = Object.fromEntries([
      [key, { kind: 'mapped', fields: [] }],
      [`${key} description`, { kind: 'mapped', fields: [fieldPath('interfaces', key, 'description')] }]
    ])
    expect(checkStatements(tree, {}).unmapped.map((s) => s.id)).toEqual([key, `${key} description`])
    const model: Device = { interfaces: { [key]: { description: 'uplink' } } }
    const parse: ParseResult = { tree, model, dispositions, diagnostics: [] }
    const ledger = buildLedger(parse, { text: '', dispositions: Object.fromEntries([[fieldPath('interfaces', key, 'description'), { kind: 'rendered' }]]), diagnostics: [] })
    expect(ledger.source.strayIds).toEqual([])
    expect(ledger.complete).toBe(true)
  })

  it('is a VRF a subinterface can name: modelProblems() finds it as an own key, and misses it when it isn\'t one', () => {
    const device = deviceWith(key)
    expect(modelProblems(device)).toEqual([])
    expect(modelProblems(deserializeModel(serializeModel(device)).device)).toEqual([])
    // Declared under another name only: `key` must not be found on Object.prototype (`toString`, `constructor`).
    const { [key]: vrf, ...others } = device.networkInstances!
    const undeclared: Device = { ...device, networkInstances: { ...others, blue: vrf } }
    expect(modelProblems(undeclared).map((d) => d.code)).toEqual(['model.unknown-network-instance'])
    expect(modelProblems({ interfaces: device.interfaces }).map((d) => d.field)).toEqual([fieldPath('interfaces', key, 'subinterfaces', '0', 'networkInstance')])
    const nullProto = Object.assign(Object.create(null), { blue: vrf }) as Device['networkInstances']
    expect(modelProblems({ ...device, networkInstances: nullProto }).map((d) => d.code)).toEqual(['model.unknown-network-instance'])
  })

  it('is a BGP group a neighbor can name, and an interface an OSPF interface and an update source name, by own keys only', () => {
    const device = deviceWith(key)
    const bgp = device.networkInstances![key].bgp!
    // The group declared under another name: `key` must not be found on Object.prototype.
    const regrouped: Device = { ...device, networkInstances: { [key]: { ...device.networkInstances![key], bgp: { ...bgp, groups: { peers: {} } } } } }
    expect(modelProblems(regrouped).map((d) => [d.code, d.field])).toEqual([['model.unknown-bgp-group', fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'group')]])
    // The interface renamed: the OSPF interface and the update source name nothing (the subinterface's VRF is still fine).
    const { [key]: ifc } = device.interfaces!
    const renamed: Device = { ...device, interfaces: { eth0: ifc } }
    expect(modelProblems(renamed).map((d) => [d.code, d.field])).toEqual([
      ['model.unknown-interface', fieldPath('networkInstances', key, 'ospf', 'areas', '0.0.0.0', 'interfaces', key)],
      ['model.unknown-interface', fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'updateSource')]
    ])
    const nullProto = Object.assign(Object.create(null), { eth0: ifc }) as Device['interfaces']
    expect(modelProblems({ ...device, interfaces: nullProto }).map((d) => d.code)).toEqual(['model.unknown-interface', 'model.unknown-interface'])
  })

  it('is a policy, prefix list and set a BGP peer or a term names, by own keys only', () => {
    const device = deviceWith(key)
    const policy = device.routingPolicy!
    // Each declared under another name only: `key` must not be found on Object.prototype.
    const setsRenamed: Device = {
      ...device,
      routingPolicy: { prefixLists: { ipv4: { other: policy.prefixLists!.ipv4![key] } }, communitySets: { other: policy.communitySets![key] }, asPathSets: { other: policy.asPathSets![key] }, policies: policy.policies }
    }
    const renamed: Device = { ...device, routingPolicy: { ...policy, policies: { other: policy.policies![key] } } }
    const term = (...path: string[]) => policyPath('policies', key, 'terms', '10', ...path)
    expect(modelProblems(setsRenamed).map((d) => [d.code, d.field])).toEqual([
      ['model.unknown-prefix-list', term('matches', 'prefixLists', 'ipv4')],
      ['model.unknown-community-set', term('matches', 'communitySets')],
      ['model.unknown-as-path-set', term('matches', 'asPathSets')],
      ['model.unknown-community-set', term('actions', 'communityAdd', 'sets')]
    ])
    expect(modelProblems(renamed).map((d) => [d.code, d.field])).toEqual([['model.unknown-policy', fieldPath('networkInstances', key, 'bgp', 'neighbors', '192.0.2.2', 'importPolicies')]])
    expect(modelProblems(renamed, { policyReferences: false })).toEqual([])
    const nullProto = Object.assign(Object.create(null), { other: policy.policies![key] }) as NonNullable<Device['routingPolicy']>['policies']
    expect(modelProblems({ ...device, routingPolicy: { ...policy, policies: nullProto } }).map((d) => d.code)).toEqual(['model.unknown-policy'])
  })

  it('works in null-prototype maps too', () => {
    const interfaces: Record<string, unknown> = Object.create(null)
    interfaces[key] = Object.assign(Object.create(null), { description: 'uplink' })
    const device = { interfaces } as Device
    expect(populatedLeaves(device).map((l) => l.path)).toEqual([fieldPath('interfaces', key, 'description')])
    expect(deserializeModel(serializeModel(device)).device).toEqual({ interfaces: { [key]: { description: 'uplink' } } })
  })
})

describe('a model document', () => {
  it('reads its fields as own properties only', () => {
    expect(() => deserializeModel(Object.create({ modelVersion: MODEL_VERSION, device: {} }))).toThrow('The model document has no valid modelVersion (undefined).')
  })
})

describe('model 0.5', () => {
  it('is the core\'s model version, and plugins built for 0.1 to 0.4.1 still load', () => {
    expect(MODEL_VERSION).toBe('0.5.0')
    for (const modelApi of ['>=0.1.0 <1.0.0', '>=0.2.0 <1.0.0', '>=0.3.0 <1.0.0', '>=0.4.0 <1.0.0', '>=0.4.1 <1.0.0'])
      expect(() => createRegistry([{ id: 'old', name: 'Old', modelApi, capabilities: { system: { parse: 'full', render: 'full' } } }]), modelApi).not.toThrow()
  })

  it('reads 0.3.0 documents, and a 0.3 core refuses a 0.5 one rather than drop its fields', () => {
    expect(deserializeModel('{"modelVersion":"0.3.0","device":{"networkInstances":{"blue":{"type":"vrf","routeDistinguisher":"65000:1"}}}}').device).toEqual({ networkInstances: { blue: { type: 'vrf', routeDistinguisher: '65000:1' } } })
    const text = serializeModel({ vlans: { '10': { name: 'users' } } })
    expect(JSON.parse(text).modelVersion).toBe('0.5.0')
    expect(() => deserializeModel(text, '0.3.0')).toThrow('The model document was made with model 0.5.0, newer than this core\'s 0.3.0.')
  })

  it('reads 0.4.0 and 0.4.1 documents, and a 0.4.1 core refuses a 0.5.0 one rather than drop its routing policy', () => {
    expect(deserializeModel('{"modelVersion":"0.4.0","device":{"vlans":{"10":{"name":"users"}}}}').device).toEqual({ vlans: { '10': { name: 'users' } } })
    const bgp = { localAs: 65000, ebgpDefaultPolicy: { import: 'reject', export: 'reject' } }
    expect(deserializeModel(JSON.stringify({ modelVersion: '0.4.1', device: { networkInstances: { default: { bgp } } } })).device.networkInstances?.default.bgp).toEqual(bgp)
    const text = serializeModel({ routingPolicy: { policies: { IN: { fallThrough: 'reject', terms: { '10': { actions: { flow: 'accept' } } } } } } })
    expect(deserializeModel(text).device.routingPolicy?.policies?.IN.terms?.['10'].actions).toEqual({ flow: 'accept' })
    expect(() => deserializeModel(text, '0.4.1')).toThrow('The model document was made with model 0.5.0, newer than this core\'s 0.4.1.')
  })

  it('has VLANs, switch ports, routed VLANs, OSPF and BGP as leaves, through JSON and with nothing wrong', () => {
    const device: Device = {
      interfaces: {
        'ge-0/0/1': { switching: { mode: 'trunk', allowedVlans: ['10', '20-30'], nativeVlan: 10 } },
        irb: { type: 'irb-or-svi', subinterfaces: { '10': { routedVlan: 10, ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } },
        lo0: { subinterfaces: { '0': {} } }
      },
      vlans: { '10': { name: 'users', description: 'Users' }, '20': {} },
      networkInstances: {
        default: {
          ospf: { processId: '1', routerId: '192.0.2.1', areas: { '0.0.0.0': { type: 'nssa', interfaces: { 'irb.10': { passive: true, enabledBy: 'network' } } } } },
          bgp: { localAs: 4200000000, groups: { peers: { type: 'internal', updateSource: 'lo0.0' } }, neighbors: { '2001:db8::2': { group: 'peers', multihop: {}, addressFamilies: { 'ipv6-unicast': {} }, authentication: true } } }
        }
      }
    }
    const ospf = ['networkInstances', 'default', 'ospf'] as const
    const bgp = ['networkInstances', 'default', 'bgp'] as const
    expect(populatedLeaves(device).map((l) => l.path)).toEqual([
      fieldPath('interfaces', 'ge-0/0/1', 'switching', 'mode'),
      fieldPath('interfaces', 'ge-0/0/1', 'switching', 'allowedVlans'),
      fieldPath('interfaces', 'ge-0/0/1', 'switching', 'nativeVlan'),
      fieldPath('interfaces', 'irb', 'type'),
      fieldPath('interfaces', 'irb', 'subinterfaces', '10', 'routedVlan'),
      fieldPath('interfaces', 'irb', 'subinterfaces', '10', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength'),
      fieldPath('interfaces', 'lo0', 'subinterfaces', '0'),
      fieldPath('vlans', '10', 'name'),
      fieldPath('vlans', '10', 'description'),
      fieldPath('vlans', '20'),
      fieldPath(...ospf, 'processId'),
      fieldPath(...ospf, 'routerId'),
      fieldPath(...ospf, 'areas', '0.0.0.0', 'type'),
      fieldPath(...ospf, 'areas', '0.0.0.0', 'interfaces', 'irb.10', 'passive'),
      fieldPath(...ospf, 'areas', '0.0.0.0', 'interfaces', 'irb.10', 'enabledBy'),
      fieldPath(...bgp, 'localAs'),
      fieldPath(...bgp, 'groups', 'peers', 'type'),
      fieldPath(...bgp, 'groups', 'peers', 'updateSource'),
      fieldPath(...bgp, 'neighbors', '2001:db8::2', 'group'),
      fieldPath(...bgp, 'neighbors', '2001:db8::2', 'multihop'),
      fieldPath(...bgp, 'neighbors', '2001:db8::2', 'addressFamilies', 'ipv6-unicast'),
      fieldPath(...bgp, 'neighbors', '2001:db8::2', 'authentication')
    ])
    expect(deserializeModel(serializeModel(device)).device).toEqual(device)
    expect(modelProblems(device)).toEqual([])
  })
})

describe('model 0.3.0', () => {
  it('reads 0.2.0 documents, and a 0.2 core refuses a 0.3 one rather than drop its fields', () => {
    expect(deserializeModel('{"modelVersion":"0.2.0","device":{"system":{"dns":{"search":["example.net"]}}}}').device).toEqual({ system: { dns: { search: ['example.net'] } } })
    const text = serializeModel({ interfaces: { eth0: { subinterfaces: { '0': { networkInstance: 'blue' } } } }, networkInstances: { blue: { type: 'vrf' } } }, '0.3.0')
    expect(JSON.parse(text).modelVersion).toBe('0.3.0')
    expect(() => deserializeModel(text, '0.2.0')).toThrow('The model document was made with model 0.3.0, newer than this core\'s 0.2.0.')
  })

  it('has a subinterface\'s VRF, and a VRF\'s type, route distinguisher and route targets as leaves', () => {
    const device: Device = {
      interfaces: { 'ge-0/0/0': { subinterfaces: { '0': { networkInstance: 'blue' } } } },
      networkInstances: { blue: { type: 'vrf', routeDistinguisher: '65000:100', routeTargets: { import: ['65000:100', '65000:200'], export: ['65000:100'] } }, lab: { type: 'virtual-router' } }
    }
    expect(populatedLeaves(device)).toEqual([
      { path: 'interfaces["ge-0/0/0"].subinterfaces["0"].networkInstance', value: 'blue' },
      { path: 'networkInstances.blue.type', value: 'vrf' },
      { path: 'networkInstances.blue.routeDistinguisher', value: '65000:100' },
      { path: 'networkInstances.blue.routeTargets.import', value: ['65000:100', '65000:200'] },
      { path: 'networkInstances.blue.routeTargets.export', value: ['65000:100'] },
      { path: 'networkInstances.lab.type', value: 'virtual-router' }
    ])
    expect(deserializeModel(serializeModel(device)).device).toEqual(device)
    expect(modelProblems(device)).toEqual([])
  })
})

describe('model 0.2.0', () => {
  it('reads 0.1.0 documents', () => {
    expect(deserializeModel('{"modelVersion":"0.1.0","device":{"system":{"hostname":"r1"}}}').device).toEqual({ system: { hostname: 'r1' } })
  })

  it('has DNS servers, by address in source order, and search domains as a leaf-list', () => {
    const device: Device = { system: { dns: { servers: { '192.0.2.53': {}, '198.51.100.53': { networkInstance: 'mgmt' } }, search: ['example.net', 'example.org'] } } }
    expect(populatedLeaves(device)).toEqual([
      { path: 'system.dns.servers["192.0.2.53"]', value: {} },
      { path: 'system.dns.servers["198.51.100.53"].networkInstance', value: 'mgmt' },
      { path: 'system.dns.search', value: ['example.net', 'example.org'] }
    ])
    expect(Object.keys(deserializeModel(serializeModel(device)).device.system!.dns!.servers!)).toEqual(['192.0.2.53', '198.51.100.53'])
  })
})
