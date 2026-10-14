// The Junos plugin for the core's registry (B2's PlatformPlugin): parse into the shared model and render from it for the
// phase 1 areas (B4), detect(), and one tool, display set.
import type { Diagnostic, PlatformPlugin, Tool, ToolResult } from '@dialect/core'
import { detect } from './detect'
import { displaySet } from './displaySet'
import { describeInterface } from './names'
import { parse } from './parse'
import { render } from './render'

/**
 * Display set as a core Tool. The core's Tool has no field for what it reads and writes, so this one says it twice: in
 * its description for people, and as `input` and `output` for code.
 */
export interface JunosTool extends Tool {
  /** What `run()` reads: curly-brace (hierarchical) Junos config. */
  readonly input: 'junos-hierarchical'
  /** What its `text` is: Junos `set` commands, one per line. */
  readonly output: 'junos-set'
}

/** A point in the source, as the core's span (end column exclusive, so start and end meet). */
function at(line: number, column: number): Diagnostic['span'] {
  return { startLine: line, startColumn: column, endLine: line, endColumn: column }
}

/** A line break as editors count them (CodeMirror among them). */
const LINE_BREAK = /\r\n?|\n/

export const displaySetTool: JunosTool = {
  id: 'display-set',
  name: 'Display set',
  description: 'Hierarchical Junos config to the `set` commands `show configuration | display set` prints.',
  input: 'junos-hierarchical',
  output: 'junos-set',
  run(input: string): ToolResult {
    const result = displaySet(input)
    if (!result.ok) {
      const { message, line, column } = result.error
      return { text: '', diagnostics: [{ severity: 'error', category: 'syntax', code: 'junos.syntax', message, span: at(line, column) }], sourceLines: [] }
    }
    return {
      text: result.lines.length > 0 ? result.lines.map((line) => line.text).join('\n') + '\n' : '',
      diagnostics: result.warnings.map((w) => ({ severity: 'warning', category: 'syntax', code: `junos.${w.code}`, message: w.message, span: at(w.line, w.column) })),
      // A quoted value can hold line breaks (a banner), so one set line can be several output lines: each gets its
      // statement's line.
      sourceLines: result.lines.flatMap((line) => Array<number>(line.text.split(LINE_BREAK).length).fill(line.sourceLine))
    }
  }
}

export const junos: PlatformPlugin = {
  id: 'junos',
  name: 'Junos',
  // 0.4.0: its parse fills VLANs, switch ports and IRB units' routed VLANs, which a 0.3 core doesn't know. Minor
  // versions only add, so every 0.x from there.
  modelApi: '>=0.4.0 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'partial', render: 'full' },
    interfaces: { parse: 'partial', render: 'partial' },
    'static-routes': { parse: 'partial', render: 'partial' },
    ntp: { parse: 'partial', render: 'partial' },
    syslog: { parse: 'partial', render: 'partial' },
    snmp: { parse: 'partial', render: 'partial' },
    vlans: { parse: 'partial', render: 'partial' }
  },
  detect,
  parse,
  render,
  describeInterface,
  tools: () => [displaySetTool]
}
