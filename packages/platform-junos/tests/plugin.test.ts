// The Junos plugin in the core's registry: it registers against the core's model version, and its display set tool,
// found through registry.tools(), gives the same output and source lines as the flattener on jcc's pairs, with
// positioned diagnostics.
import { createRegistry, guardPlugin, MODEL_VERSION, PluginRejectedError, pluginProblem } from '@dialect/core'
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
    expect(registry.get('junos')).toBe(guardPlugin(junos))
    expect(junos).toMatchObject({ id: 'junos', name: 'Junos', modelApi: '>=0.5.4 <1.0.0' })
  })

  it("covers every 0.x model from 0.5.4 on (its parse fills 0.5.4's LAGs), and no 0.5.3 or 1.x", () => {
    for (const version of ['0.5.4', '0.5.7', '0.9.0']) expect(pluginProblem(junos, version)).toBeNull()
    expect(pluginProblem(junos, '0.5.3')).not.toBeNull()
    expect(() => createRegistry([junos], { modelVersion: '1.0.0' })).toThrow(PluginRejectedError)
    expect(() => createRegistry([junos], { modelVersion: '1.0.0' })).toThrow('Plugin "junos" supports model versions >=0.5.4 <1.0.0, but this core\'s model is 1.0.0.')
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
    expect(displaySetFromRegistry(conf)).toEqual({ text: direct.lines.map((l) => `${l.text}\n`).join(''), diagnostics: [], sourceLines: direct.lines.map((l) => l.sourceLine) })
  })

  it('reports a syntax error as an error diagnostic with its position, and no text', () => {
    expect(displaySetFromRegistry('system {\n    host-name r1\n}\n')).toEqual({
      text: '',
      diagnostics: [
        { severity: 'error', category: 'syntax', code: 'junos.syntax', message: "missing ';' after the statement at line 2, column 5", span: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 } }
      ],
      sourceLines: []
    })
  })

  it('reports warnings as warning diagnostics with their positions, beside the text', () => {
    expect(displaySetFromRegistry('system {\n    /* lab */\n    host-name r1;\n    deleted: services;\n}\n')).toEqual({
      text: 'set system host-name r1\nset system deleted: services\n',
      diagnostics: [
        { severity: 'warning', category: 'syntax', code: 'junos.annotation', message: "annotation on this statement isn't shown in display set", span: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 5 } },
        { severity: 'warning', category: 'syntax', code: 'junos.unknown-tag', message: "unknown tag 'deleted:' kept as a word", span: { startLine: 4, startColumn: 5, endLine: 4, endColumn: 5 } }
      ],
      sourceLines: [3, 4]
    })
  })

  it("gives each output line its statement's source line, a value's line breaks included", () => {
    const input = 'system {\n    login {\n        message "one\r\ntwo\nthree";\n    }\n    inactive: ntp {\n        server 192.0.2.1;\n    }\n}\n'
    const result = displaySetFromRegistry(input)
    expect(result.text).toBe('set system login message "one\r\ntwo\nthree"\nset system ntp server 192.0.2.1\ndeactivate system ntp\n')
    // As an editor counts lines, without the empty one after the final line break.
    expect(result.sourceLines).toHaveLength(result.text.split(/\r\n?|\n/).length - 1)
    // The value runs over source lines 3 to 5, and all three output lines link to its statement.
    expect(result.sourceLines).toEqual([3, 3, 3, 8, 7])
  })

  it('gives empty input no text and no diagnostics', () => {
    expect(displaySetFromRegistry('')).toEqual({ text: '', diagnostics: [], sourceLines: [] })
  })
})

describe('what an interface name says (convert mode suggestions)', () => {
  it('describes Ethernet ports by speed and numbers, channels included', () => {
    expect(junos.describeInterface?.('ge-1/0/3')).toEqual({ type: 'ethernet', speed: 1000, numbers: [1, 0, 3] })
    expect(junos.describeInterface?.('xe-0/0/0:2')).toEqual({ type: 'ethernet', speed: 10000, numbers: [0, 0, 0, 2] })
    expect(junos.describeInterface?.('et-0/0/48')).toEqual({ type: 'ethernet', speed: 100000, numbers: [0, 0, 48] })
    expect(junos.describeInterface?.('mge-0/0/1')).toEqual({ type: 'ethernet', numbers: [0, 0, 1] })
  })

  it('describes aggregates (counted from 1, as Cisco does), loopbacks and management ports by number, and not the rest', () => {
    expect(junos.describeInterface?.('ae0')).toEqual({ type: 'aggregate', numbers: [1] })
    expect(junos.describeInterface?.('ae1')).toEqual({ type: 'aggregate', numbers: [2] })
    expect(junos.describeInterface?.('lo0')).toEqual({ type: 'loopback', numbers: [0] })
    expect(junos.describeInterface?.('fxp0')).toEqual({ type: 'management', numbers: [0] })
    expect(junos.describeInterface?.('em1')).toEqual({ type: 'management', numbers: [1] })
    for (const name of ['irb', 'vlan', 'gr-0/0/0', 'st0', 'ge-0/0', 'ge-0/0/0.0', '__proto__']) expect(junos.describeInterface?.(name)).toBeUndefined()
  })
})
