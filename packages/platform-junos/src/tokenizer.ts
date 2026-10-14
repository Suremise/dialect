// The Junos curly-brace tokenizer, ported from the spike prototype (spike/display_set/junos_set.py, card #1).
// Words (with quoted strings and their escapes kept as written), braces, brackets, `;` and `/* annotations */`.
// `#` starts a comment to the end of the line (`## Last commit: …`, `## SECRET-DATA`). CRLF and tabs are whitespace.

export type TokenKind = 'word' | 'lbrace' | 'rbrace' | 'semi' | 'lbrack' | 'rbrack' | 'annotation'

export interface Token {
  kind: TokenKind
  /** The word as written (quotes and escapes included), the punctuation, or an annotation's trimmed text. */
  text: string
  /** 1-based line and column of the token's first character (columns count UTF-16 code units, a tab as one). */
  line: number
  column: number
}

/** A syntax error, with the 1-based line and column it was found at. */
export class JunosParseError extends Error {
  readonly line: number
  readonly column: number
  /** The message without its position. */
  readonly reason: string

  constructor(reason: string, line: number, column: number) {
    super(`line ${line}, column ${column}: ${reason}`)
    this.name = 'JunosParseError'
    this.reason = reason
    this.line = line
    this.column = column
  }
}

const PUNCTUATION = new Map<string, TokenKind>([
  ['{', 'lbrace'],
  ['}', 'rbrace'],
  [';', 'semi'],
  ['[', 'lbrack'],
  [']', 'rbrack']
])

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n'
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  const n = src.length

  // Line and column of an offset. Tokens come in order, so this only ever scans forward, once over the whole input.
  let scanned = 0
  let line = 1
  let lineStart = 0
  const at = (offset: number): [number, number] => {
    for (; scanned < offset; scanned++) {
      if (src[scanned] === '\n') {
        line++
        lineStart = scanned + 1
      }
    }
    return [line, offset - lineStart + 1]
  }

  let i = 0
  while (i < n) {
    const c = src[i]
    if (isSpace(c)) i++
    else if (c === '#') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? n : end
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) throw new JunosParseError('unterminated /* annotation */', ...at(i))
      const [tokenLine, column] = at(i)
      tokens.push({ kind: 'annotation', text: src.slice(i + 2, end).trim(), line: tokenLine, column })
      i = end + 2
    } else if (PUNCTUATION.has(c)) {
      const [tokenLine, column] = at(i)
      tokens.push({ kind: PUNCTUATION.get(c)!, text: c, line: tokenLine, column })
      i++
    } else {
      const start = i
      while (i < n && !isSpace(src[i]) && !PUNCTUATION.has(src[i])) {
        if (src[i] === '"') {
          i++
          while (i < n && src[i] !== '"') i += src[i] === '\\' && i + 1 < n ? 2 : 1
          if (i >= n) throw new JunosParseError('unterminated quoted string', ...at(start))
        }
        i++
      }
      const [tokenLine, column] = at(start)
      tokens.push({ kind: 'word', text: src.slice(start, i), line: tokenLine, column })
    }
  }
  return tokens
}
