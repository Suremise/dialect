// The Junos plugin for the core's registry (B2's PlatformPlugin). For now it has one tool, display set; parsing into
// the shared model and rendering from it come in B4.
import type { Diagnostic, PlatformPlugin, Tool, ToolResult } from '@dialect/core'
import { displaySet } from './displaySet'

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
      return { text: '', diagnostics: [{ severity: 'error', category: 'syntax', code: 'junos.syntax', message, span: at(line, column) }] }
    }
    return {
      text: result.lines.length > 0 ? result.lines.map((line) => line.text).join('\n') + '\n' : '',
      diagnostics: result.warnings.map((w) => ({ severity: 'warning', category: 'syntax', code: `junos.${w.code}`, message: w.message, span: at(w.line, w.column) }))
    }
  }
}

export const junos: PlatformPlugin = {
  id: 'junos',
  name: 'Junos',
  // Minor model versions only add, also in 0.x, so every 0.x model from 0.1 on (docs/ARCHITECTURE.md, the shared model).
  modelApi: '>=0.1.0 <1.0.0',
  // No model mapping yet (B4), so no area is parsed or rendered.
  capabilities: {},
  tools: () => [displaySetTool]
}
