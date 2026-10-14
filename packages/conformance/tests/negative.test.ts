// The kit's negative tests: deliberately careless mappers and renderers that the checks must catch (the build plan's
// two counterexamples, B2). A check that let them through would let a real plugin drop config silently.
import { describe, expect, it } from 'vitest'
import { buildLedger, createRegistry, fieldPath, ledgerProblems, modelProblems, type Device, type PlatformPlugin } from '@dialect/core'
import { checkFixture, type Fixture } from '../src'
import { stubPlugin } from './stubPlatform'

const byCheck = (results: ReturnType<typeof checkFixture>) => Object.fromEntries(results.map((r) => [r.check, r]))

describe('a mapper that handles only host-name, on one line', () => {
  const source = 'system { host-name r1; services { ssh; } }'
  const careless = stubPlugin({ mapRules: ['system', 'host-name'] })

  it('reports system services ssh as unmapped, though line 1 is "covered" by host-name', () => {
    const parsed = careless.parse!(source, { modelVersion: '0.1.0' })
    // The model looks right, and line 1 has a mapped statement on it.
    expect(parsed.model).toEqual({ system: { hostname: 'r1' } })
    expect(parsed.dispositions['system host-name r1']).toEqual({ kind: 'mapped', fields: ['system.hostname'] })
    const ledger = buildLedger(parsed)
    expect(ledger.complete).toBe(false)
    expect(ledger.source.unmapped.map((s) => s.label)).toEqual(['system services', 'system services ssh'])
    expect(ledger.source.unmapped.every((s) => s.span?.startLine === 1)).toBe(true)
  })

  it('fails the kit\'s ledger check, while its parse check passes', () => {
    const fixture: Fixture = { name: 'system/one-line', source, expectedModel: { system: { hostname: 'r1' } } }
    const r = byCheck(checkFixture(careless, fixture))
    expect(r.parse.status).toBe('passed')
    expect(r.ledger.status).toBe('failed')
    expect(r.ledger.problems).toEqual(['unmapped: system services (line 1)', 'unmapped: system services ssh (line 1)'])
  })

  it('a container\'s disposition doesn\'t cover its children: mapping system leaves the rest unmapped', () => {
    const parsed = stubPlugin({ mapRules: ['system'] }).parse!(source, { modelVersion: '0.1.0' })
    expect(buildLedger(parsed).source.unmapped.map((s) => s.label)).toEqual(['system host-name r1', 'system services', 'system services ssh'])
  })

  it('the careful stub accounts for the same line: ssh is unsupported, and nothing is unmapped', () => {
    const parsed = stubPlugin().parse!(source, { modelVersion: '0.1.0' })
    expect(parsed.dispositions['system services ssh']).toMatchObject({ kind: 'unsupported' })
    expect(buildLedger(parsed).source.unmapped).toEqual([])
  })
})

describe('a renderer that handles only a BGP neighbor\'s address and remote AS', () => {
  const source = 'protocols { bgp { neighbor 10.0.0.2 { peer-as 65001; multihop { ttl 2; } } } }'
  const neighbor = fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2')
  const ttl = fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'multihop', 'ttl')
  // It renders the neighbor (its address) and peer-as, and marks the neighbor object as rendered.
  const careless = stubPlugin({ renderSkips: (p) => p.includes('.multihop'), extraRenderDispositions: { [neighbor]: { kind: 'rendered' } } })
  const expectedModel = { networkInstances: { default: { bgp: { neighbors: { '10.0.0.2': { peerAs: 65001, multihop: { ttl: 2 } } } } } } } as Device

  it('reports …neighbors["10.0.0.2"].multihop.ttl as unrendered, though the neighbor object was rendered', () => {
    expect(ttl).toBe('networkInstances.default.bgp.neighbors["10.0.0.2"].multihop.ttl')
    const parsed = careless.parse!(source, { modelVersion: '0.1.0' })
    const rendered = careless.render!(parsed.model, { modelVersion: '0.1.0' })
    expect(rendered.text).toContain('neighbor 10.0.0.2')
    expect(rendered.text).not.toContain('ttl')
    const ledger = buildLedger(parsed, rendered)
    expect(ledger.complete).toBe(false)
    expect(ledger.target?.unrendered.map((f) => f.path)).toEqual([ttl])
    // The object's own disposition covers no leaf: it's reported as stray.
    expect(ledger.target?.strayPaths).toEqual([neighbor])
  })

  it('fails the kit: the ledger check, and the round trip (the reparse lost the ttl)', () => {
    const r = byCheck(checkFixture(careless, { name: 'bgp/multihop', source, expectedModel }))
    expect(r.parse.status).toBe('passed')
    expect(r.ledger.problems).toEqual([`unrendered: ${ttl}`])
    expect(r['round-trip'].status).toBe('failed')
  })

  it('…and again when multihop is a field from a later minor model version the renderer has never heard of', () => {
    // A renderer built for model 0.1.0 still loads under a core at 0.2.0 (minor = additive), and renders the 0.2.0
    // model's neighbor without the new field, because it doesn't know it exists.
    const old = stubPlugin({ modelApi: '>=0.1.0 <1.0.0', renderSkips: (p) => p.includes('.multihop') })
    expect(() => createRegistry([old], { modelVersion: '0.2.0' })).not.toThrow()
    const parsed = old.parse!(source, { modelVersion: '0.2.0' })
    const ledger = buildLedger(parsed, old.render!(parsed.model, { modelVersion: '0.2.0' }))
    expect(ledger.target?.unrendered.map((f) => f.path)).toEqual([ttl])
    const r = byCheck(checkFixture(old, { name: 'bgp/multihop-0.2', source, expectedModel }, { modelVersion: '0.2.0' }))
    expect(r.ledger.problems).toEqual([`unrendered: ${ttl}`])
  })

  it('the careful stub renders the ttl and passes the four model checks', () => {
    const results = checkFixture(stubPlugin(), { name: 'bgp/multihop', source, expectedModel })
    expect(results.filter((r) => r.status === 'failed')).toEqual([])
  })
})

describe('a renderer built for model 0.1 meeting a 0.2 model with DNS set', () => {
  // The stub is built for 0.1: it has never heard of system.dns. A 0.2 source plugin's model reaches it in a conversion.
  const old = stubPlugin({ modelApi: '>=0.1.0 <1.0.0' })
  const model: Device = { system: { hostname: 'r1', dns: { servers: { '192.0.2.53': {}, '198.51.100.53': { networkInstance: 'mgmt' } }, search: ['example.net'] } } }
  const dns = [fieldPath('system', 'dns', 'servers', '192.0.2.53'), fieldPath('system', 'dns', 'servers', '198.51.100.53', 'networkInstance'), fieldPath('system', 'dns', 'search')]

  it('loads, renders what it knows, and the ledger reports every DNS field as unrendered, not dropped', () => {
    expect(() => createRegistry([old], { modelVersion: '0.2.0' })).not.toThrow()
    const parsed = old.parse!('system { host-name r1; }', { modelVersion: '0.2.0' })
    const rendered = old.render!(model, { modelVersion: '0.2.0' })
    expect(rendered.text).toBe('system {\n    host-name r1;\n}\n')
    const ledger = buildLedger(parsed, rendered, model)
    expect(ledger.complete).toBe(false)
    expect(ledger.target?.unrendered.map((f) => f.path)).toEqual(dns)
    expect(ledgerProblems(ledger)).toEqual(dns.map((p) => `unrendered: ${p}`))
  })
})

describe('a renderer built for model 0.2 meeting a 0.3 model with VRF membership, a route distinguisher and route targets', () => {
  // The stub renders addresses but has never heard of 0.3's fields. A 0.3 source plugin's model reaches it.
  const old = stubPlugin({ modelApi: '>=0.2.0 <1.0.0' })
  const model: Device = {
    interfaces: { 'ge-0/0/0': { subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } }, networkInstance: 'blue' } } } },
    networkInstances: { blue: { type: 'vrf', routeDistinguisher: '65000:100', routeTargets: { import: ['65000:100'], export: ['65000:100'] } } }
  }
  const added = [
    fieldPath('interfaces', 'ge-0/0/0', 'subinterfaces', '0', 'networkInstance'),
    fieldPath('networkInstances', 'blue', 'routeDistinguisher'),
    fieldPath('networkInstances', 'blue', 'routeTargets', 'import'),
    fieldPath('networkInstances', 'blue', 'routeTargets', 'export')
  ]

  it('loads, renders the address, and the ledger reports each new field as unrendered, not dropped', () => {
    expect(() => createRegistry([old], { modelVersion: '0.3.0' })).not.toThrow()
    const parsed = old.parse!('system { host-name r1; }', { modelVersion: '0.3.0' })
    const rendered = old.render!(model, { modelVersion: '0.3.0' })
    expect(rendered.text).toContain('address 192.0.2.1/24;')
    const ledger = buildLedger(parsed, rendered, model)
    expect(ledger.complete).toBe(false)
    // `type` is a 0.1 field this stub doesn't render either; the four 0.3 fields are each there.
    expect(ledger.target?.unrendered.map((f) => f.path)).toEqual([added[0], fieldPath('networkInstances', 'blue', 'type'), ...added.slice(1)])
  })
})

describe('a renderer built for model 0.3 meeting a 0.4 model, area by area', () => {
  // The stub renders addresses, static routes and a BGP neighbor's peer AS and multihop, but has never heard of 0.4's
  // VLANs, switch ports, routed VLANs, OSPF or the rest of BGP. A 0.4 source plugin's model reaches it.
  const old = stubPlugin({ modelApi: '>=0.3.0 <1.0.0' })
  const address = { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
  const areas: readonly (readonly [string, Device, readonly string[]])[] = [
    ['VLANs', { vlans: { '10': { name: 'users', description: 'Users' }, '20': {} } }, [fieldPath('vlans', '10', 'name'), fieldPath('vlans', '10', 'description'), fieldPath('vlans', '20')]],
    [
      'switch ports',
      { interfaces: { 'ge-0/0/1': { switching: { mode: 'trunk', allowedVlans: ['10', '20-30'], nativeVlan: 10, accessVlan: 10 } } }, vlans: { '10': { name: 'users' } } },
      ['mode', 'accessVlan', 'allowedVlans', 'nativeVlan'].map((leaf) => fieldPath('interfaces', 'ge-0/0/1', 'switching', leaf)).concat(fieldPath('vlans', '10', 'name'))
    ],
    [
      'IRB/SVI',
      { interfaces: { irb: { type: 'irb-or-svi', subinterfaces: { '10': { ...address, routedVlan: 10 } } } }, vlans: { '10': { name: 'users' } } },
      // `type` is a 0.1 field this stub doesn't render either; routedVlan is 0.4's.
      [fieldPath('interfaces', 'irb', 'type'), fieldPath('interfaces', 'irb', 'subinterfaces', '10', 'routedVlan'), fieldPath('vlans', '10', 'name')]
    ],
    [
      'OSPF',
      {
        interfaces: { 'ge-0/0/0': { subinterfaces: { '0': address } } },
        networkInstances: {
          default: { ospf: { processId: '1', routerId: '192.0.2.1', areas: { '0.0.0.0': { type: 'normal', authentication: 'md5', interfaces: { 'ge-0/0/0.0': { enabledBy: 'interface', passive: true, cost: 10, networkType: 'point-to-point', helloInterval: 5, deadInterval: 20, authentication: 'md5' } } } } } }
        }
      },
      [
        ...['processId', 'routerId'].map((leaf) => fieldPath('networkInstances', 'default', 'ospf', leaf)),
        ...['type', 'authentication'].map((leaf) => fieldPath('networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', leaf)),
        ...['enabledBy', 'passive', 'cost', 'networkType', 'helloInterval', 'deadInterval', 'authentication'].map((leaf) => fieldPath('networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'ge-0/0/0.0', leaf))
      ]
    ],
    [
      'BGP',
      {
        interfaces: { lo0: { subinterfaces: { '0': address } } },
        networkInstances: {
          default: {
            bgp: {
              localAs: 65000,
              routerId: '192.0.2.1',
              groups: { peers: { type: 'external', peerAs: 65001, updateSource: 'lo0.0', multihop: {}, importPolicies: ['IN'], exportPolicies: ['OUT'], authentication: true } },
              neighbors: { '10.0.0.2': { peerAs: 65001, group: 'peers', description: 'transit', localAddress: '192.0.2.1', addressFamilies: { 'ipv4-unicast': {}, 'ipv6-unicast': { importPolicies: ['IN6'] } } } }
            }
          }
        }
      },
      [
        ...['localAs', 'routerId'].map((leaf) => fieldPath('networkInstances', 'default', 'bgp', leaf)),
        ...['type', 'peerAs', 'updateSource', 'multihop', 'importPolicies', 'exportPolicies', 'authentication'].map((leaf) => fieldPath('networkInstances', 'default', 'bgp', 'groups', 'peers', leaf)),
        // The neighbor's peer AS is a field this stub renders; the rest is new to it.
        ...['group', 'description', 'localAddress'].map((leaf) => fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', leaf)),
        fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'addressFamilies', 'ipv4-unicast'),
        fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'addressFamilies', 'ipv6-unicast', 'importPolicies')
      ]
    ]
  ]

  it.each(areas)('%s: loads, and the ledger reports each new field as unrendered, not dropped', (_area, model, added) => {
    expect(() => createRegistry([old], { modelVersion: '0.4.0' })).not.toThrow()
    // A valid 0.4 model: what a careful 0.4 source plugin would give.
    expect(modelProblems(model)).toEqual([])
    const rendered = old.render!(model, { modelVersion: '0.4.0' })
    const ledger = buildLedger(old.parse!('', { modelVersion: '0.4.0' }), rendered, model)
    expect(ledger.complete).toBe(false)
    expect(ledger.target?.unrendered.map((f) => f.path).sort()).toEqual([...added].sort())
  })
})

describe('a parse whose model doesn\'t hold together (core\'s modelProblems())', () => {
  const vrf = fieldPath('interfaces', 'ge-0/0/0', 'subinterfaces', '0', 'networkInstance')

  it('fails the parse check for a subinterface in a VRF the model never declares, though the expected model matches', () => {
    const source = 'interfaces { ge-0/0/0 { unit 0 { vrf blue; } } }'
    const expectedModel: Device = { interfaces: { 'ge-0/0/0': { subinterfaces: { '0': { networkInstance: 'blue' } } } } }
    const r = byCheck(checkFixture(stubPlugin(), { name: 'vrfs/undeclared', source, expectedModel }))
    expect(r.parse.problems).toEqual([`parse made an invalid model: A subinterface names a network instance the model doesn't have. (${vrf})`])
  })

  it('passes it once the VRF is declared', () => {
    const source = 'interfaces { ge-0/0/0 { unit 0 { vrf blue; } } } routing-instances { blue { instance-type vrf; route-distinguisher 65000:1; } }'
    const expectedModel: Device = { interfaces: { 'ge-0/0/0': { subinterfaces: { '0': { networkInstance: 'blue' } } } }, networkInstances: { blue: { type: 'vrf', routeDistinguisher: '65000:1' } } }
    expect(byCheck(checkFixture(stubPlugin(), { name: 'vrfs/declared', source, expectedModel })).parse.status).toBe('passed')
  })

  it('fails it for a route distinguisher in no form the model has, without quoting it', () => {
    const source = 'routing-instances { blue { instance-type vrf; route-distinguisher CANARY_SECRET; } }'
    const expectedModel: Device = { networkInstances: { blue: { type: 'vrf', routeDistinguisher: 'CANARY_SECRET' } } }
    const r = byCheck(checkFixture(stubPlugin(), { name: 'vrfs/bad-rd', source, expectedModel }))
    expect(r.parse.problems).toEqual(['parse made an invalid model: A route distinguisher isn\'t in the form ASN:nn, IP:nn or ASN4:nn. (networkInstances.blue.routeDistinguisher)'])
  })
})

describe('a parse whose 0.4 model names what it doesn\'t have: the referential checks fail the parse check', () => {
  /** A plugin whose parse gives `model`, whatever the text: the expected model matches, so only modelProblems() fails it. */
  const giving = (model: Device): PlatformPlugin => ({ ...stubPlugin(), parse: () => ({ tree: [], model, dispositions: {}, diagnostics: [] }) })
  const address = { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
  const cases: readonly (readonly [string, Device, string, string])[] = [
    ['an access VLAN that doesn\'t exist', { interfaces: { 'ge-0/0/1': { switching: { mode: 'access', accessVlan: 10 } } } }, 'An access VLAN names a VLAN the model doesn\'t have.', fieldPath('interfaces', 'ge-0/0/1', 'switching', 'accessVlan')],
    ['a trunk VLAN that doesn\'t exist', { interfaces: { 'ge-0/0/1': { switching: { mode: 'trunk', allowedVlans: ['10', '20'] } } }, vlans: { '10': {} } }, 'A trunk\'s allowed VLAN names a VLAN the model doesn\'t have.', fieldPath('interfaces', 'ge-0/0/1', 'switching', 'allowedVlans')],
    ['an IRB/SVI with no VLAN', { interfaces: { Vlan10: { type: 'irb-or-svi', subinterfaces: { '0': address } } } }, 'An irb-or-svi interface routes for no VLAN: none of its subinterfaces has a routedVlan.', fieldPath('interfaces', 'Vlan10', 'type')],
    ['an OSPF interface that doesn\'t exist', { networkInstances: { default: { ospf: { areas: { '0.0.0.0': { interfaces: { 'ge-0/0/0.0': {} } } } } } } }, 'An OSPF interface names an interface the model doesn\'t have.', fieldPath('networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'ge-0/0/0.0')],
    ['a BGP update source that doesn\'t exist', { networkInstances: { default: { bgp: { neighbors: { '10.0.0.2': { peerAs: 65001, updateSource: 'Loopback0' } } } } } }, 'A BGP update source names an interface the model doesn\'t have.', fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'updateSource')],
    ['a neighbor in a group that doesn\'t exist', { networkInstances: { default: { bgp: { neighbors: { '10.0.0.2': { peerAs: 65001, group: 'peers' } } } } } }, 'A BGP neighbor is in a group its instance doesn\'t have.', fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '10.0.0.2', 'group')]
  ]

  it.each(cases)('fails it for %s, saying where and quoting nothing', (_what, model, message, field) => {
    const r = byCheck(checkFixture(giving(model), { name: 'phase2/reference', source: '', expectedModel: model }))
    expect(r.parse.problems).toEqual([`parse made an invalid model: ${message} (${field})`])
  })
})

describe('a renderer that drops an NTP server configured with no options', () => {
  const source = 'system { ntp { server 192.0.2.123; } }'
  const server = fieldPath('system', 'ntp', 'servers', '192.0.2.123')
  const expectedModel: Device = { system: { ntp: { servers: { '192.0.2.123': {} } } } }

  it('is caught: the server is unrendered, though it has no leaf below it', () => {
    const careless = stubPlugin({ renderSkips: (p) => p.startsWith('system.ntp') })
    const parsed = careless.parse!(source, { modelVersion: '0.1.0' })
    expect(parsed.model).toEqual(expectedModel)
    const rendered = careless.render!(parsed.model, { modelVersion: '0.1.0' })
    expect(rendered.text).toBe('')
    expect(buildLedger(parsed, rendered).target?.unrendered.map((f) => f.path)).toEqual([server])
    const r = byCheck(checkFixture(careless, { name: 'system/ntp', source, expectedModel }))
    expect(r.ledger.problems).toEqual([`unrendered: ${server}`])
    expect(r['round-trip'].status).toBe('failed')
  })

  it('the careful stub renders it and passes the four model checks', () => {
    const results = checkFixture(stubPlugin(), { name: 'system/ntp', source, expectedModel, expectedRender: 'system {\n    ntp {\n        server 192.0.2.123;\n    }\n}\n' })
    expect(results.filter((r) => r.check !== 'secrets' && r.status !== 'passed')).toEqual([])
  })
})

describe('errors a plugin reports fail their check, even when its output matches', () => {
  const careful = stubPlugin()
  const fixture: Fixture = { name: 'system/hostname', source: 'system { host-name r1; }', expectedModel: { system: { hostname: 'r1' } }, expectedRender: 'system {\n    host-name r1;\n}\n' }
  const with_ = (severity: 'error' | 'warning' | 'info', where: 'render' | 'reparse'): PlatformPlugin => {
    let parses = 0
    return {
      ...careful,
      render: (model, context) => {
        const r = careful.render!(model, context)
        return where === 'render' ? { ...r, diagnostics: [{ severity, message: 'the renderer gave up on something' }] } : r
      },
      // The second parse is the reparse of the render.
      parse: (text, context) => {
        const r = careful.parse!(text, context)
        return where === 'reparse' && ++parses === 2 ? { ...r, diagnostics: [{ severity, category: 'syntax', message: 'the output is invalid' }] } : r
      }
    }
  }

  it('render: an error fails it though the text matches, and fails it when the fixture has no expected render', () => {
    const r = byCheck(checkFixture(with_('error', 'render'), fixture))
    expect(r.render.status).toBe('failed')
    expect(r.render.problems).toEqual(['render error: the renderer gave up on something'])
    const none = byCheck(checkFixture(with_('error', 'render'), { ...fixture, expectedRender: undefined }))
    expect(none.render.status).toBe('failed')
    expect(none.render.problems).toEqual(['render error: the renderer gave up on something'])
  })

  it('round-trip: a reparse error fails it though the model is the same', () => {
    const r = byCheck(checkFixture(with_('error', 'reparse'), fixture))
    expect(r.parse.status).toBe('passed')
    expect(r['round-trip'].status).toBe('failed')
    expect(r['round-trip'].problems).toEqual(['reparse error: the output is invalid'])
  })

  it('warnings and info fail nothing', () => {
    for (const severity of ['warning', 'info'] as const)
      for (const where of ['render', 'reparse'] as const) expect(checkFixture(with_(severity, where), fixture).filter((r) => r.status === 'failed'), `${severity} in ${where}`).toEqual([])
  })
})

describe('the other checks catch what they are for', () => {
  const fixture: Fixture = { name: 'system/hostname', source: 'system { host-name r1; }', expectedModel: { system: { hostname: 'r1' } }, expectedRender: 'system {\n    host-name r1;\n}\n' }

  it('parse: a model that differs from the expected one, with where', () => {
    const r = byCheck(checkFixture(stubPlugin(), { ...fixture, expectedModel: { system: { hostname: 'r2' } } }))
    expect(r.parse.problems).toEqual(['system.hostname: expected "r2", got "r1"'])
  })

  it('parse: a parse error', () => {
    const r = byCheck(checkFixture(stubPlugin(), { ...fixture, source: 'system { host-name r1;' }))
    expect(r.parse.problems[0]).toMatch(/^parse error: stub: /)
  })

  it('render: text that differs from the expected render (line endings aside)', () => {
    expect(byCheck(checkFixture(stubPlugin(), { ...fixture, expectedRender: fixture.expectedRender!.replace(/\n/g, '\r\n') })).render.status).toBe('passed')
    const r = byCheck(checkFixture(stubPlugin(), { ...fixture, expectedRender: 'system {\n    host-name r9;\n}\n' }))
    expect(r.render.status).toBe('failed')
    expect(r.render.problems[0]).toContain('host-name r9')
  })

  it('render is skipped, not failed, for a fixture with no expected render', () => {
    const r = byCheck(checkFixture(stubPlugin(), { ...fixture, expectedRender: undefined }))
    expect(r.render.status).toBe('skipped')
  })

  it('a plugin with no parse or render fails the four model checks, saying which is missing (secrets runs its tools)', () => {
    const { render: _render, ...noRender } = stubPlugin()
    expect(checkFixture(noRender, fixture).map((r) => [r.check, r.status, r.problems])).toEqual([
      ['parse', 'failed', ['the plugin has no render()']],
      ['render', 'failed', ['the plugin has no render()']],
      ['round-trip', 'failed', ['the plugin has no render()']],
      ['ledger', 'failed', ['the plugin has no render()']],
      ['secrets', 'skipped', ['the fixture has no secrets']]
    ])
  })
})
