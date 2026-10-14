// The Junos plugin in the core's registry: it registers against the core's model version, and its display set tool,
// found through registry.tools(), gives the same output as the flattener on jcc's pairs, with positioned diagnostics.
import { createRegistry, MODEL_VERSION, PluginRejectedError, pluginProblem } from '@dialect/core'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import junos, { displaySet, displaySetTool } from '../src/index'

const CLEANED = join(__dirname, 'fixtures/display-set')
const NUMBERS = Array.from({ length: 22 }, (_, i) => i + 1)

function displaySetFromRegistry(input: string) {
  const found = createRegistry([junos])
    .tools()
    .filter((t) => t.plugin.id === 'junos' && t.tool.id === 'display-set')
  expect(found).toHaveLength(1)
  return found[0].tool.run(input)
}

describe('the Junos plugin', () => {
  it("registers: the registry accepts its modelApi for the core's model version", () => {
    expect(pluginProblem(junos)).toBeNull()
    const registry = createRegistry([junos])
    expect(registry.modelVersion).toBe(MODEL_VERSION)
    expect(registry.get('junos')).toBe(junos)
    expect(junos).toMatchObject({ id: 'junos', name: 'Junos', modelApi: '>=0.1.0 <1.0.0' })
  })

  it('covers every 0.x model from 0.1 on, and no 1.x', () => {
    for (const version of ['0.1.0', '0.1.7', '0.9.0']) expect(pluginProblem(junos, version)).toBeNull()
    expect(() => createRegistry([junos], { modelVersion: '1.0.0' })).toThrow(PluginRejectedError)
    expect(() => createRegistry([junos], { modelVersion: '1.0.0' })).toThrow('Plugin "junos" supports model versions >=0.1.0 <1.0.0, but this core\'s model is 1.0.0.')
  })

  it('lists display set in tools(), with its id, name and what it reads and writes', () => {
    expect(createRegistry([junos]).tools().map((t) => ({ plugin: t.plugin.id, id: t.tool.id, name: t.tool.name }))).toEqual([{ plugin: 'junos', id: 'display-set', name: 'Display set' }])
    expect(displaySetTool).toMatchObject({ input: 'junos-hierarchical', output: 'junos-set' })
    expect(displaySetTool.description).toContain('display set')
  })

  it.each(NUMBERS)("gives config_%i the flattener's output, through the registry", (n) => {
    const conf = readFileSync(join(CLEANED, `config_${n}.conf`), 'utf8')
    const direct = displaySet(conf)
    if (!direct.ok) throw new Error(`config_${n}: ${direct.error.message}`)
    expect(displaySetFromRegistry(conf)).toEqual({ text: direct.lines.map((l) => `${l.text}\n`).join(''), diagnostics: [] })
  })

  it('reports a syntax error as an error diagnostic with its position, and no text', () => {
    expect(displaySetFromRegistry('system {\n    host-name r1\n}\n')).toEqual({
      text: '',
      diagnostics: [
        { severity: 'error', category: 'syntax', code: 'junos.syntax', message: "missing ';' after the statement at line 2, column 5", span: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 } }
      ]
    })
  })

  it('reports warnings as warning diagnostics with their positions, beside the text', () => {
    expect(displaySetFromRegistry('system {\n    /* lab */\n    host-name r1;\n    deleted: services;\n}\n')).toEqual({
      text: 'set system host-name r1\nset system deleted: services\n',
      diagnostics: [
        { severity: 'warning', category: 'syntax', code: 'junos.annotation', message: "annotation on this statement isn't shown in display set", span: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 5 } },
        { severity: 'warning', category: 'syntax', code: 'junos.unknown-tag', message: "unknown tag 'deleted:' kept as a word", span: { startLine: 4, startColumn: 5, endLine: 4, endColumn: 5 } }
      ]
    })
  })

  it('gives empty input no text and no diagnostics', () => {
    expect(displaySetFromRegistry('')).toEqual({ text: '', diagnostics: [] })
  })
})
