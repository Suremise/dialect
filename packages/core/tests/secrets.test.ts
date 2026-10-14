// The secret safety net (src/secrets.ts, #115): a plugin that leaks a secret in every kind of message it can, guarded,
// leaks none; the withheld texts and their last resort; the registry and convert() guard every plugin they're given.
import { describe, expect, it } from 'vitest'
import { convert, createRegistry, findSecrets, guardPlugin, MODEL_VERSION, secretCandidates, WITHHELD_MESSAGE, WITHHELD_REASON, type Device, type PlatformPlugin } from '../src'

// Documentation values only (AGENTS.md: no real secrets in the repo).
const SOURCE = 'snmp-server community PLACEHOLDER-RO RO\ninterface Gig0\n'
const context = { modelVersion: MODEL_VERSION }

/** A plugin that quotes `say` in every message it gives: reasons, diagnostics, needs-input items, tools and errors. */
function leaky(say: string, { fail }: { fail?: 'parse' | 'render' | 'tool' } = {}): PlatformPlugin {
  const model: Device = { interfaces: { Gig0: { type: 'ethernet' } } }
  return {
    id: 'leaky',
    name: 'Leaky',
    modelApi: '>=0.1.0 <1.0.0',
    capabilities: {},
    detect: () => 0.5,
    parse() {
      if (fail === 'parse') throw new Error(`can't read ${say}`)
      return {
        tree: [{ id: 'L1', label: 'snmp-server community' }, { id: 'L2', label: 'interface Gig0' }],
        model,
        dispositions: { L1: { kind: 'unsupported', reason: `community ${say} comes later` }, L2: { kind: 'mapped', fields: ['interfaces.Gig0.type'] } },
        diagnostics: [{ severity: 'warning', code: 'leaky.parse', message: `about ${say}`, statement: 'L1' }],
        needsInput: [{ id: 'p', kind: 'other', message: `say ${say}`, suggestions: [say, 'safe'] }]
      }
    },
    render() {
      if (fail === 'render') throw new Error(`can't write ${say}`)
      return {
        text: 'interface Gig0\n snmp community PLACEHOLDER-OUT\n',
        dispositions: { 'interfaces.Gig0.type': { kind: 'unsupported', reason: `not with ${say}` } },
        diagnostics: [{ severity: 'warning', message: `rendered ${say}` }],
        needsInput: [{ id: 'r', kind: 'secret', message: `key for ${say}`, suggestions: [say] }]
      }
    },
    describeInterface: () => ({ type: 'ethernet', numbers: [0] }),
    nameInterface: () => 'Eth0',
    tools: () => [
      {
        id: 'echo',
        name: 'Echo',
        run: (input) => {
          if (fail === 'tool') throw new Error(`stuck at ${say}`)
          return { text: input, diagnostics: [{ severity: 'error', code: 'leaky.syntax', message: `near ${say}` }] }
        }
      }
    ]
  }
}

/** Every message, reason and suggestion of a parse, a render of its model and the tool's run on `text`. */
function messages(plugin: PlatformPlugin, text: string): string[] {
  const parsed = plugin.parse!(text, context)
  const rendered = plugin.render!(parsed.model, context)
  const ran = plugin.tools!()[0].run(text)
  return [
    ...Object.values(parsed.dispositions).flatMap((d) => ('reason' in d && d.reason ? [d.reason] : [])),
    ...parsed.diagnostics.map((d) => d.message),
    ...(parsed.needsInput ?? []).flatMap((n) => [n.message, ...(n.suggestions ?? [])]),
    ...Object.values(rendered.dispositions).flatMap((d) => ('reason' in d && d.reason ? [d.reason] : [])),
    ...rendered.diagnostics.map((d) => d.message),
    ...(rendered.needsInput ?? []).flatMap((n) => [n.message, ...(n.suggestions ?? [])]),
    ...ran.diagnostics.map((d) => d.message)
  ]
}

describe('the shared finder', () => {
  it('gives the secrets the conformance kit looks for, and the net looks for them trimmed and in any case', () => {
    expect(findSecrets(SOURCE)).toEqual(['PLACEHOLDER-RO'])
    expect(secretCandidates(SOURCE)).toEqual(['placeholder-ro'])
    // A quoted key: as found (unquoted) and trimmed, each long enough; `the` alone is shorter than the cutoff.
    expect(secretCandidates('set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication md5 1 key " the "')).toEqual([' the '])
    expect(secretCandidates('set system tacplus-server 192.0.2.1 secret " spaced-out "')).toEqual([' spaced-out ', 'spaced-out'])
    expect(secretCandidates('snmp-server community RO RO\n')).toEqual([])
    // A quoted key whose quote is left open, to the end of its line (a text cut short).
    expect(findSecrets('set protocols ospf area 0 interface ge-0/0/0 authentication md5 1 key "PLACEHOLDER-OPEN')).toEqual(['PLACEHOLDER-OPEN'])
    expect(findSecrets('key "PLACEHOLDER-OPEN\nset system host-name r1\n')).toEqual(['PLACEHOLDER-OPEN'])
    // A Junos community where a text cut short ends, as well as before its block; not a policy's.
    expect(findSecrets('snmp {\n    community PLACEHOLDER-CUT')).toEqual(['PLACEHOLDER-CUT'])
    expect(findSecrets('policy-options {\n    community PLACEHOLDER-POLICY members 65000:1;\n}\n')).toEqual([])
  })
})

describe('guardPlugin', () => {
  it('withholds every reason and message that holds a secret of the source, in any case, and drops such suggestions', () => {
    const raw = leaky('placeholder-ro')
    expect(messages(raw, SOURCE).filter((m) => m.includes('placeholder-ro'))).toHaveLength(9)
    const plugin = guardPlugin(raw)
    const said = messages(plugin, SOURCE)
    expect(said.filter((m) => m.toLowerCase().includes('placeholder-ro'))).toEqual([])
    const parsed = plugin.parse!(SOURCE, context)
    expect(parsed.dispositions.L1).toEqual({ kind: 'unsupported', reason: WITHHELD_REASON })
    expect(parsed.dispositions.L2).toEqual({ kind: 'mapped', fields: ['interfaces.Gig0.type'] })
    expect(parsed.diagnostics).toEqual([{ severity: 'warning', code: 'leaky.parse', message: WITHHELD_MESSAGE, statement: 'L1' }])
    expect(parsed.needsInput).toEqual([{ id: 'p', kind: 'other', message: WITHHELD_MESSAGE, suggestions: ['safe'] }])
    const rendered = plugin.render!(parsed.model, context)
    expect(rendered.dispositions['interfaces.Gig0.type']).toEqual({ kind: 'unsupported', reason: WITHHELD_REASON })
    expect(rendered.needsInput).toEqual([{ id: 'r', kind: 'secret', message: WITHHELD_MESSAGE }])
    // The config keeps its values.
    expect(rendered.text).toContain('PLACEHOLDER-OUT')
    expect(plugin.tools!()[0].run(SOURCE).text).toBe(SOURCE)
  })

  it('leaves what holds no secret as the plugin gave it', () => {
    const raw = leaky('nothing secret')
    const plugin = guardPlugin(raw)
    expect(plugin.parse!(SOURCE, context)).toEqual(raw.parse!(SOURCE, context))
    expect(plugin.render!({}, context)).toEqual(raw.render!({}, context))
    expect(plugin.tools!()[0].run(SOURCE)).toEqual(raw.tools!()[0].run(SOURCE))
    expect(plugin).toMatchObject({ id: 'leaky', name: 'Leaky', modelApi: '>=0.1.0 <1.0.0', capabilities: {} })
    expect(plugin.detect!('x')).toBe(0.5)
    expect(plugin.nameInterface!({ type: 'ethernet', numbers: [0] })).toBe('Eth0')
    expect(plugin.describeInterface!('Gig0')).toEqual({ type: 'ethernet', numbers: [0] })
  })

  it("guards a render by its model's source, and by the secrets of its own text", () => {
    const plugin = guardPlugin(leaky('placeholder-ro'))
    const parsed = plugin.parse!(SOURCE, context)
    expect(plugin.render!(parsed.model, context).diagnostics[0].message).toBe(WITHHELD_MESSAGE)
    // A model from elsewhere: only the render's own text says what is secret.
    expect(plugin.render!({}, context).diagnostics[0].message).toBe('rendered placeholder-ro')
    expect(guardPlugin(leaky('PLACEHOLDER-OUT')).render!({}, context).diagnostics[0].message).toBe(WITHHELD_MESSAGE)
  })

  it('falls back to the last resort when the withheld text holds the secret too', () => {
    const source = 'snmp-server community value RO\n'
    const plugin = guardPlugin(leaky('value'))
    const parsed = plugin.parse!(source, context)
    expect(parsed.dispositions.L1).toEqual({ kind: 'unsupported', reason: '—' })
    expect(parsed.diagnostics[0].message).toBe('—')
    expect(messages(plugin, source).filter((m) => m.includes('value'))).toEqual([])
  })

  it('withholds a thrown error that holds a secret, and passes on one that holds none', () => {
    for (const fail of ['parse', 'render', 'tool'] as const) {
      const plugin = guardPlugin(leaky('PLACEHOLDER-RO', { fail }))
      const run = () => (fail === 'parse' ? plugin.parse!(SOURCE, context) : fail === 'render' ? plugin.render!(plugin.parse!(SOURCE.replace('PLACEHOLDER-RO', 'CHANGED-RO'), context).model, context) : plugin.tools!()[0].run(SOURCE))
      if (fail === 'render') expect(run, fail).toThrow("can't write PLACEHOLDER-RO")
      else expect(run, fail).toThrow(WITHHELD_MESSAGE)
    }
    const plugin = guardPlugin(leaky('PLACEHOLDER-RO', { fail: 'render' }))
    expect(() => plugin.render!(plugin.parse!(SOURCE, context).model, context)).toThrow(WITHHELD_MESSAGE)
    expect(() => guardPlugin(leaky('nothing', { fail: 'parse' })).parse!(SOURCE, context)).toThrow("can't read nothing")
  })

  it('wraps a plugin once: the same guard for it each time, and a guard guarded is itself', () => {
    const raw = leaky('x')
    const plugin = guardPlugin(raw)
    expect(guardPlugin(raw)).toBe(plugin)
    expect(guardPlugin(plugin)).toBe(plugin)
    expect(plugin).not.toBe(raw)
  })

  it("keeps a plugin's own parts without its own: no parse, render or tools", () => {
    const plugin = guardPlugin({ id: 'bare', name: 'Bare', modelApi: '>=0.1.0 <1.0.0', capabilities: {} })
    expect(Object.keys(plugin).sort()).toEqual(['capabilities', 'id', 'modelApi', 'name'])
  })
})

describe('where the net is applied', () => {
  it('the registry hands out every plugin guarded', () => {
    const raw = leaky('placeholder-ro')
    const registry = createRegistry([raw])
    expect(registry.get('leaky')).toBe(guardPlugin(raw))
    expect(registry.list()).toEqual([guardPlugin(raw)])
    expect(registry.sources()[0].parse!(SOURCE, context).diagnostics[0].message).toBe(WITHHELD_MESSAGE)
    expect(registry.tools()[0].tool.run(SOURCE).diagnostics[0].message).toBe(WITHHELD_MESSAGE)
  })

  it('convert() guards the plugins it is given, guarded or not, and its own items', () => {
    for (const plugin of [leaky('placeholder-ro'), guardPlugin(leaky('placeholder-ro'))]) {
      const conversion = convert(plugin, plugin, SOURCE, { modelVersion: MODEL_VERSION })
      const said = [
        ...conversion.ledger.diagnostics.map((d) => d.message),
        ...conversion.ledger.needsInput.flatMap((n) => [n.message, ...(n.suggestions ?? [])]),
        ...conversion.unanswered.flatMap((n) => [n.message, ...(n.suggestions ?? [])]),
        ...conversion.issues.flatMap((i) => (i.reason ? [i.reason] : [])),
        ...Object.values(conversion.render?.dispositions ?? {}).flatMap((d) => ('reason' in d && d.reason ? [d.reason] : []))
      ]
      expect(said.length).toBeGreaterThan(5)
      expect(said.filter((m) => m.toLowerCase().includes('placeholder-ro'))).toEqual([])
      expect(conversion.issues.find((i) => i.statement === 'L1')).toMatchObject({ kind: 'unsupported', reason: WITHHELD_REASON })
    }
    // An error a plugin throws, raw or guarded: a guarded target's render is of the renamed model, which it can't trace
    // to the source, so convert() guards it by the source's secrets.
    const source = 'snmp-server community statement RO\n'
    for (const fail of ['parse', 'render'] as const) {
      const raw: PlatformPlugin = {
        ...leaky('nothing'),
        parse: () => {
          if (fail === 'parse') throw new Error('statement')
          return { tree: [], model: { interfaces: { Gig0: { type: 'ethernet' } } }, dispositions: {}, diagnostics: [] }
        },
        render: () => {
          throw new Error('Statement')
        }
      }
      for (const plugin of [raw, guardPlugin(raw), createRegistry([raw]).get('leaky')!])
        expect(() => convert(plugin, plugin, source, { modelVersion: MODEL_VERSION }), fail).toThrow(WITHHELD_MESSAGE)
    }
    // The target's name is in convert's own interface items: withheld when it is a secret, and the suggestion kept.
    const named = { ...leaky('nothing'), name: 'PLACEHOLDER-RO platform' }
    const item = convert(named, named, SOURCE, { modelVersion: MODEL_VERSION }).ledger.needsInput.find((n) => n.kind === 'interface-name')
    expect(item).toMatchObject({ message: WITHHELD_MESSAGE, suggestions: ['Eth0'] })
  })
})
