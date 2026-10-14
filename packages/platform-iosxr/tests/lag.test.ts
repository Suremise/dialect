// Bundles (LAGs, model 0.5.4, #109) beyond the fixture (tests/fixtures/interfaces/bundles): a member's `bundle id`
// and the bundle's LACP mode from its members, `bundle minimum-active links`, the `no` forms, what isn't converted and
// why, the render of a model from another platform, and an IOS-XE port-channel converted to a Bundle-Ether.
import { describe, expect, it } from 'vitest'
import { convert, interfaceInputs, MODEL_VERSION, modelProblems, statementsOf, type Device, type ParseResult } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import iosxe from '@dialect/platform-iosxe'
import plugin from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
/** Each statement's disposition, by its line. */
const byLine = (p: ParseResult) => Object.fromEntries(statementsOf(p.tree).map((n) => [n.span!.startLine, p.dispositions[n.id]]))
/** The kit's checks on `text` against its own parse: what failed. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

describe('parse', () => {
  it("a member's bundle id names its bundle, made sure of; the members' agreeing mode is the bundle's, said by each", () => {
    const p = parse('interface GigabitEthernet0/0/0/0\n bundle id 7 mode passive\ninterface GigabitEthernet0/0/0/1\n bundle id 7 mode passive\n')
    expect(p.model.interfaces).toEqual({
      'GigabitEthernet0/0/0/0': { type: 'ethernet', aggregate: 'Bundle-Ether7' },
      'Bundle-Ether7': { type: 'aggregate', aggregation: { lacp: 'passive' } },
      'GigabitEthernet0/0/0/1': { type: 'ethernet', aggregate: 'Bundle-Ether7' }
    })
    expect(modelProblems(p.model)).toEqual([])
    expect(byLine(p)[2]).toEqual({ kind: 'mapped', fields: ['interfaces["GigabitEthernet0/0/0/0"].aggregate', 'interfaces["Bundle-Ether7"].type', 'interfaces["Bundle-Ether7"].aggregation.lacp'] })
  })

  it('no mode is mode on: with mode on beside it the bundle is static, alone it says nothing', () => {
    const mixed = parse('interface GigabitEthernet0/0/0/0\n bundle id 1 mode on\ninterface GigabitEthernet0/0/0/1\n bundle id 1\n')
    expect(mixed.model.interfaces!['Bundle-Ether1'].aggregation).toEqual({ lacp: 'static' })
    const silent = parse('interface GigabitEthernet0/0/0/0\n bundle id 1\n')
    expect(silent.model.interfaces!['Bundle-Ether1']).toEqual({ type: 'aggregate' })
    expect(roundTrips('interface GigabitEthernet0/0/0/0\n bundle id 1 mode on\ninterface GigabitEthernet0/0/0/1\n bundle id 1\n')).toEqual([])
  })

  it("members that don't agree on the mode leave every member's statement out, and a bundle only they named", () => {
    const p = parse('interface GigabitEthernet0/0/0/0\n bundle id 1 mode active\ninterface GigabitEthernet0/0/0/1\n bundle id 1\n')
    expect(p.model.interfaces).toEqual({ 'GigabitEthernet0/0/0/0': { type: 'ethernet' }, 'GigabitEthernet0/0/0/1': { type: 'ethernet' } })
    const why = { kind: 'unsupported', reason: "the bundle's member links don't agree on its LACP mode: the model has one mode for the bundle" }
    expect([byLine(p)[2], byLine(p)[4]]).toEqual([why, why])
  })

  it('the no forms remove the membership and the minimum links', () => {
    const p = parse('interface Bundle-Ether1\n bundle minimum-active links 2\n no bundle minimum-active links\ninterface GigabitEthernet0/0/0/0\n bundle id 1 mode active\n no bundle id 1 mode active\n')
    expect(p.model.interfaces).toEqual({ 'Bundle-Ether1': { type: 'aggregate' }, 'GigabitEthernet0/0/0/0': { type: 'ethernet' } })
    expect(byLine(p)[5]).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 6' })
  })

  it('a bundle only a removed or superseded membership named is not made up, nor written', () => {
    const removed = parse('interface GigabitEthernet0/0/0/0\n bundle id 1 mode active\n no bundle id 1 mode active\n')
    expect(removed.model.interfaces).toEqual({ 'GigabitEthernet0/0/0/0': { type: 'ethernet' } })
    expect(render(removed.model).text).not.toMatch(/Bundle-Ether/)
    const superseded = parse('interface GigabitEthernet0/0/0/0\n bundle id 1 mode active\n bundle id 2 mode active\n')
    expect(Object.keys(superseded.model.interfaces!)).toEqual(['GigabitEthernet0/0/0/0', 'Bundle-Ether2'])
    expect(render(superseded.model).text).not.toMatch(/Bundle-Ether1/)
    // A bundle the configuration declares stays, whatever its members do.
    const declared = parse('interface Bundle-Ether1\n!\ninterface GigabitEthernet0/0/0/0\n bundle id 1\n no bundle id\n')
    expect(declared.model.interfaces).toEqual({ 'Bundle-Ether1': { type: 'aggregate' }, 'GigabitEthernet0/0/0/0': { type: 'ethernet' } })
  })

  it('what the model has no place for is unsupported, each with why', () => {
    const p = parse([
      'interface Bundle-Ether1',
      ' bundle minimum-active links 65',
      ' bundle minimum-active bandwidth 1000000',
      ' bundle id 2 mode active',
      'interface GigabitEthernet0/0/0/0',
      ' bundle minimum-active links 2',
      ' bundle id 70000',
      ' bundle id 3 mode auto',
      'interface GigabitEthernet0/0/0/1.10',
      ' bundle id 3'
    ].join('\n'))
    expect([2, 3, 4, 6, 7, 8, 10].map((n) => byLine(p)[n])).toEqual([
      { kind: 'unsupported', reason: 'not a number of links from 1 to 64' },
      { kind: 'unsupported', reason: 'a bundle setting the model has no place for (maximum active links, bandwidth, priorities, load balancing)' },
      { kind: 'unsupported', reason: 'a bundle as a member link of another, which IOS-XR refuses' },
      { kind: 'unsupported', reason: "bundle settings on an interface that isn't a bundle (Bundle-EtherN)" },
      { kind: 'unsupported', reason: 'not a bundle number from 1 to 65535' },
      { kind: 'unsupported', reason: 'a bundle mode other than active, passive and on' },
      { kind: 'unsupported', reason: 'bundle settings on a subinterface: IOS-XR takes them on the main interface' }
    ])
  })
})

describe('render', () => {
  it('a Junos model: aggregate names need the interface map; a bundle with no member written has nowhere for its mode', () => {
    const r = render({ interfaces: { ae0: { type: 'aggregate', aggregation: { lacp: 'active' } }, 'ge-0/0/1': { type: 'ethernet', aggregate: 'ae0' }, 'Bundle-Ether2': { type: 'aggregate', aggregation: { lacp: 'passive', minLinks: 3 } } } })
    expect(r.dispositions).toMatchObject({
      'interfaces.ae0.aggregation.lacp': { kind: 'unsupported', reason: 'IOS-XR names a bundle Bundle-EtherN, N from 1 to 65535: name it in the interface map' },
      'interfaces["ge-0/0/1"].aggregate': { kind: 'unsupported', reason: 'IOS-XR names a bundle Bundle-EtherN, N from 1 to 65535: name it in the interface map' },
      'interfaces["Bundle-Ether2"].aggregation.lacp': { kind: 'unsupported', reason: 'IOS-XR gives the LACP mode on each member link (bundle id N mode …), and the bundle has none written' },
      'interfaces["Bundle-Ether2"].aggregation.minLinks': { kind: 'rendered' }
    })
    expect(r.text).toContain('interface Bundle-Ether2\n bundle minimum-active links 3\n!\n')
  })
})

describe('convert: an IOS-XE port-channel with its members', () => {
  // IOS-XE's own text: a routed Port-channel with its minimum links, and two members bundling with LACP.
  const iosxeText = ['interface Port-channel1', ' ip address 192.0.2.1 255.255.255.254', ' port-channel min-links 2', 'interface GigabitEthernet1/0/1', ' channel-group 1 mode active', 'interface GigabitEthernet1/0/2', ' channel-group 1 mode active', ''].join('\n')

  it('is Bundle-Ether1, the number kept, with its members and their mode once the names are taken', () => {
    const before = convert(iosxe, plugin, iosxeText, context)
    expect(before.interfaces.find((i) => i.source === 'Port-channel1')?.suggestion).toBe('Bundle-Ether1')
    const after = convert(iosxe, plugin, iosxeText, { ...context, inputs: interfaceInputs({ 'Port-channel1': 'Bundle-Ether1', 'GigabitEthernet1/0/1': 'GigabitEthernet0/0/0/1', 'GigabitEthernet1/0/2': 'GigabitEthernet0/0/0/2' }) })
    const text = after.render!.text
    expect(text).toContain('interface Bundle-Ether1\n bundle minimum-active links 2\n ipv4 address 192.0.2.1 255.255.255.254\n!\n')
    expect(text).toContain('interface GigabitEthernet0/0/0/1\n bundle id 1 mode active\n!\n')
    expect(text).toContain('interface GigabitEthernet0/0/0/2\n bundle id 1 mode active\n!\n')
    expect(after.issues).toEqual([])
    // IOS-XR reads it back as the model it was written from.
    expect(parse(text).model.interfaces).toEqual(after.model.interfaces)
  })
})
