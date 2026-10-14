// The mapping to and from the model beyond what the conformance fixtures show: both forms of the same configuration
// give the same model, detect(), groups and ranges in detail, keys that look like Object.prototype's, and secrets kept
// out of every diagnostic and reason.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildLedger, createRegistry, ledgerProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { checkFixture, loadFixtures } from '@dialect/conformance'
import plugin, { detect, isSetForm, memberRange, parse, render } from '../src'

const context = { modelVersion: MODEL_VERSION }
const PAIRS = fileURLToPath(new URL('./fixtures/display-set/', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/conformance/', import.meta.url))

/** Every reason a parse or a render gives, and every diagnostic message: what a user or a log can see. */
const told = (p: ParseResult, r?: RenderResult): string[] => [
  ...Object.values(p.dispositions).flatMap((d) => (d.kind === 'mapped' ? [] : [d.reason ?? ''])),
  ...p.diagnostics.flatMap((d) => [d.message, d.field ?? '', d.statement ?? '']),
  ...Object.values(r?.dispositions ?? {}).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])),
  ...(r?.diagnostics ?? []).flatMap((d) => [d.message, d.field ?? '', d.statement ?? ''])
]

describe('both forms', () => {
  it.each(Array.from({ length: 22 }, (_, i) => i + 1))('give config_%i the same model, hierarchical or set', (n) => {
    const hierarchical = parse(readFileSync(join(PAIRS, `config_${n}.conf`), 'utf8'), context)
    const set = parse(readFileSync(join(PAIRS, `config_${n}.set`), 'utf8'), context)
    expect(hierarchical.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(set.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(set.model).toEqual(hierarchical.model)
  })

  it('tells them apart by their lines', () => {
    expect(isSetForm('set system host-name r1\nset interfaces ge-0/0/0 unit 0\n')).toBe(true)
    expect(isSetForm('# comment\n\n  set system host-name r1\ndeactivate system\n')).toBe(true)
    expect(isSetForm('system {\n    host-name r1;\n}\n')).toBe(false)
    expect(isSetForm('')).toBe(false)
  })
})

describe('detect', () => {
  it('scores Junos high, in either form, and IOS low', () => {
    expect(detect('version 23.2R1;\nsystem {\n    host-name r1;\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet;\n        }\n    }\n}\n')).toBeGreaterThanOrEqual(0.9)
    expect(detect('set system host-name r1\nset interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24\n')).toBeGreaterThanOrEqual(0.9)
    expect(detect('hostname r1\n!\ninterface GigabitEthernet0/1\n ip address 192.0.2.1 255.255.255.0\n!\nend\n')).toBeLessThan(0.1)
    expect(detect('')).toBe(0)
  })

  it('is found by the registry for a Junos text', () => {
    expect(createRegistry([plugin]).detect('set system host-name r1\n').map((d) => d.plugin.id)).toEqual(['junos'])
  })
})

describe('groups', () => {
  const model = (text: string) => parse(text, context).model

  it('match wildcards against what the configuration has, never creating it', () => {
    const text = [
      'set groups G interfaces "<[xe][et]-*>" mtu 9192',
      'set groups G interfaces <*> unit <*> family inet mtu 9000',
      'set apply-groups G',
      'set interfaces xe-0/0/0 unit 0 family inet address 192.0.2.1/24',
      'set interfaces et-0/0/1 unit 5 family inet address 192.0.2.5/30',
      'set interfaces ge-0/0/2 unit 0 family inet address 192.0.2.9/30'
    ].join('\n')
    const interfaces = model(text).interfaces!
    expect(Object.keys(interfaces)).toEqual(['xe-0/0/0', 'et-0/0/1', 'ge-0/0/2'])
    expect([interfaces['xe-0/0/0'].mtu, interfaces['et-0/0/1'].mtu, interfaces['ge-0/0/2'].mtu]).toEqual([9192, 9192, undefined])
    // An interface takes the first wildcard that matches it: xe- and et- the first's statements only, ge- the second's.
    expect(interfaces['et-0/0/1'].subinterfaces!['5'].ipv4!.mtu).toBeUndefined()
    expect(interfaces['ge-0/0/2'].subinterfaces!['0'].ipv4!.mtu).toBe(9000)
  })

  it('give way to the configuration, a deeper apply-groups, and the first group listed', () => {
    const text = [
      'set groups A system domain-name a.example',
      'set groups B system domain-name b.example',
      'set groups B interfaces ge-0/0/0 description "from B"',
      'set groups C interfaces ge-0/0/0 description "from C"',
      'set apply-groups [ A B ]',
      'set interfaces ge-0/0/0 apply-groups C',
      'set interfaces ge-0/0/0 unit 0'
    ].join('\n')
    const m = model(text)
    expect(m.system!.domainName).toBe('a.example')
    expect(m.interfaces!['ge-0/0/0'].description).toBe('from C')
    expect(model(`${text}\nset interfaces ge-0/0/0 description local`).interfaces!['ge-0/0/0'].description).toBe('local')
  })

  it('stop below an apply-groups-except, and an unknown group is unsupported', () => {
    const p = parse(['set groups G interfaces <*> mtu 9192', 'set apply-groups G', 'set apply-groups NOPE', 'set interfaces ge-0/0/0 unit 0', 'set interfaces ge-0/0/1 apply-groups-except G', 'set interfaces ge-0/0/1 unit 0'].join('\n'), context)
    expect(p.model.interfaces!['ge-0/0/0'].mtu).toBe(9192)
    expect(p.model.interfaces!['ge-0/0/1'].mtu).toBeUndefined()
    expect(p.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'no group of that name is defined' })
  })
})

/** A set-form text as hierarchical, through display set's inverse being out of scope: by hand for these small cases. */
const both = (set: string, hierarchical: string) => [set, hierarchical] as const

describe('precedence, as Juniper documents it', () => {
  it('gives an object the first wildcard of a group that matches it, in either form', () => {
    for (const text of both(
      'set groups G interfaces <ge-*> mtu 1500\nset groups G interfaces <*> mtu 9000\nset apply-groups G\nset interfaces ge-0/0/0 unit 0\nset interfaces xe-0/0/0 unit 0\n',
      'groups {\n    G {\n        interfaces {\n            <ge-*> {\n                mtu 1500;\n            }\n            <*> {\n                mtu 9000;\n            }\n        }\n    }\n}\napply-groups G;\ninterfaces {\n    ge-0/0/0 {\n        unit 0;\n    }\n    xe-0/0/0 {\n        unit 0;\n    }\n}\n'
    )) {
      const interfaces = parse(text, context).model.interfaces!
      expect([interfaces['ge-0/0/0'].mtu, interfaces['xe-0/0/0'].mtu]).toEqual([1500, 9000])
    }
  })

  it("gives an interface in two ranges the first range's settings, in either form", () => {
    for (const text of both(
      'set interfaces interface-range A member ge-0/0/0\nset interfaces interface-range A mtu 1500\nset interfaces interface-range B member ge-0/0/0\nset interfaces interface-range B mtu 9000\nset interfaces interface-range B description from-B\n',
      'interfaces {\n    interface-range A {\n        member ge-0/0/0;\n        mtu 1500;\n    }\n    interface-range B {\n        member ge-0/0/0;\n        mtu 9000;\n        description from-B;\n    }\n}\n'
    )) {
      expect(parse(text, context).model.interfaces!['ge-0/0/0']).toMatchObject({ mtu: 1500, description: 'from-B' })
    }
  })
})

describe('a node that stands for several statements', () => {
  const kinds = (p: ParseResult, id: string) => p.dispositions[id].kind

  it("is unsupported when one of its values is, whatever the order, and the rest still convert", () => {
    for (const list of ['[ "ge-0/0/[0,1]" ge-0/0/2 ]', '[ ge-0/0/2 "ge-0/0/[0,1]" ]']) {
      const p = parse(`set interfaces interface-range R member ${list}\nset interfaces interface-range R mtu 1500\n`, context)
      expect(kinds(p, 'L1')).toBe('unsupported')
      expect(p.model.interfaces).toEqual({ 'ge-0/0/2': { type: 'ethernet', mtu: 1500 } })
    }
    for (const list of ['[ NOPE G ]', '[ G NOPE ]']) {
      const p = parse(`set apply-groups ${list}\nset groups G system host-name r1\n`, context)
      expect(kinds(p, 'L1')).toBe('unsupported')
      expect(p.model.system!.hostname).toBe('r1')
    }
    for (const list of ['[ 192.0.2.1 not-an-address ]', '[ not-an-address 192.0.2.1 ]']) {
      const set = parse(`set system name-server ${list}\n`, context)
      const hierarchical = parse(`system {\n    name-server ${list};\n}\n`, context)
      expect(kinds(set, 'L1')).toBe('unsupported')
      expect(kinds(hierarchical, 'L2:5')).toBe('unsupported')
      expect(set.model).toEqual({ system: { dns: { servers: { '192.0.2.1': {} } } } })
      expect(hierarchical.model).toEqual(set.model)
    }
  })

  it('is mapped when its values are mapped or superseded, and ignored when all are', () => {
    const p = parse('set system domain-search [ a.example b.example a.example ]\n', context)
    expect(p.dispositions.L1).toEqual({ kind: 'mapped', fields: ['system.dns.search'] })
  })
})

describe('range members and wildcards', () => {
  it('lets a wildcard group match the members of a range with no settings of its own', () => {
    const p = parse('set interfaces interface-range R member ge-0/0/0\nset interfaces interface-range R member-range ge-0/0/1 to ge-0/0/2\nset groups G interfaces <*> mtu 9000\nset apply-groups G\n', context)
    expect(p.model.interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', mtu: 9000 }, 'ge-0/0/1': { type: 'ethernet', mtu: 9000 }, 'ge-0/0/2': { type: 'ethernet', mtu: 9000 } })
  })

  it('lets it match the members a group names, and stops below apply-groups-except', () => {
    const text = [
      'set groups RANGES interfaces interface-range R member ge-0/0/0',
      'set groups RANGES interfaces interface-range R member ge-0/0/1',
      'set groups G interfaces <*> mtu 9000',
      'set apply-groups [ RANGES G ]',
      'set interfaces ge-0/0/1 apply-groups-except G'
    ].join('\n')
    expect(parse(text, context).model.interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', mtu: 9000 } })
  })
})

describe('interface ranges', () => {
  it('expand member ranges by their last number, and only those', () => {
    expect(memberRange('ge-0/0/0', 'ge-0/0/3')).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3'])
    expect(memberRange('xe-1/0/10', 'xe-1/0/11')).toEqual(['xe-1/0/10', 'xe-1/0/11'])
    expect(memberRange('ge-0/0/3', 'ge-0/0/1')).toBeNull()
    expect(memberRange('ge-0/0/0', 'xe-0/0/1')).toBeNull()
    expect(memberRange('ge-0/0/0', 'ge-0/1/0')).toBeNull()
  })
})

describe('inactive statements', () => {
  it('are left out, with a disposition saying so, in either form', () => {
    const hierarchical = parse('system {\n    inactive: ntp {\n        server 192.0.2.1;\n    }\n    host-name r1;\n}\n', context)
    expect(hierarchical.model).toEqual({ system: { hostname: 'r1' } })
    expect(hierarchical.dispositions['L2:5']).toEqual({ kind: 'ignored-by-design', reason: "inactive: Junos doesn't apply it" })
    expect(hierarchical.dispositions['L3:9']).toEqual({ kind: 'ignored-by-design', reason: "inside an inactive statement (line 2): Junos doesn't apply it" })
    const set = parse('set system ntp server 192.0.2.1\nset system host-name r1\ndeactivate system ntp\n', context)
    expect(set.model).toEqual(hierarchical.model)
  })
})

describe('keys that look like Object.prototype', () => {
  // Interface, community, routing instance, group and range names come from the configuration.
  const text = [
    'set groups __proto__ interfaces <*> description grouped',
    'set apply-groups __proto__',
    'set interfaces __proto__ unit 0 family inet address 192.0.2.1/24',
    'set interfaces interface-range constructor member toString',
    'set interfaces interface-range constructor mtu 1500',
    'set snmp community constructor authorization read-only',
    'set snmp community __proto__ clients 192.0.2.0/24',
    'set routing-instances toString instance-type vrf',
    'set routing-instances toString routing-options static route 0.0.0.0/0 next-hop 192.0.2.254'
  ].join('\n')

  it('are ordinary keys through parse, render and reparse, and Object.prototype is untouched', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const parsed = parse(text, context)
    const m = parsed.model
    expect(Object.keys(m.interfaces!)).toEqual(['__proto__', 'toString'])
    expect(Object.hasOwn(m.interfaces!, '__proto__') && m.interfaces!['__proto__'].description).toBe('grouped')
    expect(m.interfaces!['toString'].mtu).toBe(1500)
    expect(Object.keys(m.system!.snmp!.communities!)).toEqual(['constructor', '__proto__'])
    expect(m.networkInstances!['toString'].type).toBe('vrf')
    const failed = checkFixture(plugin, { name: 'safe keys', source: text, expectedModel: m }).filter((r) => r.status === 'failed')
    expect(failed).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
    expect(({} as Record<string, unknown>).description).toBeUndefined()
  })
})

describe('secrets', () => {
  it('never appear in a reason or a diagnostic, for any fixture', () => {
    for (const fixture of loadFixtures(FIXTURES)) {
      const p = parse(fixture.source, context)
      for (const text of told(p, render(p.model, context))) expect(text, fixture.name).not.toMatch(/PLACEHOLDER|\$9\$/)
    }
  })

  it('stay out of syntax errors in either form', () => {
    const set = parse('set system host-name r1\nset snmp community "PLACEHOLDER-RO authorization read-only\n', context)
    const hierarchical = parse('snmp {\n    community PLACEHOLDER-RO {\n        authorization read-only\n    }\n}\n', context)
    const bad = parse('set snmp community PLACEHOLDER-RO ; authorization read-only\n', context)
    for (const p of [set, hierarchical, bad]) {
      expect(p.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(1)
      for (const text of told(p)) expect(text).not.toContain('PLACEHOLDER')
    }
    expect(set.model).toEqual({ system: { hostname: 'r1' } })
  })
})

describe('SNMP communities', () => {
  const render0 = (model: Device) => render(model, context)

  it('are never written open to every client', () => {
    const model: Device = { system: { snmp: { communities: { 'PLACEHOLDER-NONE': { access: 'read-only', clients: [] }, 'PLACEHOLDER-BAD': { clients: ['not-a-prefix'] }, 'PLACEHOLDER-OK': { clients: ['192.0.2.0/24'] } } } } }
    const r = render0(model)
    expect(r.text).not.toContain('PLACEHOLDER-NONE')
    expect(r.text).not.toContain('PLACEHOLDER-BAD')
    expect(r.text).toContain('community PLACEHOLDER-OK {\n        clients {\n            192.0.2.0/24;\n        }\n    }')
    expect(r.dispositions['system.snmp.communities["PLACEHOLDER-NONE"].access']).toMatchObject({ kind: 'unsupported' })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['junos.snmp-community-clients', 'junos.snmp-community-clients'])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
    for (const text of told(parse('', context), r)) expect(text).not.toContain('PLACEHOLDER')
  })

  it('with a setting that can\'t be converted are converted not at all', () => {
    const p = parse('set snmp community PLACEHOLDER-RO authorization read-only\nset snmp community PLACEHOLDER-RO clients 192.0.2.0/24\nset snmp community PLACEHOLDER-RO clients 192.0.2.128/25 restrict\n', context)
    expect(p.model).toEqual({})
    expect(Object.values(p.dispositions).map((d) => d.kind)).toEqual(['unsupported', 'unsupported', 'unsupported'])
  })
})

describe('render', () => {
  it('writes a model from another platform in Junos terms, saying what it leaves out', () => {
    const model: Device = {
      system: { ntp: { sourceInterface: 'Loopback0', servers: { '192.0.2.1': {} } } },
      interfaces: { GigabitEthernet1: { type: 'ethernet', enabled: true, subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24, primary: false } } } } } } },
      networkInstances: { default: { staticRoutes: { '0.0.0.0/0': { description: 'default', nextHops: { '0': { address: '192.0.2.254', preference: 5 }, '1': { drop: 'discard' } } } } } }
    }
    const r = render(model, context)
    expect(r.text).toBe(
      [
        'system {',
        '    ntp {',
        '        server 192.0.2.1;',
        '    }',
        '}',
        'interfaces {',
        '    GigabitEthernet1 {',
        '        unit 0 {',
        '            family inet {',
        '                address 192.0.2.1/24;',
        '            }',
        '        }',
        '    }',
        '}',
        'routing-options {',
        '    static {',
        '        route 0.0.0.0/0 {',
        '            preference 5;',
        '            next-hop 192.0.2.254;',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n')
    )
    expect(r.dispositions['system.ntp.sourceInterface']).toMatchObject({ kind: 'unsupported' })
    expect(r.dispositions['interfaces.GigabitEthernet1.enabled']).toMatchObject({ kind: 'not-applicable' })
    expect(r.dispositions['networkInstances.default.staticRoutes["0.0.0.0/0"].description']).toMatchObject({ kind: 'unsupported' })
    expect(r.dispositions['networkInstances.default.staticRoutes["0.0.0.0/0"].nextHops["1"].drop']).toMatchObject({ kind: 'unsupported' })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['junos.drop-with-next-hops'])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})
