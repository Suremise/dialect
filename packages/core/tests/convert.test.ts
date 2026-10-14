// Convert mode's core: interface names as needs-input items, the rename (keys and references), the interface map's
// two file forms, and the issues by source statement, with two small plugins standing in for real platforms.
import { describe, expect, it } from 'vitest'
import {
  convert,
  fieldPath,
  formatInterfaceMap,
  interfaceInputId,
  interfaceInputs,
  MODEL_VERSION,
  modelInterfaces,
  parseInterfaceMap,
  populatedLeaves,
  renameInterfaces,
  type Device,
  type FieldDisposition,
  type PlatformPlugin,
  type StatementDisposition,
  type SyntaxNode
} from '../src'

const MODEL: Device = {
  system: { hostname: 'r1', ntp: { sourceInterface: 'eth0.0' }, logging: { sourceInterface: 'lo0' } },
  interfaces: {
    eth0: { description: 'uplink', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } },
    lo0: {}
  },
  networkInstances: { default: { staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { interface: 'tun0.5' }, '1': { address: '192.0.2.2', interface: 'eth0.0' } } } } } }
}

// The source's tree: `iface eth0 { … }` and `iface lo0`, a route naming tun0.5 (an interface it never configures),
// and a statement it doesn't convert.
const TREE: SyntaxNode[] = [
  { id: 'host', label: 'host r1', span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 8 } },
  { id: 'ifaces', label: 'ifaces', children: [{ id: 'eth0', label: 'ifaces eth0', children: [{ id: 'eth0-desc', label: 'ifaces eth0 desc' }, { id: 'eth0-addr', label: 'ifaces eth0 addr' }] }, { id: 'lo0', label: 'ifaces lo0' }] },
  { id: 'route', label: 'route', span: { startLine: 9, startColumn: 1, endLine: 9, endColumn: 6 } },
  { id: 'ntp', label: 'ntp source' },
  { id: 'log', label: 'log source' },
  { id: 'bgp', label: 'bgp', span: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 4 } }
]
const ROUTE = ['networkInstances', 'default', 'staticRoutes', '0.0.0.0/0', 'nextHops'] as const
const DISPOSITIONS: Record<string, StatementDisposition> = {
  host: { kind: 'mapped', fields: [fieldPath('system', 'hostname')] },
  ifaces: { kind: 'mapped', fields: [] },
  eth0: { kind: 'mapped', fields: [] },
  'eth0-desc': { kind: 'mapped', fields: [fieldPath('interfaces', 'eth0', 'description')] },
  'eth0-addr': { kind: 'mapped', fields: [fieldPath('interfaces', 'eth0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')] },
  lo0: { kind: 'mapped', fields: [fieldPath('interfaces', 'lo0')] },
  route: { kind: 'mapped', fields: [fieldPath(...ROUTE, '0', 'interface'), fieldPath(...ROUTE, '1', 'address'), fieldPath(...ROUTE, '1', 'interface')] },
  ntp: { kind: 'mapped', fields: [fieldPath('system', 'ntp', 'sourceInterface')] },
  log: { kind: 'mapped', fields: [fieldPath('system', 'logging', 'sourceInterface')] },
  bgp: { kind: 'unsupported', reason: 'routing protocols come later' }
}

const source: PlatformPlugin = {
  id: 'src',
  name: 'Source',
  modelApi: '>=0.2.0 <1.0.0',
  capabilities: {},
  parse: (text) =>
    text === 'broken'
      ? { tree: [], model: {}, dispositions: {}, diagnostics: [{ severity: 'error', message: 'syntax error' }] }
      : { tree: TREE, model: MODEL, dispositions: DISPOSITIONS, diagnostics: [] },
  describeInterface: (name) => {
    const m = /^(eth|lo|tun)(\d+)$/.exec(name)
    if (!m) return undefined
    return m[1] === 'eth' ? { type: 'ethernet', speed: 1000, numbers: [Number(m[2])] } : { type: m[1] === 'lo' ? 'loopback' : 'tunnel', numbers: [Number(m[2])] }
  }
}

/** Renders every leaf as one line `path = value`, except descriptions, which it can't write. */
const target: PlatformPlugin = {
  id: 'dst',
  name: 'Target',
  modelApi: '>=0.2.0 <1.0.0',
  capabilities: {},
  render: (model) => {
    const dispositions: Record<string, FieldDisposition> = {}
    const lines: string[] = []
    for (const leaf of populatedLeaves(model)) {
      if (leaf.path.endsWith('.description')) dispositions[leaf.path] = { kind: 'unsupported', reason: 'no descriptions here' }
      else {
        lines.push(`${leaf.path} = ${JSON.stringify(leaf.value)}`)
        const n = lines.length
        dispositions[leaf.path] = { kind: 'rendered', span: { startLine: n, startColumn: 1, endLine: n, endColumn: lines[n - 1].length + 1 } }
      }
    }
    return { text: lines.join('\n') + '\n', dispositions, diagnostics: [] }
  },
  nameInterface: (port) => (port.type === 'ethernet' ? `Gig${port.numbers.join('/')}` : port.type === 'loopback' ? `Loopback${port.numbers[0]}` : undefined)
}

const run = (inputs?: Record<string, string>, text = 'config') => convert(source, target, text, { modelVersion: MODEL_VERSION, ...(inputs ? { inputs } : {}) })

describe('convert: interface names', () => {
  it('lists every interface the model names, keys first, then those only referenced', () => {
    expect(modelInterfaces(MODEL)).toEqual(['eth0', 'lo0', 'tun0'])
  })

  it('makes each interface a needs-input item, with the target plugin\'s suggestion and its statement', () => {
    const c = run()
    expect(c.ledger.needsInput).toEqual([
      { id: 'interface:eth0', kind: 'interface-name', message: 'Name eth0 on Target.', field: 'interfaces.eth0', statement: 'eth0', suggestions: ['Gig0'] },
      { id: 'interface:lo0', kind: 'interface-name', message: 'Name lo0 on Target.', field: 'interfaces.lo0', statement: 'lo0', suggestions: ['Loopback0'] },
      // Only referenced: its statement is the route that names it, and the target has no suggestion for a tunnel.
      { id: 'interface:tun0', kind: 'interface-name', message: 'Name tun0 on Target.', statement: 'route' }
    ])
    expect(c.unanswered.map((i) => i.id)).toEqual(['interface:eth0', 'interface:lo0', 'interface:tun0'])
    // Unanswered, they keep their names: a suggestion is never used unasked.
    expect(c.render?.text).toContain('interfaces.lo0 = {}')
    expect(c.render?.text).not.toContain('Gig0')
  })

  it('renames the answered interfaces, as keys and in references (a subinterface reference keeps its index)', () => {
    const c = run(interfaceInputs({ eth0: 'Gig0', lo0: 'Loopback0', tun0: ' Tunnel9 ' }))
    expect(c.unanswered).toEqual([])
    expect(c.interfaces.map((i) => [i.source, i.target])).toEqual([
      ['eth0', 'Gig0'],
      ['lo0', 'Loopback0'],
      ['tun0', 'Tunnel9']
    ])
    expect(Object.keys(c.model.interfaces ?? {})).toEqual(['Gig0', 'Loopback0'])
    expect(c.model.system?.ntp?.sourceInterface).toBe('Gig0.0')
    expect(c.model.system?.logging?.sourceInterface).toBe('Loopback0')
    expect(c.model.networkInstances?.default.staticRoutes?.['0.0.0.0/0'].nextHops).toEqual({ '0': { interface: 'Tunnel9.5' }, '1': { address: '192.0.2.2', interface: 'Gig0.0' } })
    expect(c.ledger.complete).toBe(true)
    // Every leaf is kept, by its new path.
    expect(populatedLeaves(c.model).length).toBe(populatedLeaves(MODEL).length)
  })

  it('counts an empty answer as none, and refuses one name for two interfaces', () => {
    const c = run({ [interfaceInputId('eth0')]: 'X', [interfaceInputId('lo0')]: 'X', [interfaceInputId('tun0')]: '  ' })
    expect(c.unanswered.map((i) => i.id)).toEqual(['interface:eth0', 'interface:lo0', 'interface:tun0'])
    expect(c.ledger.diagnostics).toEqual([
      { severity: 'error', category: 'other', code: 'convert.interface-name-taken', message: '2 interfaces are given the one name X: eth0, lo0. Give each its own.' }
    ])
    expect(Object.keys(c.model.interfaces ?? {})).toEqual(['eth0', 'lo0'])
  })

  it('renames a key that is __proto__ like any other, leaving Object.prototype alone', () => {
    const model = JSON.parse('{"interfaces":{"__proto__":{"description":"x"}}}') as Device
    const renamed = renameInterfaces(model, JSON.parse('{"__proto__":"Gig1"}') as Record<string, string>)
    expect(Object.keys(renamed.interfaces ?? {})).toEqual(['Gig1'])
    const back = renameInterfaces(renamed, { Gig1: '__proto__' })
    expect(Object.hasOwn(back.interfaces ?? {}, '__proto__')).toBe(true)
    expect(Object.prototype).not.toHaveProperty('description')
  })
})

describe('convert: issues and the parse', () => {
  it('lists, by source statement, what was not converted and what the target could not write, renamed or not', () => {
    for (const inputs of [undefined, interfaceInputs({ eth0: 'Gig0' })]) {
      expect(run(inputs).issues).toEqual([
        { statement: 'eth0-desc', kind: 'not-rendered', reason: 'no descriptions here' },
        { statement: 'bgp', span: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 4 }, kind: 'unsupported', reason: 'routing protocols come later' }
      ])
    }
  })

  it("links each statement to the output lines of the fields it filled, by the fields' new names", () => {
    const c = run(interfaceInputs({ eth0: 'Gig0' }))
    const lines = c.render!.text.split('\n')
    const linked = c.links.map((l) => [l.statement, lines[l.output.startLine - 1]])
    expect(linked).toContainEqual(['eth0-addr', 'interfaces.Gig0.subinterfaces["0"].ipv4.addresses["192.0.2.1"].prefixLength = 24'])
    expect(linked).toContainEqual(['lo0', 'interfaces.lo0 = {}'])
    expect(linked).toContainEqual(['ntp', 'system.ntp.sourceInterface = "Gig0.0"'])
    // The description wasn't written, so it links nowhere.
    expect(c.links.some((l) => l.statement === 'eth0-desc')).toBe(false)
    expect(c.links.length).toBe(8)
  })

  it('renders nothing after a parse error', () => {
    const c = run(undefined, 'broken')
    expect(c.render).toBeUndefined()
    expect(c.ledger.target).toBeUndefined()
    expect(c.ledger.diagnostics).toEqual([{ severity: 'error', message: 'syntax error' }])
  })

  it('refuses plugins that cannot parse or render', () => {
    expect(() => convert(target, target, '', { modelVersion: MODEL_VERSION })).toThrow('Plugin "dst" can\'t parse.')
    expect(() => convert(source, source, '', { modelVersion: MODEL_VERSION })).toThrow('Plugin "src" can\'t render.')
  })
})

describe('the interface map file', () => {
  it('reads from,to lines with comments, blank lines, spaces, CRLF and a byte order mark', () => {
    expect(parseInterfaceMap('﻿# Junos,IOS\r\nge-0/0/0, GigabitEthernet0/0/0\r\n\r\n  lo0 ,Loopback0  # the loopback\r\n')).toEqual({
      map: { 'ge-0/0/0': 'GigabitEthernet0/0/0', lo0: 'Loopback0' },
      problems: []
    })
  })

  it('reads a JSON object of names', () => {
    expect(parseInterfaceMap('{ "ge-0/0/0": "GigabitEthernet0/0/0", "__proto__": "Gi1" }').map).toEqual(JSON.parse('{ "ge-0/0/0": "GigabitEthernet0/0/0", "__proto__": "Gi1" }'))
  })

  it('says what is wrong, by line', () => {
    expect(parseInterfaceMap('a,b\nc\nd,e,f\n,g\na,c\n').problems).toEqual(['line 2: expected from,to', 'line 3: expected from,to', 'line 4: expected from,to', 'line 5: a is mapped twice'])
    expect(parseInterfaceMap('{ "a": 1, "b": "" }').problems).toEqual(['a: give the target name as a string', 'b: give the target name as a string'])
    expect(parseInterfaceMap('{ nope').problems).toEqual(['not valid JSON'])
    expect(parseInterfaceMap('[]').problems).toEqual(['the JSON is not an object of interface names'])
  })

  it('writes the form it reads', () => {
    const map = { 'ge-0/0/0': 'GigabitEthernet0/0/0', lo0: 'Loopback0' }
    expect(formatInterfaceMap(map)).toBe('ge-0/0/0,GigabitEthernet0/0/0\nlo0,Loopback0\n')
    expect(parseInterfaceMap(formatInterfaceMap(map)).map).toEqual(map)
  })
})
