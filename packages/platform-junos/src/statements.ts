// Junos text, hierarchical or set form, as the core's syntax tree plus a flat list of statements for the mapper.
//
// A statement is a full path of words, values included and quotes undone, as a `set` command says it:
// `system host-name r1` from `system { host-name r1; }` or `set system host-name r1`. The mapper reads statements, so
// both forms map the same way.
// - **Hierarchical:** the tree is tree.ts's, one syntax node per statement, containers included. A leaf gives one
//   statement per value (`domain-search [ a b ]` gives two), an empty container one (`set interfaces ge-0/0/0`), and a
//   container none of its own: its disposition comes from what is inside it (parse.ts).
// - **Set form:** one syntax node per command, with no children. `set` gives the statements; `deactivate` and `delete`
//   act on the statements under their path (every one for `deactivate`, the ones before it for `delete`), as loading
//   the commands on a device would; `protect` and `unprotect` change nothing in the configuration.
// Inactive statements (`inactive:`, `deactivate`) are left out with a disposition saying so: Junos doesn't apply them.
import type { Diagnostic, Span, StatementDisposition, SyntaxNode } from '@dialect/core'
import { JunosParseError, tokenize, type Token } from './tokenizer'
import { parseConfig, type ConfigNode } from './tree'
import { unquote } from './words'

export interface Statement {
  /** The syntax node it comes from. */
  readonly node: string
  readonly line: number
  /** The full path, values included, quotes undone. */
  readonly words: readonly string[]
}

export interface ReadConfig {
  readonly form: 'hierarchical' | 'set'
  readonly tree: SyntaxNode[]
  /** The active statements, in source order. */
  readonly statements: Statement[]
  /** Dispositions settled while reading: inactive, deleted and comment-like statements, and set-form commands. */
  readonly dispositions: Record<string, StatementDisposition>
  readonly diagnostics: Diagnostic[]
  /**
   * Set-form commands that reorder, rename or copy what is under their path (`insert`, `rename`, `copy`): not converted,
   * so what they change (a policy's term order) can't be converted either.
   */
  readonly reshaped?: readonly { readonly path: readonly string[]; readonly line: number }[]
}

const SET_COMMANDS = new Set(['set', 'deactivate', 'activate', 'delete', 'protect', 'unprotect', 'insert', 'rename', 'annotate', 'copy', 'edit', 'up', 'top'])

const point = (line: number, column: number): Span => ({ startLine: line, startColumn: column, endLine: line, endColumn: column })

const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })
const unsupported = (reason?: string): StatementDisposition => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })

/** Whether `prefix` is the start of `words`, word for word. */
export const startsWith = (words: readonly string[], prefix: readonly string[]): boolean => prefix.length <= words.length && prefix.every((w, i) => words[i] === w)

/**
 * Whether the text is in set form: commands (`set …`) at the start of its lines and no line ending in `{` or `;`, the
 * marks of the hierarchical form. A text with neither is read as hierarchical.
 */
export function isSetForm(text: string): boolean {
  let commands = 0
  let braces = 0
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const first = line.split(/\s/, 1)[0]
    if (SET_COMMANDS.has(first)) commands++
    else if (/[{};]$/.test(line) || line === '}') braces++
  }
  return commands > 0 && commands >= braces
}

export function readConfig(text: string): ReadConfig {
  return isSetForm(text) ? readSetForm(text) : readHierarchical(text)
}

// ---- hierarchical

function readHierarchical(text: string): ReadConfig {
  const tree: SyntaxNode[] = []
  const statements: Statement[] = []
  const dispositions: Record<string, StatementDisposition> = {}
  const diagnostics: Diagnostic[] = []
  let parsed
  try {
    parsed = parseConfig(text)
  } catch (error) {
    if (!(error instanceof JunosParseError)) throw error
    // The tokenizer's and parser's messages name punctuation and positions, never the config's words (tree.ts).
    diagnostics.push({ severity: 'error', category: 'syntax', code: 'junos.syntax', message: error.reason, span: point(error.line, error.column) })
    return { form: 'hierarchical', tree, statements, dispositions, diagnostics }
  }
  for (const w of parsed.warnings) {
    // Annotations are comments to the mapper: only display set has to say it drops them.
    if (w.code !== 'annotation') diagnostics.push({ severity: 'warning', category: 'syntax', code: `junos.${w.code}`, message: w.message, span: point(w.line, w.column) })
  }

  const walk = (nodes: ConfigNode[], path: string[], rawPath: string[], inactive: number | null): SyntaxNode[] =>
    nodes.map((node) => {
      const id = `L${node.line}:${node.column}`
      const words = [...path, ...node.words.map(unquote)]
      const raw = [...rawPath, ...node.words]
      const label = node.values ? `${raw.join(' ')} [ ${node.values.join(' ')} ]` : raw.join(' ')
      const off = inactive ?? (node.inactive ? node.line : null)
      const children = node.children ? walk(node.children, words, raw, off) : undefined
      if (off !== null) dispositions[id] = ignored(off === node.line && node.inactive ? "inactive: Junos doesn't apply it" : `inside an inactive statement (line ${off}): Junos doesn't apply it`)
      else if (node.children === null) {
        if (node.values === null) statements.push({ node: id, line: node.line, words })
        else if (node.values.length === 0) dispositions[id] = ignored('an empty list: nothing to convert')
        else for (const value of node.values) statements.push({ node: id, line: node.line, words: [...words, unquote(value)] })
      } else if (node.children.length === 0) statements.push({ node: id, line: node.line, words })
      return { id, label, span: point(node.line, node.column), ...(children ? { children } : {}) }
    })

  tree.push(...walk(parsed.nodes, [], [], null))
  return { form: 'hierarchical', tree, statements, dispositions, diagnostics }
}

// ---- set form

interface Segment {
  readonly start: number
  readonly end: number
  readonly line: number
}

/**
 * Splits set-form text into commands: a line each, except that a quoted string or an annotation can run over several
 * lines. Mirrors the tokenizer, so a `#` comment or an annotation can't hide a quote from it.
 */
function segments(text: string): Segment[] {
  const out: Segment[] = []
  const n = text.length
  let i = 0
  let line = 1
  let start = 0
  let startLine = 1
  let boundary = true
  const newlines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (text[k] === '\n') line++
  }
  while (i < n) {
    const c = text[i]
    if (c === '\n') {
      out.push({ start, end: i, line: startLine })
      line++
      i++
      start = i
      startLine = line
      boundary = true
    } else if (boundary && c === '#') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? n : end
    } else if (boundary && c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      newlines(i, end)
      i = end
    } else if (c === '"') {
      let k = i + 1
      while (k < n && text[k] !== '"') k += text[k] === '\\' && k + 1 < n ? 2 : 1
      const end = Math.min(k + 1, n)
      newlines(i, end)
      i = end
      boundary = false
    } else {
      boundary = c === ' ' || c === '\t' || c === '\r' || c === ';' || c === '{' || c === '}' || c === '[' || c === ']'
      i++
    }
  }
  out.push({ start, end: n, line: startLine })
  return out
}

interface Command {
  readonly node: SyntaxNode
  readonly line: number
  readonly verb: string
  /** The path after the verb, quotes undone; for `set`, one per value of a `[ … ]` list. */
  readonly paths: readonly (readonly string[])[]
}

function readSetForm(text: string): ReadConfig {
  const tree: SyntaxNode[] = []
  const dispositions: Record<string, StatementDisposition> = {}
  const diagnostics: Diagnostic[] = []
  const commands: Command[] = []

  for (const segment of segments(text)) {
    let tokens: Token[]
    try {
      tokens = tokenize(text.slice(segment.start, segment.end))
    } catch (error) {
      if (!(error instanceof JunosParseError)) throw error
      const line = error.line + segment.line - 1
      const node: SyntaxNode = { id: `L${line}`, label: text.slice(segment.start, segment.end).trim(), span: point(line, error.column) }
      tree.push(node)
      dispositions[node.id] = unsupported('not a complete command')
      diagnostics.push({ severity: 'error', category: 'syntax', code: 'junos.syntax', message: error.reason, span: point(line, error.column), statement: node.id })
      continue
    }
    const words = tokens.filter((t) => t.kind !== 'annotation')
    if (!words.length) continue
    const first = words[0]
    const line = first.line + segment.line - 1
    const node: SyntaxNode = { id: `L${line}`, label: text.slice(segment.start, segment.end).trim(), span: point(line, first.column) }
    tree.push(node)

    // `set a b [ x y ]` is a list: one path per value. Anything else that isn't a word doesn't belong in a command.
    const plain: string[] = []
    const values: string[] = []
    let list: 'none' | 'open' | 'closed' = 'none'
    let bad: Token | undefined
    for (const t of words.slice(1)) {
      if (t.kind === 'word' && list !== 'closed') (list === 'open' ? values : plain).push(unquote(t.text))
      else if (t.kind === 'lbrack' && list === 'none') list = 'open'
      else if (t.kind === 'rbrack' && list === 'open') list = 'closed'
      else bad ??= t
    }
    if (list === 'open') bad ??= words[words.length - 1]
    if (first.kind !== 'word' || bad) {
      const at = bad ?? first
      dispositions[node.id] = unsupported('not a command Junos reads')
      // Like the tree parser's, the message names punctuation, never the config's words (tree.ts).
      const what = at === words[words.length - 1] && list === 'open' ? "a '[' list with no ']'" : at.kind === 'word' ? 'a word' : `'${at.text}'`
      diagnostics.push({ severity: 'error', category: 'syntax', code: 'junos.syntax', message: `unexpected ${what} in a set command`, span: point(at.line + segment.line - 1, at.column), statement: node.id })
      continue
    }
    const verb = first.text
    commands.push({ node, line, verb, paths: list === 'none' ? [plain] : values.map((v) => [...plain, v]) })
  }

  // `delete` takes away what came before it; `deactivate` makes every statement under its path inactive.
  const statements: (Statement & { deleted?: number; inactive?: number })[] = []
  const reshaped: { path: readonly string[]; line: number }[] = []
  const deactivated: { path: readonly string[]; line: number; node: string }[] = []
  for (const command of commands) {
    const { node, line, verb, paths } = command
    const path = paths[0] ?? []
    if (verb === 'set' && !paths.length) dispositions[node.id] = ignored('an empty list: nothing to convert')
    else if (verb === 'set') {
      if (!path.length) dispositions[node.id] = unsupported('a set command with nothing to set')
      else for (const p of paths) statements.push({ node: node.id, line, words: p })
    } else if (verb === 'delete') {
      const hits = statements.filter((s) => s.deleted === undefined && startsWith(s.words, path))
      for (const s of hits) s.deleted = line
      dispositions[node.id] = ignored(hits.length ? 'deletes the statements before it under its path' : 'deletes nothing in this configuration')
    } else if (verb === 'deactivate' && path.length) deactivated.push({ path, line, node: node.id })
    else if ((verb === 'protect' || verb === 'unprotect') && path.length) dispositions[node.id] = ignored(`${verb}s the statements under its path from changes: no effect on the configuration`)
    else {
      if ((verb === 'insert' || verb === 'rename' || verb === 'copy') && path.length) reshaped.push({ path, line })
      dispositions[node.id] = unsupported(SET_COMMANDS.has(verb) ? `the ${verb} command isn't converted yet` : 'not a set command')
    }
  }
  for (const d of deactivated) {
    const hits = statements.filter((s) => s.deleted === undefined && startsWith(s.words, d.path))
    for (const s of hits) s.inactive ??= d.line
    dispositions[d.node] = ignored(hits.length ? "deactivates the statements under its path: Junos doesn't apply them" : 'deactivates nothing in this configuration')
  }

  // A node gives several statements only for a list; they share its fate.
  const active: Statement[] = []
  for (const s of statements) {
    if (s.deleted !== undefined) dispositions[s.node] = ignored(`deleted by line ${s.deleted}`)
    else if (s.inactive !== undefined) dispositions[s.node] = ignored(`deactivated by line ${s.inactive}: Junos doesn't apply it`)
    else active.push({ node: s.node, line: s.line, words: s.words })
  }
  return { form: 'set', tree, statements: active, dispositions, diagnostics, reshaped }
}
