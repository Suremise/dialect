// Keys are whatever a configuration says, so `__proto__`, `constructor` and `toString` must be ordinary keys to the
// core: through JSON, field paths and both ledger checks, with nothing read from or written to Object.prototype.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildLedger,
  checkFields,
  checkStatements,
  createRegistry,
  deserializeModel,
  fieldPath,
  MODEL_VERSION,
  pathSegments,
  populatedLeaves,
  serializeModel,
  type Device,
  type FieldDisposition,
  type ParseResult,
  type StatementDisposition,
  type SyntaxNode
} from '../src'

const KEYS = ['__proto__', 'constructor', 'toString'] as const

/** Object.prototype as it was before the tests, to show none of them changed it. */
let before: Map<string | symbol, PropertyDescriptor | undefined>
const prototypeNow = () => new Map(Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)]))
beforeAll(() => {
  before = prototypeNow()
})
afterAll(() => {
  expect(prototypeNow()).toEqual(before)
})

/** A model with `key` as an interface, a VRF, an SNMP community and a DNS server. Computed keys are own properties. */
const deviceWith = (key: string): Device => ({
  system: {
    snmp: { communities: { [key]: { access: 'read-only' } } },
    dns: { servers: { [key]: {}, '192.0.2.53': { networkInstance: key } }, search: ['example.net'] }
  },
  interfaces: { [key]: { description: 'uplink', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } },
  networkInstances: { [key]: { type: 'vrf', staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { address: '192.0.2.254' } } } } } }
})

const expectedPaths = (key: string) => [
  fieldPath('system', 'snmp', 'communities', key, 'access'),
  fieldPath('system', 'dns', 'servers', key),
  fieldPath('system', 'dns', 'servers', '192.0.2.53', 'networkInstance'),
  fieldPath('system', 'dns', 'search'),
  fieldPath('interfaces', key, 'description'),
  fieldPath('interfaces', key, 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength'),
  fieldPath('networkInstances', key, 'type'),
  fieldPath('networkInstances', key, 'staticRoutes', '0.0.0.0/0', 'nextHops', '0', 'address')
]

describe.each(KEYS)('the key %s', (key) => {
  it('is an own key of the model, not its prototype', () => {
    const device = deviceWith(key)
    expect(Object.hasOwn(device.interfaces!, key)).toBe(true)
    expect(Object.getPrototypeOf(device.interfaces)).toBe(Object.prototype)
  })

  it('round-trips through JSON, as an own property, twice over', () => {
    const device = deviceWith(key)
    const once = deserializeModel(serializeModel(device)).device
    const twice = deserializeModel(serializeModel(once)).device
    for (const d of [once, twice]) {
      expect(d).toEqual(device)
      for (const map of [d.interfaces!, d.networkInstances!, d.system!.snmp!.communities!, d.system!.dns!.servers!]) {
        expect(Object.hasOwn(map, key)).toBe(true)
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
      }
      expect(populatedLeaves(d).map((l) => l.path)).toEqual(expectedPaths(key))
    }
  })

  it('has field paths that read back to the same segments', () => {
    for (const path of expectedPaths(key)) expect(fieldPath(...pathSegments(path))).toBe(path)
    expect(pathSegments(fieldPath('interfaces', key, 'description'))).toEqual(['interfaces', key, 'description'])
  })

  it('is a leaf the model-side check accounts for: rendered when given, unrendered when not', () => {
    const device = deserializeModel(serializeModel(deviceWith(key))).device
    const all = Object.fromEntries(expectedPaths(key).map((p): [string, FieldDisposition] => [p, { kind: 'rendered' }]))
    const full = checkFields(device, all)
    expect(full.unrendered).toEqual([])
    expect(full.strayPaths).toEqual([])
    // An empty dispositions record has `toString` and `constructor` on its prototype: they must not count.
    expect(checkFields(device, {}).unrendered.map((f) => f.path)).toEqual(expectedPaths(key))
  })

  it('is a statement id the source-side check accounts for, and the ledger is complete only when it has one', () => {
    const tree: SyntaxNode[] = [{ id: key, label: `interfaces ${key}`, children: [{ id: `${key} description`, label: `interfaces ${key} description uplink` }] }]
    const dispositions: Record<string, StatementDisposition> = Object.fromEntries([
      [key, { kind: 'mapped', fields: [] }],
      [`${key} description`, { kind: 'mapped', fields: [fieldPath('interfaces', key, 'description')] }]
    ])
    expect(checkStatements(tree, {}).unmapped.map((s) => s.id)).toEqual([key, `${key} description`])
    const model: Device = { interfaces: { [key]: { description: 'uplink' } } }
    const parse: ParseResult = { tree, model, dispositions, diagnostics: [] }
    const ledger = buildLedger(parse, { text: '', dispositions: Object.fromEntries([[fieldPath('interfaces', key, 'description'), { kind: 'rendered' }]]), diagnostics: [] })
    expect(ledger.source.strayIds).toEqual([])
    expect(ledger.complete).toBe(true)
  })

  it('works in null-prototype maps too', () => {
    const interfaces: Record<string, unknown> = Object.create(null)
    interfaces[key] = Object.assign(Object.create(null), { description: 'uplink' })
    const device = { interfaces } as Device
    expect(populatedLeaves(device).map((l) => l.path)).toEqual([fieldPath('interfaces', key, 'description')])
    expect(deserializeModel(serializeModel(device)).device).toEqual({ interfaces: { [key]: { description: 'uplink' } } })
  })
})

describe('a model document', () => {
  it('reads its fields as own properties only', () => {
    expect(() => deserializeModel(Object.create({ modelVersion: MODEL_VERSION, device: {} }))).toThrow('The model document has no valid modelVersion (undefined).')
  })
})

describe('model 0.2.0', () => {
  it('is the core\'s model version, and plugins built for 0.1 still load', () => {
    expect(MODEL_VERSION).toBe('0.2.0')
    expect(() => createRegistry([{ id: 'old', name: 'Old', modelApi: '>=0.1.0 <1.0.0', capabilities: { system: { parse: 'full', render: 'full' } } }])).not.toThrow()
  })

  it('reads 0.1.0 documents', () => {
    expect(deserializeModel('{"modelVersion":"0.1.0","device":{"system":{"hostname":"r1"}}}').device).toEqual({ system: { hostname: 'r1' } })
  })

  it('has DNS servers, by address in source order, and search domains as a leaf-list', () => {
    const device: Device = { system: { dns: { servers: { '192.0.2.53': {}, '198.51.100.53': { networkInstance: 'mgmt' } }, search: ['example.net', 'example.org'] } } }
    expect(populatedLeaves(device)).toEqual([
      { path: 'system.dns.servers["192.0.2.53"]', value: {} },
      { path: 'system.dns.servers["198.51.100.53"].networkInstance', value: 'mgmt' },
      { path: 'system.dns.search', value: ['example.net', 'example.org'] }
    ])
    expect(Object.keys(deserializeModel(serializeModel(device)).device.system!.dns!.servers!)).toEqual(['192.0.2.53', '198.51.100.53'])
  })
})
