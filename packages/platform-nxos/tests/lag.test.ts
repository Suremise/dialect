// Link aggregation (model 0.5.4, #108): a member's `channel-group N [mode M]` names its port-channel and gives the
// aggregate's LACP mode, `lacp min-links` its minimum links, and `feature lacp` is written whenever either needs it; a
// Junos aggregate converts to a port-channel with its members and mode. The fixture (tests/fixtures/interfaces/lag.cfg)
// round-trips through the kit, and plugin.test.ts's feature guard checks every render has `feature lacp` when it needs it.
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
// two members (`ether-options 802.3ad ae0`). Its describeInterface counts aggregates from 1, as the Junos plugin's does.
const junos: PlatformPlugin = {
  id: 'junos-shaped',
  name: 'Junos (as its parse gives a LAG)',
  modelApi: '>=0.5.4 <1.0.0',
  capabilities: {},
  parse: () => ({
    tree: [{ id: 'ge0', label: 'interfaces ge-0/0/0' }, { id: 'ge1', label: 'interfaces ge-0/0/1' }, { id: 'ae0', label: 'interfaces ae0' }],
    model: {
      interfaces: {
        'ge-0/0/0': { type: 'ethernet', aggregate: 'ae0' },
        'ge-0/0/1': { type: 'ethernet', aggregate: 'ae0' },
        ae0: { type: 'aggregate', aggregation: { lacp: 'active', minLinks: 2 } }
      }
    },
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

describe('link aggregation: Junos → NX-OS through convert', () => {
  it('ae0 with two members becomes port-channel1 with both in the bundle, the mode kept and feature lacp written', () => {
    const before = convert(junos, plugin, '', context)
    expect(before.interfaces.find((i) => i.source === 'ae0')?.suggestion).toBe('port-channel1')
    expect(before.render?.text).not.toContain('channel-group')

    // NX-OS suggests no Ethernet names: the user gives them.
    const map = { 'ge-0/0/0': 'Ethernet1/1', 'ge-0/0/1': 'Ethernet1/2', ae0: 'port-channel1' }
    const after = convert(junos, plugin, '', { ...context, inputs: interfaceInputs(map) })
    expect(after.render?.text).toBe(lines('feature lacp', '', 'interface Ethernet1/1', '  switchport', '  channel-group 1 mode active', '', 'interface Ethernet1/2', '  switchport', '  channel-group 1 mode active', '', 'interface port-channel1', '  switchport', '  lacp min-links 2', ''))
    expect(after.issues).toEqual([])
    expect(after.unanswered).toEqual([])
    expect(parse(after.render!.text).model).toEqual(after.model)
  })
})
