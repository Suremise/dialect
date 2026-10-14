// Link aggregation (model 0.5.4, #108): a member's `channel-group N mode M` names its Port-channel and gives the
// aggregate's LACP mode, `port-channel min-links` its minimum links; and a Junos aggregate converts to a Port-channel
// with its members and mode. The fixture (tests/fixtures/interfaces/lag.cfg) round-trips through the kit.
import { describe, expect, it } from 'vitest'
import { convert, interfaceInputs, MODEL_VERSION, statementsOf, type Device, type PlatformPlugin, type PortName, type StatementDisposition } from '@dialect/core'
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
  it('members that agree give their Port-channel its mode; no mode says nothing', () => {
    const result = parse(lines('interface Port-channel1', 'interface Gi1', ' channel-group 1 mode active', 'interface Gi2', ' channel-group 1 mode active', 'interface Gi3', ' channel-group 2 mode on', 'interface Gi4', ' channel-group 5'))
    expect(result.diagnostics).toEqual([])
    expect(result.model.interfaces?.Gi1?.aggregate).toBe('Port-channel1')
    expect(result.model.interfaces?.Gi2?.aggregate).toBe('Port-channel1')
    expect(result.model.interfaces?.['Port-channel1']?.aggregation).toEqual({ lacp: 'active' })
    expect(result.model.interfaces?.['Port-channel2']).toEqual({ type: 'aggregate', aggregation: { lacp: 'static' } })
    expect(result.model.interfaces?.['Port-channel5']).toEqual({ type: 'aggregate' })
    expect(at(result, 'interface Gi1 channel-group 1 mode active')).toEqual({ kind: 'mapped', fields: ['interfaces.Gi1.aggregate', 'interfaces["Port-channel1"].aggregation.lacp'] })
    // The Port-channel the text doesn't configure is made by its members, as IOS does, and mapped by them.
    expect(at(result, 'interface Gi3 channel-group 2 mode on')).toEqual({ kind: 'mapped', fields: ['interfaces.Gi3.aggregate', 'interfaces["Port-channel2"].type', 'interfaces["Port-channel2"].aggregation.lacp'] })
  })

  it('a member names the Port-channel as the text writes it', () => {
    const result = parse(lines('interface Po7', ' description bundle', 'interface Gi1', ' channel-group 7 mode passive'))
    expect(result.model.interfaces?.Gi1?.aggregate).toBe('Po7')
    expect(result.model.interfaces?.Po7?.aggregation).toEqual({ lacp: 'passive' })
    expect(Object.keys(result.model.interfaces ?? {})).toEqual(['Po7', 'Gi1'])
  })

  it('members with different modes are left out, with an error that names lines only', () => {
    for (const [a, b] of [['mode active', 'mode passive'], ['mode active', 'mode on'], ['mode passive', '']]) {
      const result = parse(lines('interface Gi1', ` channel-group 3 ${a}`.trimEnd(), 'interface Gi2', ` channel-group 3 ${b}`.trimEnd()))
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'iosxe.channel-group-modes', message: 'The members of one channel group give different modes (lines 2, 4): IOS bundles them with one.', statement: 'L2' })])
      expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'its channel group\'s members give different modes (lines 2, 4): left out' })
      expect(result.dispositions.L4).toEqual(result.dispositions.L2)
      expect(result.model.interfaces).toEqual({ Gi1: { type: 'ethernet' }, Gi2: { type: 'ethernet' } })
    }
    // `on` and no mode both bundle without LACP: they agree.
    const agree = parse(lines('interface Gi1', ' channel-group 3 mode on', 'interface Gi2', ' channel-group 3'))
    expect(agree.diagnostics).toEqual([])
    expect(agree.model.interfaces?.['Port-channel3']?.aggregation).toEqual({ lacp: 'static' })
  })

  it('no channel-group takes the member out; a later channel group supersedes an earlier one', () => {
    const removed = parse(lines('interface Gi1', ' channel-group 1 mode active', ' no channel-group'))
    expect(removed.model.interfaces).toEqual({ Gi1: { type: 'ethernet' } })
    expect(removed.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
    expect(removed.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'takes the interface out of the channel group on line 2: nothing to convert' })
    const named = parse(lines('interface Gi1', ' channel-group 1 mode active', ' no channel-group 1 mode active'))
    expect(named.model.interfaces).toEqual({ Gi1: { type: 'ethernet' } })
    const other = parse(lines('interface Gi1', ' channel-group 1 mode active', ' no channel-group 2'))
    expect(other.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'not in that channel group: nothing to convert' })
    expect(other.model.interfaces?.Gi1?.aggregate).toBe('Port-channel1')
    expect(parse(lines('interface Gi1', ' no channel-group')).dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'not in a channel group: nothing to convert' })
    const moved = parse(lines('interface Gi1', ' channel-group 1 mode active', ' channel-group 2 mode passive'))
    expect(moved.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    expect(moved.model.interfaces?.Gi1?.aggregate).toBe('Port-channel2')
    expect(moved.model.interfaces?.['Port-channel1']).toBeUndefined()
  })

  it('a malformed group number, a mode IOS\'s LACP doesn\'t have, or a member that can\'t be one, puts nothing in the model', () => {
    const cases: [string, string, string | undefined][] = [
      ['interface Gi1', ' channel-group 0 mode active', 'not a channel group number from 1 to 4096'],
      ['interface Gi1', ' channel-group 4097 mode active', 'not a channel group number from 1 to 4096'],
      ['interface Gi1', ' channel-group one mode active', 'not a channel group number from 1 to 4096'],
      ['interface Gi1', ' channel-group 1 mode desirable', 'PAgP, which the model doesn\'t have (only LACP and static)'],
      ['interface Gi1', ' channel-group 1 mode auto', 'PAgP, which the model doesn\'t have (only LACP and static)'],
      ['interface Gi1', ' channel-group 1 mode fast', undefined],
      ['interface Gi1', ' channel-group 1 active', undefined],
      ['interface Gi1.10', ' channel-group 1 mode active', 'a subinterface isn\'t a member link: its main interface is'],
      ['interface Loopback0', ' channel-group 1 mode active', 'only an Ethernet interface is a member link of a Port-channel'],
      ['interface Port-channel2', ' channel-group 1 mode active', 'only an Ethernet interface is a member link of a Port-channel'],
      ['interface Port-channel1', ' port-channel min-links 0', 'not a number of links from 1 to 16'],
      ['interface Port-channel1', ' port-channel min-links 17', 'not a number of links from 1 to 16'],
      ['interface Gi1', ' port-channel min-links 2', 'only a Port-channel has minimum links']
    ]
    for (const [iface, statement, reason] of cases) {
      const result = parse(lines(iface, statement))
      expect(result.dispositions.L2, statement).toMatchObject({ kind: 'unsupported', ...(reason ? { reason } : {}) })
      // No membership, no LAG settings and no Port-channel made: only the interface the statement is on.
      expect(Object.values(result.model.interfaces ?? {}).some((i) => i.aggregate !== undefined || i.aggregation !== undefined), statement).toBe(false)
      expect(Object.keys(result.model.interfaces ?? {}), statement).toHaveLength(1)
    }
  })

  it('port-channel min-links: set, superseded and removed', () => {
    const result = parse(lines('interface Port-channel1', ' port-channel min-links 2', ' port-channel min-links 3'))
    expect(result.model.interfaces?.['Port-channel1']?.aggregation).toEqual({ minLinks: 3 })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    const removed = parse(lines('interface Port-channel1', ' port-channel min-links 2', ' no port-channel min-links'))
    expect(removed.model.interfaces?.['Port-channel1']).toEqual({ type: 'aggregate' })
    expect(removed.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removes the setting on line 2: nothing to convert' })
  })
})

describe('link aggregation: render', () => {
  const lag = (lacp?: 'active' | 'passive' | 'static', name = 'Port-channel1'): Device => ({
    interfaces: { [name]: { type: 'aggregate', ...(lacp ? { aggregation: { lacp } } : {}) }, Gi1: { type: 'ethernet', aggregate: name }, Gi2: { type: 'ethernet', aggregate: name } }
  })

  it('writes the mode on each member, the aggregate\'s field on the first', () => {
    for (const [lacp, mode] of [['active', ' mode active'], ['passive', ' mode passive'], ['static', ' mode on'], [undefined, '']] as const) {
      const out = render(lag(lacp))
      expect(out.text).toContain(`interface Gi1\n channel-group 1${mode}\n`)
      expect(out.text).toContain(`interface Gi2\n channel-group 1${mode}\n`)
      expect(out.dispositions['interfaces.Gi1.aggregate']).toMatchObject({ kind: 'rendered' })
      if (lacp) expect(out.dispositions['interfaces["Port-channel1"].aggregation.lacp']).toEqual(out.dispositions['interfaces.Gi1.aggregate'])
    }
  })

  it('leaves out what IOS can\'t say, with why', () => {
    const misnamed = render(lag('active', 'ae0'))
    expect(misnamed.text).not.toContain('channel-group')
    expect(misnamed.dispositions['interfaces.Gi1.aggregate']).toEqual({ kind: 'unsupported', reason: 'IOS bundles a member into the Port-channel of its number, from 1 to 4096, and this aggregate isn\'t named so' })
    expect(misnamed.dispositions['interfaces.ae0.aggregation.lacp']).toEqual({ kind: 'unsupported', reason: 'IOS gives the LACP mode on each member link, and no member of this aggregate is written' })
    const alone = render({ interfaces: { 'Port-channel1': { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 20 } } } })
    expect(alone.dispositions['interfaces["Port-channel1"].aggregation.lacp']).toMatchObject({ kind: 'unsupported' })
    expect(alone.dispositions['interfaces["Port-channel1"].aggregation.minLinks']).toEqual({ kind: 'unsupported', reason: 'not a number of links from 1 to 16' })
    const loopback = render({ interfaces: { 'Port-channel1': { type: 'aggregate' }, Loopback0: { type: 'loopback', aggregate: 'Port-channel1' } } })
    expect(loopback.dispositions['interfaces.Loopback0.aggregate']).toEqual({ kind: 'unsupported', reason: 'only an Ethernet interface is a member link on IOS' })
  })
})

describe('link aggregation: a member matches its Port-channel', () => {
  it('a member with no switch port settings or MTU of its own takes its Port-channel\'s; read back, they are the Port-channel\'s', () => {
    const model: Device = { vlans: { '10': {} }, interfaces: { 'Port-channel1': { type: 'aggregate', mtu: 9216, switching: { mode: 'trunk', allowedVlans: ['10'] } }, Gi1: { type: 'ethernet', aggregate: 'Port-channel1' } } }
    const out = render(model)
    expect(out.text).toContain(lines('interface Gi1', ' mtu 9216', ' switchport', ' switchport trunk allowed vlan 10', ' switchport mode trunk', ' channel-group 1', '!'))
    expect(parse(out.text).model).toEqual(model)
    const read = parse(out.text)
    expect(at(read, 'interface Gi1 switchport mode trunk')).toEqual({ kind: 'ignored-by-design', reason: 'its Port-channel\'s switch port settings, which each member takes: written back with it' })
    expect(at(read, 'interface Gi1 mtu 9216')).toEqual({ kind: 'ignored-by-design', reason: 'its Port-channel\'s MTU, which each member takes: written back with it' })
  })

  it('a member whose own differ isn\'t written in it, with why', () => {
    const cases: [Device['interfaces'], string][] = [
      [{ 'Port-channel1': { type: 'aggregate', switching: { mode: 'trunk' } }, Gi1: { type: 'ethernet', switching: { mode: 'access' }, aggregate: 'Port-channel1' } }, 'its switch port settings differ from its Port-channel\'s, which IOS refuses'],
      [{ 'Port-channel1': { type: 'aggregate', mtu: 9216 }, Gi1: { type: 'ethernet', mtu: 1500, aggregate: 'Port-channel1' } }, 'its MTU differs from its Port-channel\'s, which IOS refuses']
    ]
    for (const [interfaces, why] of cases) {
      const out = render({ interfaces })
      expect(out.text, why).not.toContain('channel-group')
      expect(out.dispositions['interfaces.Gi1.aggregate'], why).toEqual({ kind: 'unsupported', reason: why })
    }
  })
})

// A Junos aggregate as the Junos plugin's parse gives it (model 0.5.4): `ae0` with LACP active and minimum links 2, and
// two members (`ether-options 802.3ad ae0`). Its describeInterface counts aggregates from 1, as the Junos plugin's does.
const junosModel: Device = {
  interfaces: {
    'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' },
    'ge-0/0/1': { type: 'ethernet', aggregate: 'ae0' },
    ae0: { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 2 } }
  }
}
const junos: PlatformPlugin = {
  id: 'junos-shaped',
  name: 'Junos (as its parse gives a LAG)',
  modelApi: '>=0.5.4 <1.0.0',
  capabilities: {},
  parse: () => ({
    tree: [{ id: 'ge0', label: 'interfaces ge-0/0/0' }, { id: 'ge1', label: 'interfaces ge-0/0/1' }, { id: 'ae0', label: 'interfaces ae0' }],
    model: junosModel,
    dispositions: {
      ge0: { kind: 'mapped', fields: ['interfaces["ge-0/0/0"].type', 'interfaces["ge-0/0/0"].aggregate'] },
      ge1: { kind: 'mapped', fields: ['interfaces["ge-0/0/1"].type', 'interfaces["ge-0/0/1"].aggregate'] },
      ae0: { kind: 'mapped', fields: ['interfaces.ae0.type', 'interfaces.ae0.aggregation.lacp', 'interfaces.ae0.aggregation.minLinks'] }
    },
    diagnostics: []
  }),
  describeInterface: (name: string): PortName | undefined => {
    const ae = /^ae(\d+)$/.exec(name)
    if (ae) return { type: 'aggregate', numbers: [Number(ae[1]) + 1] }
    const ge = /^ge-(\d+)\/(\d+)\/(\d+)$/.exec(name)
    return ge ? { type: 'ethernet', speed: 1000, numbers: [Number(ge[1]), Number(ge[2]), Number(ge[3])] } : undefined
  }
}

describe('link aggregation: Junos → IOS-XE through convert', () => {
  it('ae0 with two members becomes Port-channel1 with both in the bundle and the mode kept', () => {
    const before = convert(junos, plugin, '', context)
    expect(before.interfaces.map((i) => [i.source, i.suggestion])).toEqual([['ge-0/0/0', 'GigabitEthernet0/0/0'], ['ge-0/0/1', 'GigabitEthernet0/0/1'], ['ae0', 'Port-channel1']])
    // Not renamed until the user takes the suggestions: an aggregate named ae0 can't be written as a channel group.
    expect(before.render?.text).not.toContain('channel-group')

    const map = Object.fromEntries(before.interfaces.map((i) => [i.source, i.suggestion!]))
    const after = convert(junos, plugin, '', { ...context, inputs: interfaceInputs(map) })
    expect(after.render?.text).toBe(lines('interface GigabitEthernet0/0/0', ' channel-group 1 mode active', '!', 'interface GigabitEthernet0/0/1', ' channel-group 1 mode active', '!', 'interface Port-channel1', ' port-channel min-links 2', '!', 'end', ''))
    expect(after.issues).toEqual([])
    expect(after.unanswered).toEqual([])
    // And back: IOS-XE's parse of it is the same LAG under the new names.
    expect(parse(after.render!.text).model).toEqual(after.model)
  })
})
