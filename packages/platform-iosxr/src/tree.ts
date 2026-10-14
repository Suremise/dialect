// The IOS-XR syntax tree: one statement per line, nested by indentation (IOS-XR indents by one space), with `!` lines as
// separators and `!!` headers (`!! IOS XR Configuration 7.3.2`) as comments. Three bodies are delimited rather than
// indented, so the parser recognises them and keeps each whole, verbatim, as one atomic statement with no children
// (docs/spike-desktop-app.md, Approach):
// - a **route policy** (RPL), `route-policy NAME` … `end-policy`, with its `if … then … elseif … else … endif` blocks
//   and `#` comments inside, however its body is indented (or not);
// - a **set**, `prefix-set`, `community-set`, `as-path-set`, `rd-set`, `extcommunity-set rt` and the rest … `end-set`;
// - a **banner**, `banner motd #…#`, any delimiter, over as many lines as it takes.
// A policy or set is never split: the model can't hold one yet, and a half-converted policy would mean something else.
import type { Diagnostic, Span, SyntaxNode } from '@dialect/core'

/** What a statement is, when it isn't an ordinary command line. */
export type NodeKind = 'statement' | 'comment' | 'banner' | 'policy' | 'set'

export interface XrNode extends SyntaxNode {
  readonly kind: NodeKind
  /** The statement as written: the line without its indentation; for a delimited body, every line of it verbatim. */
  readonly text: string
  /** Its words, quoted strings kept whole (`description "two words"` is two words). Only the first line's for a body. */
  readonly words: readonly string[]
  /** Leading whitespace of its first line, in characters. */
  readonly indent: number
  readonly span: Span
  readonly children: readonly XrNode[]
}

export interface XrTree {
  readonly nodes: readonly XrNode[]
  readonly diagnostics: readonly Diagnostic[]
}

/** A line's words: whitespace-separated, with a double-quoted string as one word (quotes kept). */
export function words(line: string): string[] {
  return [...line.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0])
}

/** A word without its double quotes, if it has them. */
export const unquote = (word: string): string => (word.length >= 2 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word)

const BANNER = /^banner(?:\s|$)/
/** IOS-XR's banner types; `banner <delimiter>…` alone is read as the MOTD banner. */
export const BANNER_TYPES: ReadonlySet<string> = new Set(['motd', 'exec', 'login', 'incoming', 'prompt-timeout', 'slip-ppp'])

/**
 * The delimited body a top-level line opens, and the line that ends it: `route-policy NAME` … `end-policy`, or any
 * `<type>-set …` … `end-set`. Only at the top level: `route-policy NAME in` inside `router bgp` is a reference to one.
 */
export function bodyKind(firstWord: string | undefined): { kind: 'policy' | 'set'; end: string } | null {
  if (firstWord === 'route-policy') return { kind: 'policy', end: 'end-policy' }
  if (firstWord !== undefined && /^[a-z][a-z0-9-]*-set$/.test(firstWord) && firstWord !== 'end-set') return { kind: 'set', end: 'end-set' }
  return null
}

type Mutable = { -readonly [K in keyof XrNode]: K extends 'children' ? XrNode[] : XrNode[K] }

/** Parses `text` into its statements. Errors (an unterminated banner, policy or set) are diagnostics, not throws. */
export function parseTree(text: string): XrTree {
  const lines = text.split(/\r\n?|\n/)
  const diagnostics: Diagnostic[] = []
  const roots: Mutable[] = []
  /** The open containers, innermost last. */
  const stack: Mutable[] = []

  /** Closes the containers `indent` is outside of; whether the line is then at the top level. */
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    return !stack.length
  }
  const add = (node: Mutable) => {
    closeTo(node.indent)
    const parent = stack[stack.length - 1]
    if (parent) {
      node.label = `${parent.label} ${node.label}`
      parent.children.push(node)
    } else roots.push(node)
    if (node.kind === 'statement') stack.push(node)
  }

  const node = (kind: NodeKind, first: number, last: number, body: string, indent: number): Mutable => {
    const firstText = lines[first].slice(indent)
    const multi = kind === 'banner' || kind === 'policy' || kind === 'set'
    return {
      id: `L${first + 1}`,
      label: multi ? `${firstText.trim()} (${last - first + 1} lines)` : firstText.trimEnd(),
      kind,
      text: body,
      words: words(firstText),
      indent,
      span: { startLine: first + 1, startColumn: indent + 1, endLine: last + 1, endColumn: lines[last].length + 1 },
      children: []
    }
  }
  const unterminated = (i: number, indent: number, code: string, what: string) =>
    diagnostics.push({ severity: 'error', category: 'syntax', code: `iosxr.unterminated-${code}`, message: `The ${what} on line ${i + 1} has no end: the rest of the text is taken as its body.`, span: { startLine: i + 1, startColumn: indent + 1, endLine: i + 1, endColumn: lines[i].length + 1 }, statement: `L${i + 1}` })

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
      if (end === null) unterminated(i, indent, 'banner', 'banner')
      const last = end ?? lastLine(lines)
      add(node('banner', i, last, lines.slice(i, last + 1).join('\n').slice(indent), indent))
      i = last
      continue
    }

    const body = bodyKind(words(trimmed)[0])
    if (body && closeTo(indent)) {
      // The body runs to its end line, whatever its indentation: RPL needn't be indented, and `endif` closes no block.
      let end: number | null = null
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === body.end) {
          end = j
          break
        }
      }
      if (end === null) unterminated(i, indent, body.kind, body.kind === 'policy' ? 'route policy' : 'set')
      const last = end ?? lastLine(lines)
      add(node(body.kind, i, last, lines.slice(i, last + 1).join('\n').slice(indent), indent))
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
 * first character after `banner [type]` (`^C`, as `show running-config` writes Ctrl-C, is one delimiter of two
 * characters). Text after the closing delimiter on its line belongs to the statement too.
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
