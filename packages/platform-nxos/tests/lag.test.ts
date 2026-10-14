// Link aggregation (model 0.5.4, #108): a member's `channel-group N [mode M]` names its port-channel and gives the
// aggregate's LACP mode, `lacp min-links` its minimum links, and `feature lacp` is written whenever either needs it; a
// Junos aggregate converts to a port-channel with its members and mode. The fixture (tests/fixtures/interfaces/lag.cfg)
// round-trips through the kit, and plugin.test.ts's feature guard checks every render has `feature lacp` when it needs it.
import { describe, expect, it } from 'vitest'
import { convert, interfaceInputs, MODEL_VERSION, populatedLeaves, statementsOf, type Device, type Interface, type PlatformPlugin, type PortName, type StatementDisposition } from '@dialect/core'
import plugin from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
const lines = (...l: string[]) => l.join('\n')
/** The disposition of the statement whose label is `label` (its full path), in a parse of `text`. */
const at = (result: ReturnType<typeof parse>, label: string): StatementDisposition | undefined => {
  const node = statementsOf(result.tree).find((n) => n.label === label)
  return node && result.dispositions[node.id]
}

describe('link aggregation: parse', () => {
  it('members that agree give their port-channel its mode; no mode says nothing', () => {
    const result = parse(lines('feature lacp', 'interface port-channel1', 'interface Ethernet1/1', '  channel-group 1 mode active', 'interface Ethernet1/2', '  channel-group 1 force mode active', 'interface Ethernet1/3', '  channel-group 2 mode on', 'interface Ethernet1/4', '  channel-group 5'))
    expect(result.diagnostics).toEqual([])
    expect(result.model.interfaces?.['Ethernet1/1']?.aggregate).toBe('port-channel1')
    expect(result.model.interfaces?.['Ethernet1/2']?.aggregate).toBe('port-channel1')
    expect(result.model.interfaces?.['port-channel1']?.aggregation).toEqual({ lacp: 'active' })
    expect(result.model.interfaces?.['port-channel2']).toEqual({ type: 'aggregate', aggregation: { lacp: 'static' } })
    expect(result.model.interfaces?.['port-channel5']).toEqual({ type: 'aggregate' })
    expect(at(result, 'interface Ethernet1/1 channel-group 1 mode active')).toEqual({ kind: 'mapped', fields: ['interfaces["Ethernet1/1"].aggregate', 'interfaces["port-channel1"].aggregation.lacp'] })
    // The port-channel the text doesn't configure is made by its members, as NX-OS does, and mapped by them.
    expect(at(result, 'interface Ethernet1/3 channel-group 2 mode on')).toEqual({ kind: 'mapped', fields: ['interfaces["Ethernet1/3"].aggregate', 'interfaces["port-channel2"].type', 'interfaces["port-channel2"].aggregation.lacp'] })
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'needed by LACP: written whenever an aggregate\'s LACP mode or minimum links is' })
  })

  it('feature lacp with nothing converted that needs it stays unsupported', () => {
    for (const text of ['feature lacp', lines('feature lacp', 'interface Ethernet1/1', '  channel-group 1 mode on')])
      expect(parse(text).dispositions.L1).toEqual({ kind: 'unsupported', reason: 'turns on a feature whose configuration isn\'t converted yet' })
  })

  it('no feature lacp takes the LACP members and minimum links before it out; static members stay', () => {
    const result = parse(lines('feature lacp', 'interface port-channel1', '  lacp min-links 2', 'interface Ethernet1/1', '  channel-group 1 mode active', 'interface Ethernet1/2', '  channel-group 2', 'no feature lacp'))
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'LACP\'s, which line 8 turns off: left out' })
    expect(result.dispositions.L5).toEqual({ kind: 'unsupported', reason: 'LACP\'s, which line 8 turns off: left out' })
    expect(result.model.interfaces?.['port-channel1']).toEqual({ type: 'aggregate' })
    expect(result.model.interfaces?.['Ethernet1/1']?.aggregate).toBeUndefined()
    expect(result.model.interfaces?.['Ethernet1/2']?.aggregate).toBe('port-channel2')
  })

  it('a member names the port-channel as the text writes it', () => {
    const result = parse(lines('interface po7', '  description bundle', 'interface Ethernet1/1', '  channel-group 7 mode passive'))
    expect(result.model.interfaces?.['Ethernet1/1']?.aggregate).toBe('po7')
    expect(result.model.interfaces?.po7?.aggregation).toEqual({ lacp: 'passive' })
    expect(Object.keys(result.model.interfaces ?? {})).toEqual(['po7', 'Ethernet1/1'])
  })

  it('members with different modes are left out, with an error that names lines only', () => {
    for (const [a, b] of [['mode active', 'mode passive'], ['mode active', 'mode on'], ['mode passive', '']]) {
      const result = parse(lines('interface Ethernet1/1', `  channel-group 3 ${a}`.trimEnd(), 'interface Ethernet1/2', `  channel-group 3 ${b}`.trimEnd()))
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'nxos.channel-group-modes', message: 'The members of one channel group give different modes (lines 2, 4): NX-OS bundles them with one.', statement: 'L2' })])
      expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'its channel group\'s members give different modes (lines 2, 4): left out' })
      expect(result.dispositions.L4).toEqual(result.dispositions.L2)
      expect(result.model.interfaces).toEqual({ 'Ethernet1/1': { type: 'ethernet' }, 'Ethernet1/2': { type: 'ethernet' } })
    }
    const agree = parse(lines('interface Ethernet1/1', '  channel-group 3 mode on', 'interface Ethernet1/2', '  channel-group 3'))
    expect(agree.diagnostics).toEqual([])
    expect(agree.model.interfaces?.['port-channel3']?.aggregation).toEqual({ lacp: 'static' })
  })

  it('no channel-group takes the member out; a later channel group supersedes an earlier one', () => {
    const removed = parse(lines('interface Ethernet1/1', '  channel-group 1 mode active', '  no channel-group'))
    expect(removed.model.interfaces).toEqual({ 'Ethernet1/1': { type: 'ethernet' } })
    expect(removed.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
    expect(removed.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'takes the interface out of the channel group on line 2: nothing to convert' })
    const other = parse(lines('interface Ethernet1/1', '  channel-group 1 mode active', '  no channel-group 2'))
    expect(other.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'not in that channel group: nothing to convert' })
    expect(other.model.interfaces?.['Ethernet1/1']?.aggregate).toBe('port-channel1')
    expect(parse(lines('interface Ethernet1/1', '  no channel-group')).dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'not in a channel group: nothing to convert' })
    const moved = parse(lines('interface Ethernet1/1', '  channel-group 1 mode active', '  channel-group 2 mode passive'))
    expect(moved.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    expect(moved.model.interfaces?.['Ethernet1/1']?.aggregate).toBe('port-channel2')
    expect(moved.model.interfaces?.['port-channel1']).toBeUndefined()
  })

  it('a malformed group number, a mode NX-OS doesn\'t have, or a member that can\'t be one, puts nothing in the model', () => {
    const cases: [string, string, string | undefined][] = [
      ['interface Ethernet1/1', '  channel-group 0 mode active', 'not a channel group number from 1 to 4096'],
      ['interface Ethernet1/1', '  channel-group 4097', 'not a channel group number from 1 to 4096'],
      ['interface Ethernet1/1', '  channel-group one mode active', 'not a channel group number from 1 to 4096'],
      ['interface Ethernet1/1', '  channel-group 1 mode desirable', undefined],
      ['interface Ethernet1/1', '  channel-group 1 active', undefined],
      ['interface Ethernet1/1.10', '  channel-group 1 mode active', 'a subinterface isn\'t a member link: its main interface is'],
      ['interface loopback0', '  channel-group 1 mode active', 'only an Ethernet interface is a member link of a port-channel'],
      ['interface port-channel2', '  channel-group 1 mode active', 'only an Ethernet interface is a member link of a port-channel'],
      ['interface port-channel1', '  lacp min-links 0', 'not a number of links from 1 to 32'],
      ['interface port-channel1', '  lacp min-links 33', 'not a number of links from 1 to 32'],
      ['interface Ethernet1/1', '  lacp min-links 2', 'only a port-channel has minimum links']
    ]
    for (const [iface, statement, reason] of cases) {
      const result = parse(lines(iface, statement))
      expect(result.dispositions.L2, statement).toMatchObject({ kind: 'unsupported', ...(reason ? { reason } : {}) })
      // No membership, no LAG settings and no port-channel made: only the interface the statement is on.
      expect(Object.values(result.model.interfaces ?? {}).some((i) => i.aggregate !== undefined || i.aggregation !== undefined), statement).toBe(false)
      expect(Object.keys(result.model.interfaces ?? {}), statement).toHaveLength(1)
    }
  })

  it('lacp min-links: set, superseded and removed', () => {
    const result = parse(lines('interface port-channel1', '  lacp min-links 2', '  lacp min-links 3'))
    expect(result.model.interfaces?.['port-channel1']?.aggregation).toEqual({ minLinks: 3 })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    const removed = parse(lines('interface port-channel1', '  lacp min-links 2', '  no lacp min-links'))
    expect(removed.model.interfaces?.['port-channel1']).toEqual({ type: 'aggregate' })
    expect(removed.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removes the minimum links on line 2: nothing to convert' })
  })
})

describe('link aggregation: render', () => {
  const lag = (lacp?: 'active' | 'passive' | 'static', name = 'port-channel1'): Device => ({
    interfaces: { [name]: { type: 'aggregate', ...(lacp ? { aggregation: { lacp } } : {}) }, 'Ethernet1/1': { type: 'ethernet', aggregate: name }, 'Ethernet1/2': { type: 'ethernet', aggregate: name } }
  })

  it('writes the mode on each member, and feature lacp only for LACP', () => {
    for (const [lacp, mode] of [['active', ' mode active'], ['passive', ' mode passive'], ['static', ' mode on'], [undefined, '']] as const) {
      const out = render(lag(lacp))
      expect(out.text).toContain(`interface Ethernet1/1\n  switchport\n  channel-group 1${mode}\n`)
      expect(out.text).toContain(`interface Ethernet1/2\n  switchport\n  channel-group 1${mode}\n`)
      expect(out.text.startsWith('feature lacp\n')).toBe(lacp === 'active' || lacp === 'passive')
      if (lacp) expect(out.dispositions['interfaces["port-channel1"].aggregation.lacp']).toEqual(out.dispositions['interfaces["Ethernet1/1"].aggregate'])
    }
    expect(render({ interfaces: { 'port-channel1': { type: 'aggregate', aggregation: { minLinks: 2 } } } }).text).toBe(lines('feature lacp', '', 'interface port-channel1', '  switchport', '  lacp min-links 2', ''))
  })

  it('leaves out what NX-OS can\'t say, with why, and needs no feature for it', () => {
    const misnamed = render(lag('active', 'ae0'))
    expect(misnamed.text).not.toContain('channel-group')
    expect(misnamed.text).not.toContain('feature lacp')
    expect(misnamed.dispositions['interfaces["Ethernet1/1"].aggregate']).toEqual({ kind: 'unsupported', reason: 'NX-OS bundles a member into the port-channel of its number, from 1 to 4096, and this aggregate isn\'t named so' })
    expect(misnamed.dispositions['interfaces.ae0.aggregation.lacp']).toEqual({ kind: 'unsupported', reason: 'NX-OS gives the LACP mode on each member link, and no member of this aggregate is written' })
    const alone = render({ interfaces: { 'port-channel1': { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 40 } } } })
    expect(alone.text).not.toContain('feature lacp')
    expect(alone.dispositions['interfaces["port-channel1"].aggregation.minLinks']).toEqual({ kind: 'unsupported', reason: 'not a number of links from 1 to 32' })
    const loopback = render({ interfaces: { 'port-channel1': { type: 'aggregate' }, loopback0: { type: 'loopback', aggregate: 'port-channel1' } } })
    expect(loopback.dispositions['interfaces.loopback0.aggregate']).toEqual({ kind: 'unsupported', reason: 'only an Ethernet interface is a member link on NX-OS' })
  })
})

// A Junos aggregate as the Junos plugin's parse gives it (model 0.5.4): `ae0` with LACP active and minimum links 2, and
// two members (`ether-options 802.3ad ae0`), with what `ae0` itself has (an address on its unit 0, a trunk). Each
// interface is one statement mapping its leaves. Its describeInterface counts aggregates from 1, as the Junos plugin's.
const junosShaped = (ae0: Interface = {}, vlans?: Device['vlans']): PlatformPlugin => {
  const model: Device = {
    ...(vlans ? { vlans } : {}),
    interfaces: {
      'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' },
      'ge-0/0/1': { type: 'ethernet', aggregate: 'ae0' },
      ae0: { type: 'aggregate', ...ae0, aggregation: { lacp: 'active', minLinks: 2 } }
    }
  }
  const names = Object.keys(model.interfaces!)
  return {
    id: 'junos-shaped',
    name: 'Junos (as its parse gives a LAG)',
    modelApi: '>=0.5.4 <1.0.0',
    capabilities: {},
    parse: () => ({
      tree: [...names.map((name) => ({ id: name, label: `interfaces ${name}` })), ...(vlans ? [{ id: 'vlans', label: 'vlans' }] : [])],
      model,
      dispositions: Object.fromEntries([...names.map((name) => [name, { kind: 'mapped', fields: populatedLeaves(model.interfaces![name], ['interfaces', name]).map((l) => l.path) }]), ...(vlans ? [['vlans', { kind: 'mapped', fields: populatedLeaves(vlans, ['vlans']).map((l) => l.path) }]] : [])]),
      diagnostics: []
    }),
    describeInterface: (name: string): PortName | undefined => {
      const ae = /^ae(\d+)$/.exec(name)
      if (ae) return { type: 'aggregate', numbers: [Number(ae[1]) + 1] }
      const ge = /^ge-(\d+)\/(\d+)\/(\d+)$/.exec(name)
      return ge ? { type: 'ethernet', speed: 1000, numbers: [Number(ge[1]), Number(ge[2]), Number(ge[3])] } : undefined
    }
  }
}
// NX-OS suggests no Ethernet names: the user gives them.
const names = interfaceInputs({ 'ge-0/0/0': 'Ethernet1/1', 'ge-0/0/1': 'Ethernet1/2', ae0: 'port-channel1' })

describe('link aggregation: Junos → NX-OS through convert', () => {
  it('ae0 with two members becomes port-channel1 with both in the bundle, the mode kept and feature lacp written', () => {
    const before = convert(junosShaped(), plugin, '', context)
    expect(before.interfaces.find((i) => i.source === 'ae0')?.suggestion).toBe('port-channel1')
    expect(before.render?.text).not.toContain('channel-group')

    const after = convert(junosShaped(), plugin, '', { ...context, inputs: names })
    expect(after.render?.text).toBe(lines('feature lacp', '', 'interface Ethernet1/1', '  switchport', '  channel-group 1 mode active', '', 'interface Ethernet1/2', '  switchport', '  channel-group 1 mode active', '', 'interface port-channel1', '  switchport', '  lacp min-links 2', ''))
    expect(after.issues).toEqual([])
    expect(after.unanswered).toEqual([])
    expect(parse(after.render!.text).model).toEqual(after.model)
  })

  it('a routed ae0 makes routed members, as NX-OS needs them to join', () => {
    const after = convert(junosShaped({ subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 30 } } } } } }), plugin, '', { ...context, inputs: names })
    expect(after.render?.text).toBe(lines('feature lacp', '', 'interface Ethernet1/1', '  no switchport', '  channel-group 1 mode active', '', 'interface Ethernet1/2', '  no switchport', '  channel-group 1 mode active', '', 'interface port-channel1', '  no switchport', '  lacp min-links 2', '  ip address 192.0.2.1/30', ''))
    expect(after.issues).toEqual([])
    expect(parse(after.render!.text).model).toEqual(after.model)
  })

  it('a trunk ae0 with an MTU gives its members the same, as NX-OS needs them to join', () => {
    const after = convert(junosShaped({ mtu: 9216, switching: { mode: 'trunk', allowedVlans: ['10'] } }, { '10': { name: 'USERS' } }), plugin, '', { ...context, inputs: names })
    const member = (n: string) => lines(`interface ${n}`, '  switchport', '  switchport mode trunk', '  switchport trunk allowed vlan 10', '  mtu 9216', '  channel-group 1 mode active')
    expect(after.render?.text).toContain(`${member('Ethernet1/1')}\n\n${member('Ethernet1/2')}\n`)
    expect(after.issues).toEqual([])
    // Read back, the members' settings are their port-channel's again: the same model.
    expect(parse(after.render!.text).model).toEqual(after.model)
  })
})

describe('link aggregation: a member matches its port-channel', () => {
  it('a routed port-channel\'s members\' no switchport is written back with it; a member\'s settings that are its port-channel\'s are the port-channel\'s', () => {
    const routed = parse(lines('interface port-channel1', '  no switchport', '  ip address 192.0.2.1/30', 'interface Ethernet1/1', '  no switchport', '  channel-group 1 mode active'))
    expect(routed.dispositions.L5).toEqual({ kind: 'ignored-by-design', reason: 'a member of a routed port-channel, as the port-channel\'s IP configuration says: written back with it' })
    expect(render(routed.model).text).toContain(lines('interface Ethernet1/1', '  no switchport', '  channel-group 1 mode active'))
    const trunk = parse(lines('interface port-channel1', '  switchport mode trunk', '  mtu 9216', 'interface Ethernet1/1', '  switchport mode trunk', '  mtu 9216', '  channel-group 1'))
    expect(trunk.model.interfaces?.['Ethernet1/1']).toEqual({ type: 'ethernet', aggregate: 'port-channel1' })
    expect(trunk.dispositions.L5).toEqual({ kind: 'ignored-by-design', reason: 'its port-channel\'s switch port settings, which each member takes: written back with it' })
    expect(trunk.dispositions.L6).toEqual({ kind: 'ignored-by-design', reason: 'its port-channel\'s MTU, which each member takes: written back with it' })
  })

  it('a member that doesn\'t match its port-channel isn\'t written in it, with why', () => {
    const pc = (extra: Interface = {}): Interface => ({ type: 'aggregate', ...extra })
    const cases: [Interface, Interface, string][] = [
      [pc(), { subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.5': { prefixLength: 30 } } } } } }, 'a member link with IP configuration of its own, which NX-OS refuses: its port-channel has it'],
      [pc({ subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 30 } } } } } }), { switching: { mode: 'access' } }, 'a switch port, which NX-OS refuses in a routed port-channel'],
      [pc({ switching: { mode: 'trunk' } }), { switching: { mode: 'access', accessVlan: 10 } }, 'its switch port settings differ from its port-channel\'s, which NX-OS refuses'],
      [pc({ mtu: 9216 }), { mtu: 1500 }, 'its MTU differs from its port-channel\'s, which NX-OS refuses']
    ]
    for (const [aggregate, member, why] of cases) {
      const out = render({ interfaces: { 'port-channel1': { ...aggregate, aggregation: { lacp: 'active' } }, 'Ethernet1/1': { type: 'ethernet', ...member, aggregate: 'port-channel1' } } })
      expect(out.text, why).not.toContain('channel-group')
      expect(out.text, why).not.toContain('feature lacp')
      expect(out.dispositions['interfaces["Ethernet1/1"].aggregate'], why).toEqual({ kind: 'unsupported', reason: why })
    }
  })
})
