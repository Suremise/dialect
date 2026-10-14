// OSPF and BGP beyond the conformance fixtures (tests/fixtures/conformance/ospf, bgp): the semantic warnings, each from a
// saved model of another platform (tests/fixtures/semantic/<code>.model.json raises junos.<code>); keys asked for, never
// carried or made up, and written from the user's answer; what Junos refuses (a neighbor in two groups); router IDs and
// AS numbers kept with the protocols; a model from another platform rendered in Junos terms; and aggregate names
// suggested for convert. Messages say where by line, never by an address, a group's name or a key.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildLedger, deserializeModel, ledgerProblems, modelProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin, { bgpKeyInputId, ospfKeyInputId, parse, render } from '../src'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
const kinds = (p: ParseResult): string[] => Object.values(p.dispositions).map((d) => d.kind)
const errors = (p: ParseResult) => p.diagnostics.filter((d) => d.severity === 'error')

/** Every message a parse or a render gives: reasons, diagnostics and needs-input items. */
const told = (p: ParseResult | undefined, r?: RenderResult): string[] => [
  ...Object.values(p?.dispositions ?? {}).flatMap((d) => (d.kind === 'mapped' ? [] : [d.reason ?? ''])),
  ...(p?.diagnostics ?? []).map((d) => d.message),
  ...Object.values(r?.dispositions ?? {}).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])),
  ...(r?.diagnostics ?? []).map((d) => d.message),
  ...(r?.needsInput ?? []).flatMap((n) => [n.message, ...(n.suggestions ?? [])])
]

describe('semantic warnings, each from a saved model', () => {
  const dir = fileURLToPath(new URL('./fixtures/semantic/', import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.model.json'))

  it('has one for each semantic warning the render raises', () => {
    expect(files.map((f) => f.replace('.model.json', '')).sort()).toEqual(['ebgp-default-policy', 'filter-implicit-action', 'ospf-enabled-by-network', 'policy-fall-through', 'vrf-policy-mode'])
  })
  for (const file of files) {
    const code = `junos.${file.replace('.model.json', '')}`
    it(`${file} raises ${code}, naming no address, and the ledger is complete`, () => {
      const model = deserializeModel(readFileSync(`${dir}${file}`, 'utf8')).device
      expect(modelProblems(model)).toEqual([])
      const r = render(model, context)
      const raised = r.diagnostics.filter((d) => d.code === code)
      expect(raised).toHaveLength(1)
      expect(raised[0]).toMatchObject({ severity: 'warning', category: 'semantic' })
      expect(raised[0].message).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
      expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
    })
  }

  it("the eBGP default policy names the bgp statement's line, and Junos's own default raises nothing", () => {
    const model = deserializeModel(readFileSync(fileURLToPath(new URL('./fixtures/semantic/ebgp-default-policy.model.json', import.meta.url)), 'utf8')).device
    const r = render(model, context)
    const warning = r.diagnostics.find((d) => d.code === 'junos.ebgp-default-policy')!
    expect(r.text.split('\n')[warning.span!.startLine - 1]).toBe('    bgp {')
    expect(warning.message).toContain(`(line ${warning.span!.startLine})`)
    expect(r.dispositions['networkInstances.default.bgp.ebgpDefaultPolicy.import']).toMatchObject({ kind: 'not-applicable' })
    const own = { networkInstances: { default: { bgp: { ...model.networkInstances!.default.bgp!, ebgpDefaultPolicy: { import: 'accept', export: 'accept' } } } } } satisfies Device
    expect(render(own, context).diagnostics.map((d) => d.code)).not.toContain('junos.ebgp-default-policy')
  })

  it('a Junos parse gives its own default, accept, for the sides an eBGP peer without a policy has', () => {
    const p = parse(set('set routing-options autonomous-system 65000', 'set protocols bgp group I type internal', 'set protocols bgp group I neighbor 192.0.2.1', 'set protocols bgp group E peer-as 64500', 'set protocols bgp group E import IN', 'set protocols bgp group E neighbor 192.0.2.2', 'set protocols bgp group E neighbor 192.0.2.3 export OUT', 'set policy-options policy-statement IN then accept', 'set policy-options policy-statement OUT then accept'), context)
    expect(p.model.networkInstances?.default.bgp?.ebgpDefaultPolicy).toEqual({ export: 'accept' })
    const internal = parse(set('set routing-options autonomous-system 65000', 'set protocols bgp group I peer-as 65000', 'set protocols bgp group I neighbor 192.0.2.1'), context)
    expect(internal.model.networkInstances?.default.bgp?.ebgpDefaultPolicy).toBeUndefined()
  })

  it('import and export policies resolve to the policies converted; names alone, from a model without their bodies, raise a warning', () => {
    const p = parse(set('set protocols bgp group E import IN', 'set protocols bgp group E export OUT', 'set policy-options policy-statement IN then accept'), context)
    expect(p.model.networkInstances?.default.bgp?.groups?.E).toEqual({ importPolicies: ['IN'] })
    expect(p.dispositions.L2).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining("names a policy the configuration doesn't define") })
    expect(p.diagnostics).toEqual([])
    expect(render(p.model, context).diagnostics).toEqual([])
    const named = { networkInstances: { default: { bgp: { groups: { E: { importPolicies: ['IN'] } } } } } }
    expect(render(named, context).diagnostics.map((d) => d.code)).toEqual(['junos.policy-by-name'])
  })
})

describe('keys', () => {
  const source = set(
    'set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24',
    'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication md5 1 key "$9$PLACEHOLDER-OSPF"',
    'set protocols bgp group G authentication-key "$9$PLACEHOLDER-BGP"',
    'set protocols bgp group G neighbor 192.0.2.2 peer-as 64500'
  )

  it('are flagged, never carried: the model and every message are without them', () => {
    const p = parse(source, context)
    expect(p.model.networkInstances?.default.ospf?.areas?.['0.0.0.0'].interfaces?.['ge-0/0/0.0'].authentication).toBe('md5')
    expect(p.model.networkInstances?.default.bgp?.groups?.G.authentication).toBe(true)
    expect(JSON.stringify(p.model)).not.toContain('PLACEHOLDER')
    const r = render(p.model, context)
    for (const text of [...told(p, r), r.text]) expect(text).not.toContain('PLACEHOLDER')
  })

  it('are asked for as secrets, never made up, and the round trip excuses only them', () => {
    const p = parse(source, context)
    const r = render(p.model, context)
    expect(r.needsInput?.map((n) => [n.id, n.kind, n.field])).toEqual([
      [ospfKeyInputId('default', '0.0.0.0', 'ge-0/0/0.0'), 'secret', 'networkInstances.default.ospf.areas["0.0.0.0"].interfaces["ge-0/0/0.0"].authentication'],
      [bgpKeyInputId('default', 'group', 'G'), 'secret', 'networkInstances.default.bgp.groups.G.authentication']
    ])
    expect(r.text).not.toMatch(/authentication|md5|simple-password/)
    const roundTrip = checkFixture(plugin, { name: 'keys', source, expectedModel: p.model, secrets: ['$9$PLACEHOLDER-OSPF', '$9$PLACEHOLDER-BGP'] }).find((c) => c.check === 'round-trip')!
    expect(roundTrip).toMatchObject({ status: 'passed', deferred: ['networkInstances.default.ospf.areas["0.0.0.0"].interfaces["ge-0/0/0.0"].authentication', 'networkInstances.default.bgp.groups.G.authentication'] })
  })

  it("are written from the user's answers, and a key chain or an answer left empty is not", () => {
    const model: Device = {
      interfaces: { 'ge-0/0/0': { subinterfaces: { '0': {} } }, 'ge-0/0/1': { subinterfaces: { '0': {} } }, 'ge-0/0/2': { subinterfaces: { '0': {} } } },
      networkInstances: {
        default: {
          ospf: { areas: { '0.0.0.0': { interfaces: { 'ge-0/0/0.0': { authentication: 'md5' }, 'ge-0/0/1.0': { authentication: 'simple' }, 'ge-0/0/2.0': { authentication: 'key-chain' } } } } },
          bgp: { neighbors: { '192.0.2.2': { peerAs: 64500, authentication: true } } }
        }
      }
    }
    const inputs = { [ospfKeyInputId('default', '0.0.0.0', 'ge-0/0/0.0')]: 'K1', [ospfKeyInputId('default', '0.0.0.0', 'ge-0/0/1.0')]: 'K2', [bgpKeyInputId('default', 'neighbor', '192.0.2.2')]: '' }
    const r = render(model, { ...context, inputs })
    expect(r.text).toContain('interface ge-0/0/0.0 {\n                authentication {\n                    md5 1 key K1;\n                }\n            }')
    expect(r.text).toContain('authentication {\n                    simple-password K2;\n                }')
    expect(r.dispositions['networkInstances.default.ospf.areas["0.0.0.0"].interfaces["ge-0/0/2.0"].authentication']).toMatchObject({ kind: 'unsupported', reason: 'OSPF key chains come later on Junos' })
    expect(r.needsInput?.map((n) => n.id)).toEqual([bgpKeyInputId('default', 'neighbor', '192.0.2.2')])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})

describe('what Junos refuses, and what converts not at all', () => {
  it('a neighbor in two groups is an error, in neither', () => {
    const p = parse(set('set protocols bgp group A neighbor 192.0.2.2 peer-as 64500', 'set protocols bgp group B neighbor 192.0.2.2 peer-as 64501', 'set protocols bgp group B neighbor 192.0.2.3 peer-as 64502'), context)
    expect(Object.keys(p.model.networkInstances!.default.bgp!.neighbors!)).toEqual(['192.0.2.3'])
    expect(kinds(p)).toEqual(['unsupported', 'unsupported', 'mapped'])
    expect(errors(p).map((d) => [d.code, d.message])).toEqual([['junos.bgp-neighbor-twice', 'A BGP neighbor is in two groups: Junos accepts it in one only (lines 1, 2).']])
  })

  it('a router ID or an AS number with no protocol to keep it is unsupported', () => {
    const p = parse(set('set routing-options router-id 192.0.2.1', 'set routing-options autonomous-system 65000'), context)
    expect(p.model).toEqual({})
    expect(kinds(p)).toEqual(['unsupported', 'unsupported'])
    const ospf = parse(set('set interfaces lo0 unit 0 family inet address 192.0.2.1/32', 'set routing-options router-id 192.0.2.1', 'set routing-options autonomous-system 65000', 'set protocols ospf area 0 interface lo0.0 passive'), context)
    expect(ospf.model.networkInstances?.default.ospf?.routerId).toBe('192.0.2.1')
    expect(kinds(ospf)).toEqual(['mapped', 'mapped', 'unsupported', 'mapped'])
  })

  it("an OSPF interface the configuration doesn't have, or doesn't convert, is unsupported and out of the model", () => {
    const p = parse(set('set protocols ospf area 0 interface ge-0/0/9.0', 'set interfaces irb unit 5 family inet address 192.0.2.1/24', 'set protocols ospf area 0 interface irb.5'), context)
    expect(p.model).toEqual({})
    expect(errors(p)).toEqual([])
  })

  it('a peer with no setting that converts is not in the model', () => {
    const p = parse(set('set protocols bgp group G neighbor 192.0.2.2 peer-as 4294967296', 'set protocols bgp group G bfd-liveness-detection minimum-interval 300'), context)
    expect(p.model).toEqual({})
  })
})

describe('an OSPF area or interface whose type is not converted', () => {
  const ge = 'set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24'
  const areaOf = (p: ParseResult, id: string) => p.model.networkInstances?.default?.ospf?.areas?.[id]

  it.each([['stub no-summaries'], ['stub default-metric 10'], ['nssa no-summaries'], ['nssa default-lsa default-metric 10']])('a %s area converts not at all, its interfaces neither: never a normal area', (options) => {
    const p = parse(set(ge, `set protocols ospf area 1 ${options}`, 'set protocols ospf area 1 interface ge-0/0/0.0 passive', 'set protocols ospf area 0 interface lo0.0'), context)
    expect(areaOf(p, '0.0.0.1')).toBeUndefined()
    expect(kinds(p).slice(1, 3)).toEqual(['unsupported', 'unsupported'])
    expect(Object.values(p.dispositions)[2]).toMatchObject({ reason: "the area is a stub or NSSA with options that aren't converted, so none of it is" })
  })

  it('keeps an option with its type: a bare stub beside stub no-summaries, before, after or over a group, leaves it in force', () => {
    const area1 = (...lines: string[]) => areaOf(parse(set(ge, ...lines, 'set protocols ospf area 1 interface ge-0/0/0.0'), context), '0.0.0.1')
    expect(area1('set protocols ospf area 1 stub', 'set protocols ospf area 1 stub no-summaries')).toBeUndefined()
    expect(area1('set protocols ospf area 1 stub no-summaries', 'set protocols ospf area 1 stub')).toBeUndefined()
    // A group's stub with options, and the configuration's own bare stub: the option is still inherited.
    expect(area1('set groups G protocols ospf area 1 stub no-summaries', 'set apply-groups G', 'set protocols ospf area 1 stub')).toBeUndefined()
    // The configuration's nssa with options over a group's stub: an NSSA with options, not converted.
    expect(area1('set groups G protocols ospf area 1 stub', 'set apply-groups G', 'set protocols ospf area 1 nssa no-summaries')).toBeUndefined()
  })

  it("converts the area when the winning type has no option: the other type's options went with it, or were deleted", () => {
    const area1 = (...lines: string[]) => areaOf(parse(set(ge, ...lines, 'set protocols ospf area 1 interface ge-0/0/0.0'), context), '0.0.0.1')
    const stub = { type: 'stub', interfaces: { 'ge-0/0/0.0': { enabledBy: 'interface' } } }
    // The configuration's stub over a group's nssa with options: a plain stub, the NSSA's option not its.
    expect(area1('set groups G protocols ospf area 1 nssa no-summaries', 'set apply-groups G', 'set protocols ospf area 1 stub')).toEqual(stub)
    // In set form, a later stub replaces an nssa and its options.
    expect(area1('set protocols ospf area 1 nssa no-summaries', 'set protocols ospf area 1 stub')).toEqual(stub)
    // Deleting the option leaves the stub.
    expect(area1('set protocols ospf area 1 stub no-summaries', 'set protocols ospf area 1 stub', 'delete protocols ospf area 1 stub no-summaries')).toEqual(stub)
    // apply-groups-except keeps the group's option off the area.
    expect(area1('set groups G protocols ospf area 1 stub no-summaries', 'set apply-groups G', 'set protocols ospf area 1 stub', 'set protocols ospf area 1 apply-groups-except G')).toEqual(stub)
  })

  it('an interface whose network type is one the model has no word for converts not at all, never as broadcast', () => {
    const p = parse(set(ge, 'set protocols ospf area 0 interface ge-0/0/0.0 metric 10', 'set protocols ospf area 0 interface ge-0/0/0.0 interface-type nbma', 'set protocols ospf area 0 interface lo0.0'), context)
    expect(p.model.networkInstances).toBeUndefined()
    expect(kinds(p).slice(1)).toEqual(['unsupported', 'unsupported', 'unsupported'])
    // A p2p that wins over a group's nbma converts.
    const p2p = parse(set(ge, 'set groups G protocols ospf area 0 interface ge-0/0/0.0 interface-type nbma', 'set apply-groups G', 'set protocols ospf area 0 interface ge-0/0/0.0 interface-type p2p'), context)
    expect(areaOf(p2p, '0.0.0.0')?.interfaces?.['ge-0/0/0.0']).toEqual({ enabledBy: 'interface', networkType: 'point-to-point' })
  })
})

describe('BGP neighbors without a group, from another platform', () => {
  it('go in groups of their own, never in a model group of the same name, inheriting nothing of it', () => {
    const peer = { type: 'external', peerAs: 64500, importPolicies: ['BLOCK'], localAddress: '192.0.2.1', authentication: true } as const
    const model: Device = {
      networkInstances: {
        default: {
          bgp: {
            localAs: 65000,
            groups: { ibgp: peer, ebgp: peer, peers: peer, 'ibgp-2': peer },
            neighbors: { '192.0.2.2': { peerAs: 65000 }, '192.0.2.3': { peerAs: 64501 }, '192.0.2.4': {}, '192.0.2.5': { peerAs: 65000 }, '192.0.2.6': { group: 'ebgp', peerAs: 64502 } }
          }
        }
      }
    }
    const r = render(model, context)
    const reparsed = parse(r.text, context).model.networkInstances!.default.bgp!
    expect(Object.fromEntries(Object.entries(reparsed.neighbors!).map(([address, n]) => [address, n.group]))).toEqual({ '192.0.2.6': 'ebgp', '192.0.2.2': 'ibgp-3', '192.0.2.5': 'ibgp-3', '192.0.2.3': 'ebgp-2', '192.0.2.4': 'peers-2' })
    for (const name of ['ibgp-3', 'ebgp-2', 'peers-2']) expect(reparsed.groups![name]).toEqual({})
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})

describe('render from another platform', () => {
  it("writes OSPF and BGP in Junos terms, saying what it can't", () => {
    const model: Device = {
      interfaces: { Loopback0: { subinterfaces: { '0': {} } } },
      networkInstances: {
        default: {
          ospf: { processId: '1', routerId: '192.0.2.1', areas: { '0.0.0.0': { type: 'normal', authentication: 'key-chain', interfaces: { 'Loopback0.0': { enabledBy: 'interface', networkType: 'broadcast', passive: false } } } } },
          bgp: {
            localAs: 65000,
            routerId: '192.0.2.9',
            groups: { PEERS: { updateSource: 'Loopback0.0', addressFamilies: { 'ipv4-unicast': { importPolicies: ['V4-IN'] } } } },
            neighbors: { '192.0.2.2': { peerAs: 65000 }, '192.0.2.3': { peerAs: 64500 }, '192.0.2.4': {}, '192.0.2.5': { group: 'PEERS', peerAs: 64501 } }
          }
        }
      }
    }
    const r = render(model, context)
    expect(r.text).toContain('routing-options {\n    router-id 192.0.2.1;\n    autonomous-system 65000;\n}\n')
    expect(r.text).toContain('        group PEERS {\n            family inet {\n                unicast;\n            }\n            neighbor 192.0.2.5 {\n                peer-as 64501;\n            }\n        }\n')
    expect(r.text).toContain('        group ibgp {\n            neighbor 192.0.2.2 {\n                peer-as 65000;\n            }\n        }\n        group ebgp {\n            neighbor 192.0.2.3 {\n                peer-as 64500;\n            }\n        }\n        group peers {\n            neighbor 192.0.2.4;\n        }\n')
    const why = (path: string) => r.dispositions[path]
    expect(why('networkInstances.default.ospf.processId')).toMatchObject({ kind: 'not-applicable' })
    expect(why('networkInstances.default.bgp.routerId')).toMatchObject({ kind: 'unsupported', reason: "Junos has one router ID per routing instance, and OSPF's is another" })
    expect(why('networkInstances.default.ospf.areas["0.0.0.0"].type')).toMatchObject({ kind: 'not-applicable' })
    expect(why('networkInstances.default.ospf.areas["0.0.0.0"].authentication')).toMatchObject({ kind: 'unsupported' })
    expect(why('networkInstances.default.ospf.areas["0.0.0.0"].interfaces["Loopback0.0"].networkType')).toMatchObject({ kind: 'not-applicable' })
    expect(why('networkInstances.default.bgp.groups.PEERS.updateSource')).toMatchObject({ kind: 'unsupported', reason: 'Junos sources a BGP session from an address (local-address), not an interface' })
    expect(why('networkInstances.default.bgp.groups.PEERS.addressFamilies["ipv4-unicast"].importPolicies')).toMatchObject({ kind: 'unsupported' })
    expect(r.diagnostics.map((d) => d.code)).toEqual([])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})

describe('aggregate names for convert', () => {
  it('suggests ae(N-1) for a Cisco Port-channelN or Bundle-EtherN, and nothing for other ports', () => {
    expect(plugin.nameInterface!({ type: 'aggregate', numbers: [1] })).toBe('ae0')
    expect(plugin.nameInterface!({ type: 'aggregate', numbers: [12] })).toBe('ae11')
    expect(plugin.nameInterface!({ type: 'aggregate', numbers: [0] })).toBeUndefined()
    expect(plugin.nameInterface!({ type: 'aggregate', numbers: [1, 2] })).toBeUndefined()
    expect(plugin.nameInterface!({ type: 'ethernet', speed: 1000, numbers: [0, 0, 1] })).toBeUndefined()
  })

  it('suggests irb.N for a routed VLAN interface of VLAN N (Cisco VlanN, #80), and nothing out of range', () => {
    expect(plugin.nameInterface!({ type: 'irb-or-svi', numbers: [100] })).toBe('irb.100')
    expect(plugin.nameInterface!({ type: 'vlan', numbers: [1] })).toBe('irb.1')
    expect(plugin.nameInterface!({ type: 'irb-or-svi', numbers: [4094] })).toBe('irb.4094')
    expect(plugin.nameInterface!({ type: 'irb-or-svi', numbers: [0] })).toBeUndefined()
    expect(plugin.nameInterface!({ type: 'irb-or-svi', numbers: [4095] })).toBeUndefined()
  })
})

describe('group and peer names', () => {
  it('that look like Object.prototype keys are ordinary keys through parse, render and reparse', () => {
    const text = set('set routing-options autonomous-system 65000', 'set protocols bgp group __proto__ neighbor 192.0.2.2 peer-as 64500', 'set protocols bgp group constructor import toString', 'set protocols bgp group constructor neighbor 192.0.2.3 peer-as 64501')
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const p = parse(text, context)
    expect(Object.keys(p.model.networkInstances!.default.bgp!.groups!)).toEqual(['__proto__', 'constructor'])
    expect(p.model.networkInstances!.default.bgp!.neighbors!['192.0.2.2'].group).toBe('__proto__')
    expect(checkFixture(plugin, { name: 'safe BGP keys', source: text, expectedModel: p.model }).filter((c) => c.status === 'failed')).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
  })

  it('that share a secret value stay out of every message', () => {
    const secret = 'PLACEHOLDER-RO'
    const p = parse(set(`set snmp community ${secret} authorization read-only`, `set protocols bgp group ${secret} neighbor 192.0.2.2 peer-as 64500`, `set protocols bgp group other neighbor 192.0.2.2 peer-as 64500`, `set protocols bgp group ${secret} import ${secret}`, `set protocols ospf area 0 interface ${secret}.0`), context)
    const r = render({ networkInstances: { default: { bgp: { groups: { [secret]: { authentication: true, importPolicies: [secret] } }, ebgpDefaultPolicy: { import: 'reject' } } } } }, context)
    expect(told(p, r).length).toBeGreaterThan(3)
    for (const text of told(p, r)) expect(text).not.toContain(secret)
  })
})
