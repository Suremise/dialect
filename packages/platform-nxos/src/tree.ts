// The NX-OS syntax tree: one statement per line, nested by indentation (NX-OS indents by two spaces), with `!` lines as
// separators and `!Command:`/`!Time:` headers as comments. A banner's body is delimited rather than indented, so the
// parser recognises it and keeps it whole, verbatim, as one atomic statement (docs/spike-desktop-app.md, Approach):
// `banner motd #…#`, any delimiter, over as many lines as it takes.
import type { Diagnostic, Span, SyntaxNode } from '@dialect/core'

/** What a statement is, when it isn't an ordinary command line. */
export type NodeKind = 'statement' | 'comment' | 'banner'

export interface NxNode extends SyntaxNode {
  readonly kind: NodeKind
  /** The statement as written: the line without its indentation; for a banner, every line of it verbatim. */
  readonly text: string
  /** Its words, quoted strings kept whole (`name "two words"` is two words). Only the first line's for a banner. */
  readonly words: readonly string[]
  /** Leading whitespace of its first line, in characters. */
  readonly indent: number
  readonly span: Span
  readonly children: readonly NxNode[]
}

export interface NxTree {
  readonly nodes: readonly NxNode[]
  readonly diagnostics: readonly Diagnostic[]
}

/** A line's words: whitespace-separated, with a double-quoted string as one word (quotes kept). */
export function words(line: string): string[] {
  return [...line.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0])
}

/** A word without its double quotes, if it has them. */
export const unquote = (word: string): string => (word.length >= 2 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word)

const BANNER = /^banner(?:\s|$)/
/** NX-OS's banner types; `banner <delimiter>…` alone is read as the MOTD banner, as IOS does. */
export const BANNER_TYPES: ReadonlySet<string> = new Set(['motd', 'exec'])

type Mutable = { -readonly [K in keyof NxNode]: K extends 'children' ? NxNode[] : NxNode[K] }

/** Parses `text` into its statements. Errors (an unterminated banner) are diagnostics, not throws. */
export function parseTree(text: string): NxTree {
  const lines = text.split(/\r\n?|\n/)
  const diagnostics: Diagnostic[] = []
  const roots: Mutable[] = []
  /** The open containers, innermost last. */
  const stack: Mutable[] = []

  const add = (node: Mutable) => {
    while (stack.length && stack[stack.length - 1].indent >= node.indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) {
      node.label = `${parent.label} ${node.label}`
      parent.children.push(node)
    } else roots.push(node)
    if (node.kind === 'statement') stack.push(node)
  }

  const node = (kind: NodeKind, first: number, last: number, body: string, indent: number): Mutable => {
    const firstText = lines[first].slice(indent)
    return {
      id: `L${first + 1}`,
      label: kind === 'banner' ? `${firstText.trim()} (${last - first + 1} lines)` : firstText.trimEnd(),
      kind,
      text: body,
      words: words(firstText),
      indent,
      span: { startLine: first + 1, startColumn: indent + 1, endLine: last + 1, endColumn: lines[last].length + 1 },
      children: []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed === '!') continue
    const indent = line.length - line.trimStart().length

    if (trimmed.startsWith('!')) {
      add(node('comment', i, i, trimmed, indent))
      continue
    }

    if (BANNER.test(trimmed)) {
      const end = bannerEnd(lines, i, indent)
      if (end === null) {
        diagnostics.push({ severity: 'error', category: 'syntax', code: 'nxos.unterminated-banner', message: `The banner on line ${i + 1} has no closing delimiter: the rest of the text is taken as its body.`, span: { startLine: i + 1, startColumn: indent + 1, endLine: i + 1, endColumn: line.length + 1 }, statement: `L${i + 1}` })
      }
      const last = end ?? lastLine(lines)
      add(node('banner', i, last, lines.slice(i, last + 1).join('\n').slice(indent), indent))
      i = last
      continue
    }

    add(node('statement', i, i, line.slice(indent).trimEnd(), indent))
  }
  return { nodes: roots, diagnostics }
}

/** The last line with anything on it, so an unterminated body doesn't swallow trailing blank lines. */
function lastLine(lines: readonly string[]): number {
  let last = lines.length - 1
  while (last > 0 && !lines[last].trim()) last--
  return last
}

/**
 * The line a banner starting on line `i` ends on, or null when its closing delimiter never comes. The delimiter is the
 * first character after `banner [type]` (`^C`, as some tools write Ctrl-C, is one delimiter of two characters). Text
 * after the closing delimiter on its line belongs to the statement too.
 */
export function bannerEnd(lines: readonly string[], i: number, indent: number): number | null {
  const first = lines[i].slice(indent)
  const m = /^banner\s+(\S+)/.exec(first)
  if (!m) return null
  let at = m.index + m[0].length - m[1].length
  if (BANNER_TYPES.has(m[1].toLowerCase())) {
    const rest = /^\s*/.exec(first.slice(at + m[1].length))
    at += m[1].length + (rest ? rest[0].length : 0)
  }
  if (at >= first.length) return null
  const delimiter = first.startsWith('^C', at) ? '^C' : first[at]
  let from = at + delimiter.length
  for (let j = i; j < lines.length; j++) {
    const text = j === i ? first : lines[j]
    if (text.indexOf(delimiter, j === i ? from : 0) >= 0) return j
    from = 0
  }
  return null
}
