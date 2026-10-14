// The kit with keys that name Object.prototype's members: `__proto__`, `constructor` and `toString` as interface names
// and NTP servers go through all four checks like any other key, and model comparison reads own properties only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deserializeModel, serializeModel, type Device } from '@dialect/core'
import { checkFixture, modelDifferences } from '../src'
import { stubPlugin } from './stubPlatform'

const KEYS = ['__proto__', 'constructor', 'toString'] as const

let before: Map<string | symbol, PropertyDescriptor | undefined>
const prototypeNow = () => new Map(Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)]))
beforeAll(() => {
  before = prototypeNow()
})
afterAll(() => {
  expect(prototypeNow()).toEqual(before)
})

describe.each(KEYS)('the key %s', (key) => {
  const source = `system { ntp { server ${key}; } } interfaces { ${key} { description "uplink"; unit 0 { family inet { address 192.0.2.1/24; } } } }`
  // Computed keys are own properties, like JSON.parse's.
  const expectedModel: Device = {
    system: { ntp: { servers: { [key]: {} } } },
    interfaces: { [key]: { description: 'uplink', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } }
  }

  it('passes all four checks, with the expected model read from JSON', () => {
    const fromJson = deserializeModel(serializeModel(expectedModel)).device
    const results = checkFixture(stubPlugin(), { name: `keys/${key}`, source, expectedModel: fromJson })
    expect(results.filter((r) => r.status === 'failed')).toEqual([])
    expect(({} as Record<string, unknown>).description).toBeUndefined()
  })

  it('is told apart from a missing key, which is undefined and not what Object.prototype has', () => {
    const without: Device = { interfaces: {} }
    expect(modelDifferences(without, expectedModel)).toEqual([
      `interfaces.${key}: expected undefined, got ${JSON.stringify(expectedModel.interfaces![key])}`,
      `system: expected undefined, got {"ntp":{"servers":{${JSON.stringify(key)}:{}}}}`
    ])
    expect(modelDifferences(expectedModel, without)[1]).toBe(`interfaces.${key}: expected ${JSON.stringify(expectedModel.interfaces![key])}, got undefined`)
  })
})

describe('model comparison', () => {
  it('ignores prototypes: a null-prototype model equals the same model read from JSON', () => {
    const interfaces = Object.assign(Object.create(null) as Record<string, unknown>, { ge0: Object.assign(Object.create(null), { description: 'uplink' }) })
    expect(modelDifferences({ interfaces: { ge0: { description: 'uplink' } } }, { interfaces } as Device)).toEqual([])
  })

  it('still finds a difference in a leaf-list, an extra key and a changed leaf', () => {
    expect(modelDifferences({ a: ['x', 'y'], b: 1 }, { a: ['x'], b: 2, c: true })).toEqual(['a: expected ["x","y"], got ["x"]', 'b: expected 1, got 2', 'c: expected undefined, got true'])
  })
})
