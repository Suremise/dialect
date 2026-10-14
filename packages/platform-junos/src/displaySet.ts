// `show configuration | display set` from the tree, ported from the spike prototype's flattener.
//
// Ordering follows Juniper's documented display set example: a statement's `deactivate` and `protect` lines come after
// the `set` lines of its whole subtree (for a leaf, right after its own `set`), because Junos can't deactivate a
// hierarchy that doesn't exist yet. jcc's fixtures (for containers), Batfish and junoscfg put them first instead.
// `replace:` has no display set form and is dropped, as Junos does.
import { JunosParseError } from './tokenizer'
import { parseConfig, type ConfigNode, type ParseWarning } from './tree'

export interface SetLine {
  text: string
  /** The 1-based source line of the statement the set line comes from. */
  sourceLine: number
}

/** Flattens a parsed tree into display set lines. */
export function flatten(nodes: ConfigNode[]): SetLine[] {
  const out: SetLine[] = []
  const walk = (level: ConfigNode[], path: string): void => {
    for (const node of level) {
      const full = path ? `${path} ${node.words.join(' ')}` : node.words.join(' ')
      const emit = (text: string): void => {
        out.push({ text, sourceLine: node.line })
      }
      if (node.children === null) {
        if (node.values === null) emit(`set ${full}`)
        else for (const value of node.values) emit(`set ${full} ${value}`)
      } else {
        if (node.children.length === 0) emit(`set ${full}`)
        walk(node.children, full)
      }
      if (node.inactive) emit(`deactivate ${full}`)
      if (node.protect) emit(`protect ${full}`)
    }
  }
  walk(nodes, '')
  return out
}

/** A warning for each annotation, which display set has no line for. */
export function annotationWarnings(nodes: ConfigNode[]): ParseWarning[] {
  const found: ParseWarning[] = []
  const walk = (level: ConfigNode[], path: string[]): void => {
    for (const node of level) {
      const full = [...path, ...node.words]
      if (node.annotation !== null) {
        found.push({ code: 'annotation', message: `annotation /* ${node.annotation} */ on '${full.join(' ')}' isn't shown in display set`, line: node.line, column: node.column })
      }
      if (node.children) walk(node.children, full)
    }
  }
  walk(nodes, [])
  return found
}

export interface DisplaySetError {
  message: string
  line: number
  column: number
}

export type DisplaySetResult =
  | { ok: true; lines: SetLine[]; warnings: ParseWarning[] }
  | { ok: false; error: DisplaySetError }

/** Curly-brace Junos config to display set: the set lines and the warnings, or the first syntax error. */
export function displaySet(src: string): DisplaySetResult {
  let parsed
  try {
    parsed = parseConfig(src)
  } catch (error) {
    if (error instanceof JunosParseError) return { ok: false, error: { message: error.reason, line: error.line, column: error.column } }
    throw error
  }
  const warnings = [...parsed.warnings, ...annotationWarnings(parsed.nodes)].sort((a, b) => a.line - b.line || a.column - b.column)
  return { ok: true, lines: flatten(parsed.nodes), warnings }
}
