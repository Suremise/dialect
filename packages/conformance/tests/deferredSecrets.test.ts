// The round trip's one exception (#68): a key the model flags but never carries (`authentication: true`) can't come
// back from a render that has no key to write, so a render that asks the user for it with a `secret` needs-input item
// passes, and the check names each leaf it left out. A render that drops the key without asking, or asks for another
// leaf the same way with an item that isn't a secret, still fails: only a deliberately deferred secret is excused.
import { describe, expect, it } from 'vitest'
import { fieldPath, MODEL_VERSION, type FieldDisposition, type NeedsInput, type PlatformPlugin, type StatementDisposition } from '@dialect/core'
import { checkFixture, deferredSecrets } from '../src'

const group = ['networkInstances', 'default', 'bgp', 'groups', 'G'] as const
const key = fieldPath(...group, 'authentication')
const description = fieldPath(...group, 'description')
/** Group E, configured with nothing in it: a leaf of its own. */
const empty = fieldPath('networkInstances', 'default', 'bgp', 'groups', 'E')

/**
 * A line language: `description D` and `key K` on BGP group G. The render writes the description, and the key the
 * way `defer` says: asked for as a secret, dropped without a word, or (with the description) asked for as `other`.
 */
function stub(defer: 'secret' | 'drop' | 'description-as-other'): PlatformPlugin {
  return {
    id: 'stub',
    name: 'Stub',
    modelApi: '>=0.4.0 <1.0.0',
    capabilities: { bgp: { parse: 'partial', render: 'partial' } },
    parse(text) {
      const lines = text.split('\n').filter((l) => l !== '')
      const g: { description?: string; authentication?: true } = {}
      let other = false
      const dispositions: Record<string, StatementDisposition> = {}
      lines.forEach((line, i) => {
        const [word, value] = line.split(' ')
        if (word === 'description') g.description = value
        if (word === 'key') g.authentication = true
        if (word === 'empty') other = true
        dispositions[`L${i + 1}`] = { kind: 'mapped', fields: [word === 'key' ? key : word === 'empty' ? empty : description] }
      })
      const groups = { ...(Object.keys(g).length ? { G: g } : {}), ...(other ? { E: {} } : {}) }
      return {
        tree: lines.map((label, i) => ({ id: `L${i + 1}`, label })),
        model: Object.keys(groups).length ? { networkInstances: { default: { bgp: { groups } } } } : {},
        dispositions,
        diagnostics: []
      }
    },
    render(model) {
      const g = model.networkInstances?.default?.bgp?.groups?.G ?? {}
      const lines: string[] = []
      if (model.networkInstances?.default?.bgp?.groups?.E) lines.push('empty')
      const dispositions: Record<string, FieldDisposition> = {}
      if (lines.length) dispositions[empty] = { kind: 'rendered', span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }
      const needsInput: NeedsInput[] = []
      const rendered = () => ({ kind: 'rendered' as const, span: { startLine: lines.length, startColumn: 1, endLine: lines.length, endColumn: 2 } })
      if (g.description !== undefined) {
        if (defer === 'description-as-other') {
          needsInput.push({ id: 'stub.description', kind: 'other', message: 'Give the description.', field: description })
          dispositions[description] = { kind: 'unsupported', reason: 'asked for' }
        } else {
          lines.push(`description ${g.description}`)
          dispositions[description] = rendered()
        }
      }
      if (g.authentication) {
        if (defer === 'secret' || defer === 'description-as-other') needsInput.push({ id: 'stub.key', kind: 'secret', message: 'Give the key.', field: key })
        dispositions[key] = { kind: 'unsupported', reason: defer === 'drop' ? 'not written' : 'the key is asked for' }
      }
      return { text: lines.map((l) => `${l}\n`).join(''), dispositions, diagnostics: [], ...(needsInput.length ? { needsInput } : {}) }
    }
  }
}

const fixture = (source: string) => {
  const parsed = stub('secret').parse!(source, { modelVersion: MODEL_VERSION })
  return { name: 'bgp/key', source, expectedModel: parsed.model, secrets: [] }
}
const roundTrip = (plugin: PlatformPlugin, source: string) => checkFixture(plugin, fixture(source)).find((r) => r.check === 'round-trip')!

describe('the round trip and keys the model flags but never carries', () => {
  it('passes a render that asks for the key with a secret needs-input item, and names the leaf it left out', () => {
    const r = roundTrip(stub('secret'), 'description peers\nkey PLACEHOLDER\n')
    expect(r.status).toBe('passed')
    expect(r.deferred).toEqual([key])
  })

  it('passes a key that is the only leaf of its group, so the reparse has nothing there', () => {
    const r = roundTrip(stub('secret'), 'key PLACEHOLDER\n')
    expect(r.problems).toEqual([])
    expect(r.status).toBe('passed')
    expect(r.deferred).toEqual([key])
  })

  it('keeps what the model has empty beside a key-only group: only what taking the key out emptied goes', () => {
    const r = roundTrip(stub('secret'), 'key PLACEHOLDER\nempty\n')
    expect(r.problems).toEqual([])
    expect(r.deferred).toEqual([key])
    // A render that loses the empty group fails, key deferred or not.
    const lost: PlatformPlugin = { ...stub('secret'), render: (model, context) => stub('secret').render!({ networkInstances: { default: { bgp: { groups: { G: model.networkInstances!.default.bgp!.groups!.G } } } } }, context) }
    expect(roundTrip(lost, 'key PLACEHOLDER\nempty\n').status).toBe('failed')
  })

  it('fails a key-only group dropped without asking for it', () => {
    const r = roundTrip(stub('drop'), 'key PLACEHOLDER\n')
    expect(r.status).toBe('failed')
    expect(r.deferred).toBeUndefined()
  })

  it('fails a render that drops the key without asking for it', () => {
    const r = roundTrip(stub('drop'), 'description peers\nkey PLACEHOLDER\n')
    expect(r.status).toBe('failed')
    expect(r.problems).toEqual([`render → reparse changed the model: networkInstances.default.bgp.groups.G.authentication: expected true, got undefined`])
    expect(r.deferred).toBeUndefined()
  })

  it('fails a render that leaves another leaf to a needs-input item that is not a secret', () => {
    const r = roundTrip(stub('description-as-other'), 'description peers\nkey PLACEHOLDER\n')
    expect(r.status).toBe('failed')
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/^render → reparse changed the model: .*"description":"peers"/)
    // The key it asked for as a secret is still excused, and said so.
    expect(r.deferred).toEqual([key])
  })

  it('excuses nothing when nothing was left to the user', () => {
    const r = roundTrip(stub('secret'), 'description peers\n')
    expect(r.status).toBe('passed')
    expect(r.deferred).toBeUndefined()
  })

  it('takes only a populated leaf the render left unwritten, named by a secret item with an id', () => {
    const model = { networkInstances: { default: { bgp: { groups: { G: { authentication: true, description: 'peers' } } } } } }
    const base = { text: '', diagnostics: [] }
    expect(deferredSecrets(model, { ...base, dispositions: {}, needsInput: [{ id: 'k', kind: 'secret', message: 'm', field: key }] })).toEqual([key])
    // Written after all, from the user's answer: nothing deferred.
    expect(deferredSecrets(model, { ...base, dispositions: { [key]: { kind: 'rendered', span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } } }, needsInput: [{ id: 'k', kind: 'secret', message: 'm', field: key }] })).toEqual([])
    // An object, a path the model doesn't have, an item with no id or no field: none.
    expect(deferredSecrets(model, { ...base, dispositions: {}, needsInput: [{ id: 'k', kind: 'secret', message: 'm', field: fieldPath(...group) }, { id: 'k', kind: 'secret', message: 'm', field: fieldPath(...group, 'peerAs') }, { id: '', kind: 'secret', message: 'm', field: key }, { id: 'k', kind: 'secret', message: 'm' }] })).toEqual([])
  })
})
