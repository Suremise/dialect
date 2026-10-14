// The core contracts: field paths, the ledger's two completeness checks, the registry's modelApi check and the model's
// JSON form.
import { describe, expect, it } from 'vitest'
import {
  buildLedger,
  checkFields,
  checkStatements,
  createRegistry,
  deserializeModel,
  fieldPath,
  ledgerProblems,
  MODEL_VERSION,
  modelVersionProblem,
  pathSegments,
  PluginRejectedError,
  populatedLeaves,
  serializeModel,
  type Device,
  type ParseResult,
  type PlatformPlugin,
  type SyntaxNode
} from '../src'

describe('field paths', () => {
  it('spells identifiers with dots, other keys quoted, and indexes in brackets', () => {
    expect(fieldPath('interfaces', 'ge-0/0/0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')).toBe(
      'interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.addresses["192.0.2.1"].prefixLength'
    )
    expect(fieldPath('networkInstances', 'default', 'staticRoutes', '0.0.0.0/0')).toBe('networkInstances.default.staticRoutes["0.0.0.0/0"]')
    expect(fieldPath('list', 0, 'a')).toBe('list[0].a')
    expect(fieldPath('k', 'with "quote"')).toBe('k["with \\"quote\\""]')
  })

  it('reads a path back into its segments, and refuses one fieldPath() wouldn\'t make', () => {
    for (const segments of [['interfaces', 'ge-0/0/0', 'description'], ['a', 0, 'b'], ['k', 'with "quote"'], ['x', '0']])
      expect(pathSegments(fieldPath(...segments))).toEqual(segments)
    for (const bad of ['.a', 'a..b', 'a["b"', 'a[x]', 'a.["b"]', 'a b', 'a["b"]c', 'a["ok"]'.replace('ok', 'o"k')]) expect(() => pathSegments(bad), bad).toThrow(SyntaxError)
    expect(() => pathSegments('a["b"]')).toThrow(SyntaxError) // b is an identifier: fieldPath() writes a.b
  })

  it('lists every populated leaf: primitives and leaf-lists, not null or undefined', () => {
    const model = { system: { hostname: 'r1' }, snmp: { communities: { public: { clients: ['192.0.2.0/24'], access: undefined } } }, x: null, list: [{ a: 1 }], flags: [] }
    expect(populatedLeaves(model)).toEqual([
      { path: 'system.hostname', value: 'r1' },
      { path: 'snmp.communities.public.clients', value: ['192.0.2.0/24'] },
      { path: 'list[0].a', value: 1 },
      { path: 'flags', value: [] }
    ])
  })

  it('counts an entry configured with nothing in it as a leaf valued {}: its key is the configuration', () => {
    const model: Device = {
      system: { ntp: { servers: { '192.0.2.1': {} } }, logging: { remoteServers: { '192.0.2.2': {} } }, snmp: { communities: { public: {}, other: { access: undefined } } } },
      interfaces: { lo0: {}, 'ge-0/0/0': { subinterfaces: { '0': {} } } }
    }
    expect(populatedLeaves(model)).toEqual([
      { path: 'system.ntp.servers["192.0.2.1"]', value: {} },
      { path: 'system.logging.remoteServers["192.0.2.2"]', value: {} },
      { path: 'system.snmp.communities.public', value: {} },
      { path: 'system.snmp.communities.other', value: {} },
      { path: 'interfaces.lo0', value: {} },
      { path: 'interfaces["ge-0/0/0"].subinterfaces["0"]', value: {} }
    ])
    // An entry with something in it is accounted for through that, not twice; absence is no leaf; the model itself isn't.
    expect(populatedLeaves({ system: { ntp: { servers: { '192.0.2.1': { prefer: true } } } } })).toEqual([{ path: 'system.ntp.servers["192.0.2.1"].prefer', value: true }])
    expect(populatedLeaves({ system: { ntp: { servers: {} } } })).toEqual([{ path: 'system.ntp.servers', value: {} }])
    expect(populatedLeaves({})).toEqual([])
  })
})

const node = (id: string, children?: SyntaxNode[]): SyntaxNode => ({ id, label: id, ...(children ? { children } : {}) })

describe('the ledger: source side, per statement', () => {
  const tree = [node('system', [node('system host-name r1'), node('system services', [node('system services ssh')])]), node('version 1')]

  it('reports every statement with no disposition, children included, in tree order', () => {
    const c = checkStatements(tree, { system: { kind: 'mapped', fields: [] }, 'system host-name r1': { kind: 'mapped', fields: ['system.hostname'] }, 'version 1': { kind: 'ignored-by-design', reason: 'version' } })
    expect(c.unmapped.map((s) => s.id)).toEqual(['system services', 'system services ssh'])
    expect(c.statements).toHaveLength(5)
  })

  it('reports dispositions for ids not in the tree, and ids the tree has twice', () => {
    const c = checkStatements([node('a'), node('a')], { a: { kind: 'unsupported' }, ghost: { kind: 'unsupported' } })
    expect(c.strayIds).toEqual(['ghost'])
    expect(c.duplicateIds).toEqual(['a'])
    expect(buildLedger({ tree: [node('a'), node('a')], model: {}, dispositions: { a: { kind: 'unsupported' } }, diagnostics: [] }).complete).toBe(false)
  })

  it('doesn\'t take a disposition from the prototype chain', () => {
    expect(checkStatements([node('toString')], {}).unmapped.map((s) => s.id)).toEqual(['toString'])
  })
})

describe('the ledger: model side, per populated leaf', () => {
  const model = { system: { hostname: 'r1', domainName: 'example.net' } } as Device

  it('reports every leaf with no disposition; an object\'s disposition covers no leaf and is stray', () => {
    const c = checkFields(model, { system: { kind: 'rendered' }, 'system.hostname': { kind: 'rendered' } })
    expect(c.unrendered.map((f) => f.path)).toEqual(['system.domainName'])
    expect(c.strayPaths).toEqual(['system'])
  })

  it('an empty entry a renderer drops leaves the ledger incomplete; accounted for, it is complete', () => {
    const entries: Device = { system: { ntp: { servers: { '192.0.2.1': {} } }, logging: { remoteServers: { '192.0.2.2': {} } }, snmp: { communities: { public: {} } } }, interfaces: { lo0: {} } }
    const paths = ['system.ntp.servers["192.0.2.1"]', 'system.logging.remoteServers["192.0.2.2"]', 'system.snmp.communities.public', 'interfaces.lo0']
    const parse: ParseResult = { tree: [], model: entries, dispositions: {}, diagnostics: [] }
    const dropped = buildLedger(parse, { text: '', dispositions: {}, diagnostics: [] })
    expect(dropped.complete).toBe(false)
    expect(ledgerProblems(dropped)).toEqual(paths.map((p) => `unrendered: ${p}`))
    const careful = buildLedger(parse, { text: '…', dispositions: Object.fromEntries(paths.map((p) => [p, { kind: 'rendered' as const }])), diagnostics: [] })
    expect(careful.complete).toBe(true)
  })

  it('counts unsupported and not-applicable as accounted for', () => {
    const c = checkFields(model, { 'system.hostname': { kind: 'unsupported', reason: 'x' }, 'system.domainName': { kind: 'not-applicable', reason: 'y' } })
    expect(c.unrendered).toEqual([])
  })
})

describe('buildLedger', () => {
  const parse: ParseResult = {
    tree: [node('a'), node('b')],
    model: { system: { hostname: 'r1' } },
    dispositions: { a: { kind: 'mapped', fields: ['system.hostname'] } },
    diagnostics: [{ severity: 'warning', message: 'from parse' }],
    needsInput: [{ id: 'if:ge-0/0/0', kind: 'interface-name', message: 'name ge-0/0/0 on the target' }]
  }

  it('is complete only when nothing is unmapped or unrendered, and gathers both sides\' diagnostics and needs-input', () => {
    const ledger = buildLedger(parse, { text: '', dispositions: {}, diagnostics: [{ severity: 'info', category: 'semantic', message: 'from render' }] })
    expect(ledger.complete).toBe(false)
    expect(ledgerProblems(ledger)).toEqual(['unmapped: b', 'unrendered: system.hostname'])
    expect(ledger.diagnostics.map((d) => d.message)).toEqual(['from parse', 'from render'])
    expect(ledger.needsInput.map((n) => n.id)).toEqual(['if:ge-0/0/0'])
    const done = buildLedger({ ...parse, dispositions: { ...parse.dispositions, b: { kind: 'unsupported' } } }, { text: 'x', dispositions: { 'system.hostname': { kind: 'rendered' } }, diagnostics: [] })
    expect(done.complete).toBe(true)
    expect(ledgerProblems(done)).toEqual([])
  })

  it('without a render, checks the source side only', () => {
    const ledger = buildLedger({ ...parse, dispositions: { a: { kind: 'unsupported' }, b: { kind: 'unsupported' } } })
    expect(ledger.target).toBeUndefined()
    expect(ledger.complete).toBe(true)
  })
})

const plugin = (overrides: Partial<PlatformPlugin> = {}): PlatformPlugin => ({ id: 'test', name: 'Test', modelApi: '>=0.1.0 <1.0.0', capabilities: {}, ...overrides })

describe('the registry', () => {
  it('rejects a plugin whose modelApi doesn\'t cover the model, naming both versions', () => {
    const tooNew = plugin({ id: 'junos', modelApi: '>=1.2.0 <2.0.0' })
    expect(() => createRegistry([tooNew])).toThrow(PluginRejectedError)
    expect(() => createRegistry([tooNew])).toThrow(`Plugin "junos" supports model versions >=1.2.0 <2.0.0, but this core's model is ${MODEL_VERSION}.`)
    expect(() => createRegistry([plugin({ modelApi: '^0.1.0' })], { modelVersion: '0.2.0' })).toThrow('Plugin "test" supports model versions ^0.1.0, but this core\'s model is 0.2.0.')
  })

  it('rejects an invalid modelApi, a duplicate id and two tools with one id', () => {
    expect(() => createRegistry([plugin({ modelApi: 'latest' })])).toThrow(`Plugin "test" gives no valid model version range (modelApi "latest"); this core's model is ${MODEL_VERSION}.`)
    expect(() => createRegistry([plugin(), plugin()])).toThrow('Two plugins have the id "test".')
    const tool = { id: 'display-set', name: 'Display set', run: () => ({ text: '', diagnostics: [] }) }
    expect(() => createRegistry([plugin({ tools: () => [tool, tool] })])).toThrow('Plugin "test" has two tools with the id "display-set".')
  })

  it('loads a plugin in range, and lists sources, targets, tools and detections', () => {
    const tool = { id: 'display-set', name: 'Display set', run: (input: string) => ({ text: input.toUpperCase(), diagnostics: [] }) }
    const parse = () => ({ tree: [], model: {}, dispositions: {}, diagnostics: [] })
    const a = plugin({ id: 'a', parse, detect: (t) => (t.includes('{') ? 0.9 : 0), tools: () => [tool] })
    const b = plugin({ id: 'b', render: () => ({ text: '', dispositions: {}, diagnostics: [] }), detect: () => 2 })
    const registry = createRegistry([a, b])
    expect(registry.modelVersion).toBe(MODEL_VERSION)
    expect(registry.get('a')).toBe(a)
    expect(registry.sources().map((p) => p.id)).toEqual(['a'])
    expect(registry.targets().map((p) => p.id)).toEqual(['b'])
    expect(registry.tools().map((t) => `${t.plugin.id}/${t.tool.id}`)).toEqual(['a/display-set'])
    expect(registry.tools()[0].tool.run('x').text).toBe('X')
    expect(registry.detect('a {').map((d) => [d.plugin.id, d.score])).toEqual([['b', 1], ['a', 0.9]])
    expect(registry.detect('plain').map((d) => d.plugin.id)).toEqual(['b'])
  })
})

describe('the model as JSON', () => {
  const device: Device = { system: { hostname: 'r1' }, interfaces: { 'ge-0/0/0': { description: 'uplink', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } } }

  it('round-trips with the model version it was made with', () => {
    const text = serializeModel(device)
    expect(JSON.parse(text).modelVersion).toBe(MODEL_VERSION)
    expect(text.endsWith('}\n')).toBe(true)
    expect(deserializeModel(text)).toEqual({ modelVersion: MODEL_VERSION, device })
    expect(deserializeModel(JSON.parse(text)).device).toEqual(device)
  })

  it('reads an older minor version, and refuses a newer one, another major, or no version', () => {
    expect(modelVersionProblem('0.1.0', '0.3.0')).toBeNull()
    expect(modelVersionProblem('0.4.0', '0.3.0')).toBe('The model document was made with model 0.4.0, newer than this core\'s 0.3.0.')
    expect(modelVersionProblem('1.0.0', '0.3.0')).toBe('The model document was made with model 1.0.0, and this core\'s model is 0.3.0: a different major version.')
    expect(() => deserializeModel('{"device":{}}')).toThrow('The model document has no valid modelVersion (undefined).')
    expect(() => deserializeModel(`{"modelVersion":"${MODEL_VERSION}","device":[]}`)).toThrow('A model document has a "device" object.')
    expect(() => deserializeModel('[]')).toThrow('A model document is a JSON object.')
  })
})
