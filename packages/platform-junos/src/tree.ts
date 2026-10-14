// The generic Junos syntax tree, ported from the spike prototype. It knows the curly-brace syntax, not the Junos
// schema: a statement is its words, then `;` (a leaf), `[ … ];` (a leaf with a list) or `{ … }` (a container).
// Display set (displaySet.ts) flattens it; statements.ts reads it into statements for the model mapper.
import { JunosParseError, tokenize, type Token } from './tokenizer'

/** The tags Junos prints before a statement. `active:`, `deleted:` and other `word:` tags are kept as words, with a warning. */
const TAGS = new Set(['inactive:', 'protect:', 'replace:'])

export interface ConfigNode {
  /** The statement's words, quoted strings as written. A redacted secret (`/* SECRET-DATA *\/`) inside one is a word. */
  words: string[]
  /** Where its first token (a tag, or its first word) is. */
  line: number
  column: number
  /** A container's statements; null for a leaf. */
  children: ConfigNode[] | null
  /** A leaf's `[ … ]` list; null if it has none. */
  values: string[] | null
  inactive: boolean
  protect: boolean
  replace: boolean
  /** The `/* annotation *\/` written just before the statement. */
  annotation: string | null
}

export type WarningCode = 'unknown-tag' | 'annotation' | 'stray-annotation' | 'empty-list'

export interface ParseWarning {
  code: WarningCode
  message: string
  line: number
  column: number
}

export interface ParsedConfig {
  nodes: ConfigNode[]
  /** Unknown `word:` tags, annotations display set can't show, and other things worth telling the user. */
  warnings: ParseWarning[]
}

/** Parses curly-brace Junos config into its tree. Throws JunosParseError with the line and column of a syntax error. */
export function parseConfig(src: string): ParsedConfig {
  const tokens = tokenize(src)
  const warnings: ParseWarning[] = []
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  // Messages name punctuation and tag names, never the config's own words, values or annotations: they go to stderr,
  // logs and the UI, and a value can be a secret. The line and column say where.
  const describe = (token: Token): string => (token.kind === 'annotation' ? 'an annotation' : token.kind === 'word' ? 'a word' : `'${token.text}'`)

  const body = (opener: Token | null): ConfigNode[] => {
    const nodes: ConfigNode[] = []
    let annotation: Token | null = null
    const strayAnnotation = (): void => {
      if (!annotation) return
      warnings.push({ code: 'stray-annotation', message: "annotation isn't followed by a statement, so it isn't shown", line: annotation.line, column: annotation.column })
      annotation = null
    }
    for (;;) {
      const token = peek()
      if (!token) {
        strayAnnotation()
        if (opener) throw new JunosParseError(`missing '}' for the '{' at line ${opener.line}, column ${opener.column}`, ...endOfInput())
        return nodes
      }
      if (token.kind === 'rbrace') {
        if (!opener) throw new JunosParseError("unexpected '}'", token.line, token.column)
        strayAnnotation()
        pos++
        return nodes
      }
      if (token.kind === 'annotation') {
        strayAnnotation()
        annotation = token
        pos++
        continue
      }
      // `/* comment */;`: an annotation ended like a statement, with none to annotate. A bare `;` is still an error.
      if (token.kind === 'semi' && annotation) {
        strayAnnotation()
        pos++
        continue
      }
      const node = statement()
      if (annotation) node.annotation = annotation.text
      annotation = null
      nodes.push(node)
    }
  }

  const endOfInput = (): [number, number] => {
    // Just after the last character, which is where the missing token belongs.
    const lines = src.split('\n')
    return [lines.length, lines[lines.length - 1].replace(/\r$/, '').length + 1]
  }

  const statement = (): ConfigNode => {
    const first = peek()!
    const node: ConfigNode = { words: [], line: first.line, column: first.column, children: null, values: null, inactive: false, protect: false, replace: false, annotation: null }
    let token = peek()
    while (token && token.kind === 'word' && TAGS.has(token.text)) {
      if (token.text === 'inactive:') node.inactive = true
      else if (token.text === 'protect:') node.protect = true
      else node.replace = true
      pos++
      token = peek()
    }
    while (token && (token.kind === 'word' || (token.kind === 'annotation' && node.words.length > 0))) {
      if (token.kind === 'annotation') {
        // A redacted secret: `encrypted-password /* SECRET-DATA */;`
        node.words.push(`/* ${token.text} */`)
      } else {
        if (node.words.length === 0 && /^[A-Za-z]+:$/.test(token.text)) {
          warnings.push({ code: 'unknown-tag', message: `unknown tag '${token.text}' kept as a word`, line: token.line, column: token.column })
        }
        node.words.push(token.text)
      }
      pos++
      token = peek()
    }
    if (!token) throw new JunosParseError("statement isn't ended by ';' or '{'", ...endOfInput())
    if (node.words.length === 0) throw new JunosParseError(`expected a statement, got ${describe(token)}`, token.line, token.column)
    if (token.kind === 'semi') pos++
    else if (token.kind === 'lbrace') {
      pos++
      node.children = body(token)
    } else if (token.kind === 'lbrack') {
      pos++
      const values: string[] = []
      let value = peek()
      while (value && value.kind === 'word') {
        values.push(value.text)
        pos++
        value = peek()
      }
      if (!value) throw new JunosParseError(`missing ']' for the '[' at line ${token.line}, column ${token.column}`, ...endOfInput())
      if (value.kind !== 'rbrack') throw new JunosParseError(`expected ']', got ${describe(value)}`, value.line, value.column)
      pos++
      const semi = peek()
      if (!semi) throw new JunosParseError("expected ';' after ']'", ...endOfInput())
      if (semi.kind !== 'semi') throw new JunosParseError(`expected ';' after ']', got ${describe(semi)}`, semi.line, semi.column)
      pos++
      if (values.length === 0) {
        warnings.push({ code: 'empty-list', message: "empty list '[ ]' gives no set line", line: token.line, column: token.column })
      }
      node.values = values
    } else if (token.kind === 'rbrace') {
      throw new JunosParseError(`missing ';' after the statement at line ${node.line}, column ${node.column}`, token.line, token.column)
    } else throw new JunosParseError(`unexpected ${describe(token)}`, token.line, token.column)
    return node
  }

  const nodes = body(null)
  return { nodes, warnings }
}
