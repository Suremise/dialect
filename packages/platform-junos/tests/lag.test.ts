// LAGs (model 0.5.4, #109) beyond the conformance fixture (tests/fixtures/conformance/lag): membership in either form,
// through groups and interface ranges by the inheritance rules, the aggregate's LACP mode and minimum links, what isn't
// converted and why, the render of a model from another platform, and an IOS-XE port-channel converted to an `ae`.
import { describe, expect, it } from 'vitest'
import { buildLedger, convert, interfaceInputs, MODEL_VERSION, modelProblems, statementsOf, type Device, type ParseResult, type PlatformPlugin } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import iosxe from '@dialect/platform-iosxe'
import plugin, { parse, render } from '../src'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
/** Each statement's disposition, by its line. */
const byLine = (p: ParseResult) => Object.fromEntries(statementsOf(p.tree).map((n) => [n.span!.startLine, p.dispositions[n.id]]))
/** The kit's checks on `text` against its own parse: what failed. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text, context).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

describe('parse: member links and aggregates', () => {
  it('gigether-options (MX) and ether-options (EX, QFX) both make a member link, the aggregate made sure of', () => {
    const p = parse(set('set interfaces ge-0/0/0 gigether-options 802.3ad ae0', 'set interfaces xe-0/0/1 ether-options 802.3ad ae0'), context)
    expect(p.model.interfaces).toEqual({
      'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' },
      ae0: { type: 'aggregate' },
      'xe-0/0/1': { type: 'ethernet', aggregate: 'ae0' }
    })
    expect(modelProblems(p.model)).toEqual([])
    expect(Object.values(p.dispositions).map((d) => d.kind)).toEqual(['mapped', 'mapped'])
  })

  it('an aggregate takes lacp active or passive and minimum-links; no lacp is no LACP, which the model leaves out', () => {
    const p = parse(set('set interfaces ae0 aggregated-ether-options lacp active', 'set interfaces ae0 aggregated-ether-options minimum-links 2', 'set interfaces ae1 aggregated-ether-options lacp passive', 'set interfaces ae2 aggregated-ether-options minimum-links 1'), context)
    expect(p.model.interfaces).toEqual({
      ae0: { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 2 } },
      ae1: { type: 'aggregate', aggregation: { lacp: 'passive' } },
      ae2: { type: 'aggregate', aggregation: { minLinks: 1 } }
    })
  })

  it('a later membership supersedes an earlier one, as loading the commands would', () => {
    const p = parse(set('set interfaces ge-0/0/0 gigether-options 802.3ad ae0', 'set interfaces ge-0/0/0 ether-options 802.3ad ae1'), context)
    expect(p.model.interfaces!['ge-0/0/0'].aggregate).toBe('ae1')
    expect(byLine(p)[1]).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 2' })
  })

  it('what the model has no place for is unsupported, each with why, and never quotes the configuration', () => {
    const p = parse(set(
      'set interfaces ge-0/0/0 gigether-options 802.3ad ae0',
      'set interfaces ge-0/0/0 gigether-options 802.3ad lacp port-priority 100',
      'set interfaces ge-0/0/0 gigether-options 802.3ad primary',
      'set interfaces ge-0/0/1 gigether-options 802.3ad secret-bundle',
      'set interfaces ae0 aggregated-ether-options lacp periodic fast',
      'set interfaces ae0 aggregated-ether-options link-speed 10g',
      'set interfaces ae0 aggregated-ether-options minimum-links 65',
      'set interfaces ge-0/0/2 aggregated-ether-options lacp active',
      'set interfaces ae1 gigether-options 802.3ad ae0',
      'set interfaces ge-0/0/3 gigether-options speed 1g'
    ), context)
    const lines = byLine(p)
    expect(lines[1].kind).toBe('mapped')
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => lines[n])).toEqual([
      { kind: 'unsupported', reason: "a member link's own LACP settings (port priority, force-up): the model has the aggregate's mode" },
      { kind: 'unsupported', reason: 'a primary or backup member link: the model has no such role' },
      { kind: 'unsupported', reason: 'not an aggregate (aeN) to be a member link of' },
      { kind: 'unsupported', reason: 'LACP settings other than active and passive (periodic, system ID, admin key…): the model has the mode only' },
      { kind: 'unsupported', reason: "an aggregate's link speed: the model has none" },
      { kind: 'unsupported', reason: 'not a number of links from 1 to 64' },
      { kind: 'unsupported', reason: "aggregate settings on an interface that isn't an aggregate (aeN)" },
      { kind: 'unsupported', reason: 'an aggregate as a member link of another, which Junos refuses' },
      { kind: 'unsupported', reason: 'Ethernet settings (speed, autonegotiation, flow control) come later' }
    ])
    expect(p.model.interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' }, ae0: { type: 'aggregate' } })
  })

  it('chassis aggregated-devices is ignored by design: a render writes it from the aggregates', () => {
    const p = parse(set('set chassis aggregated-devices ethernet device-count 24', 'set chassis fpc 0 pic 0 port 1 speed 10g'), context)
    expect(byLine(p)).toEqual({
      1: { kind: 'ignored-by-design', reason: "how many aggregates Junos makes room for: a render writes it from the model's aggregates" },
      2: { kind: 'unsupported', reason: 'chassis settings (hardware, clustering, redundancy) belong to the device: the model has no place for them' }
    })
  })
})

describe('parse: groups and interface ranges keep the inheritance rules (R1–R12)', () => {
  it('R1: the first group listed wins the membership', () => {
    const p = parse(set('set groups A interfaces <ge-*> gigether-options 802.3ad ae0', 'set groups B interfaces <ge-*> gigether-options 802.3ad ae1', 'set interfaces ge-0/0/0 apply-groups [ A B ]'), context)
    expect(p.model.interfaces!['ge-0/0/0'].aggregate).toBe('ae0')
  })

  it("R3: the interface's own membership wins over a group's, and the group's own settings still apply elsewhere", () => {
    const p = parse(set('set groups G interfaces <ge-*> gigether-options 802.3ad ae1', 'set apply-groups G', 'set interfaces ge-0/0/0 gigether-options 802.3ad ae0', 'set interfaces ge-0/0/1 description other'), context)
    expect(p.model.interfaces!['ge-0/0/0'].aggregate).toBe('ae0')
    expect(p.model.interfaces!['ge-0/0/1'].aggregate).toBe('ae1')
  })

  it("a group's LACP mode applies to the aggregates it matches, and the aggregate's own mode wins", () => {
    const p = parse(set('set groups LACP interfaces <ae*> aggregated-ether-options lacp active', 'set apply-groups LACP', 'set interfaces ae0 description a', 'set interfaces ae1 aggregated-ether-options lacp passive'), context)
    expect(p.model.interfaces!.ae0.aggregation).toEqual({ lacp: 'active' })
    expect(p.model.interfaces!.ae1.aggregation).toEqual({ lacp: 'passive' })
  })

  it('an aggregate only a superseded membership named is not made up, nor written, nor counted', () => {
    const p = parse(set('set groups G interfaces <ge-*> ether-options 802.3ad ae1', 'set apply-groups G', 'set interfaces ge-0/0/0 ether-options 802.3ad ae0'), context)
    expect(p.model.interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' }, ae0: { type: 'aggregate' } })
    const text = render(p.model, context).text
    expect(text).not.toMatch(/ae1/)
    expect(text).toContain('device-count 1;')
    const later = parse(set('set interfaces ge-0/0/0 ether-options 802.3ad ae3', 'set interfaces ge-0/0/0 ether-options 802.3ad ae0'), context)
    expect(Object.keys(later.model.interfaces!)).toEqual(['ge-0/0/0', 'ae0'])
    expect(byLine(later)[2]).toEqual({ kind: 'mapped', fields: ['interfaces["ge-0/0/0"].type', 'interfaces["ge-0/0/0"].aggregate', 'interfaces.ae0.type'] })
  })

  it('an interface range puts each of its members in the aggregate', () => {
    const p = parse(set('set interfaces interface-range UPLINKS member-range ge-0/0/0 to ge-0/0/2', 'set interfaces interface-range UPLINKS ether-options 802.3ad ae3'), context)
    expect(Object.entries(p.model.interfaces!).filter(([, i]) => i.aggregate === 'ae3').map(([name]) => name)).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2'])
    expect(modelProblems(p.model)).toEqual([])
  })
})

describe('render', () => {
  it('writes members, the aggregate options and room for the aggregates, and reads back the same model', () => {
    const text = set('set interfaces ge-0/0/0 gigether-options 802.3ad ae2', 'set interfaces ae2 aggregated-ether-options lacp passive', 'set interfaces ae2 aggregated-ether-options minimum-links 3', 'set interfaces ae0 unit 0 family inet address 192.0.2.1/31')
    const r = render(parse(text, context).model, context)
    expect(r.text).toContain('chassis {\n    aggregated-devices {\n        ethernet {\n            device-count 3;\n        }\n    }\n}\n')
    expect(r.text).toContain('    ge-0/0/0 {\n        ether-options {\n            802.3ad ae2;\n        }\n    }\n')
    expect(r.text).toContain('        aggregated-ether-options {\n            lacp {\n                passive;\n            }\n            minimum-links 3;\n        }\n')
    expect(roundTrips(text)).toEqual([])
  })

  it("a model from another platform: Cisco's names until the user maps them, static LACP as Junos's default, out-of-range minimum links", () => {
    const model: Device = {
      interfaces: {
        'Port-channel1': { type: 'aggregate', aggregation: { lacp: 'static', minLinks: 65 } },
        'GigabitEthernet1/0/1': { type: 'ethernet', aggregate: 'Port-channel1' }
      }
    }
    const r = render(model, context)
    expect(r.dispositions).toMatchObject({
      'interfaces["GigabitEthernet1/0/1"].aggregate': { kind: 'unsupported', reason: 'a Junos aggregate is named aeN: name it in the interface map' },
      'interfaces["Port-channel1"].aggregation.lacp': { kind: 'unsupported', reason: 'a Junos aggregate is named aeN: name it in the interface map' },
      'interfaces["Port-channel1"].aggregation.minLinks': { kind: 'unsupported', reason: 'a Junos aggregate is named aeN: name it in the interface map' }
    })
    const named = render({ interfaces: { ae0: { type: 'aggregate', aggregation: { lacp: 'static', minLinks: 65 } }, 'ge-0/0/1': { type: 'ethernet', aggregate: 'ae0' } } }, context)
    expect(named.dispositions).toMatchObject({
      'interfaces.ae0.aggregation.lacp': { kind: 'not-applicable', reason: 'a Junos aggregate runs without LACP unless lacp is set' },
      'interfaces.ae0.aggregation.minLinks': { kind: 'unsupported', reason: 'Junos takes minimum links from 1 to 64' },
      'interfaces["ge-0/0/1"].aggregate': { kind: 'rendered' }
    })
    expect(named.text).not.toContain('aggregated-ether-options')
  })
})

describe('convert: an IOS-XE port-channel with its members', () => {
  // The model IOS-XE's parse gives for `interface Port-channel1` with `port-channel min-links 2` and two members with
  // `channel-group 1 mode active` (ARCHITECTURE, model 0.5.4). IOS-XE reads them in #108, so until then the source
  // plugin's parse is this model's, and everything else (its names) is IOS-XE's own.
  const model: Device = {
    interfaces: {
      'Port-channel1': { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 2 }, subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 31 } } } } } },
      'GigabitEthernet1/0/1': { type: 'ethernet', aggregate: 'Port-channel1' },
      'GigabitEthernet1/0/2': { type: 'ethernet', aggregate: 'Port-channel1' }
    }
  }
  const source: PlatformPlugin = { ...iosxe, parse: () => ({ tree: [], model, dispositions: {}, diagnostics: [] }) }

  it('is ae0, Port-channel N being ae(N-1), with its members and its mode once the names are taken', () => {
    const before = convert(source, plugin, '', context)
    expect(before.interfaces.find((i) => i.source === 'Port-channel1')?.suggestion).toBe('ae0')
    const after = convert(source, plugin, '', { ...context, inputs: interfaceInputs({ 'Port-channel1': 'ae0', 'GigabitEthernet1/0/1': 'ge-0/0/1', 'GigabitEthernet1/0/2': 'ge-0/0/2' }) })
    expect(after.model.interfaces!['ge-0/0/1'].aggregate).toBe('ae0')
    const text = after.render!.text
    expect(text).toContain('device-count 1;')
    expect(text).toContain('    ge-0/0/1 {\n        ether-options {\n            802.3ad ae0;\n        }\n    }\n')
    expect(text).toContain('    ge-0/0/2 {\n        ether-options {\n            802.3ad ae0;\n        }\n    }\n')
    expect(text).toContain('    ae0 {\n        aggregated-ether-options {\n            lacp {\n                active;\n            }\n            minimum-links 2;\n        }\n')
    expect(after.issues).toEqual([])
    // Junos reads it back as the model it was written from.
    expect(parse(text, context).model.interfaces).toEqual(after.model.interfaces)
    expect(buildLedger(parse(text, context)).complete).toBe(true)
  })
})
