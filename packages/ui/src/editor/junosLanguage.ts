// Syntax colouring for Junos config, curly-brace and set form, as a CodeMirror stream language. Colouring only: the
// Junos plugin's parser does the real work, and its errors show in the problems panel.
import { StreamLanguage, type StreamParser } from '@codemirror/language'

interface JunosState {
  /** Inside a `/* annotation *\/` that spans lines. */
  inAnnotation: boolean
  /** At the first word of a line (set form: the command). */
  lineStart: boolean
}

const TAGS = /^(inactive|protect|replace|active|deleted):/
const COMMANDS = /^(set|deactivate|protect|delete|activate)(?=\s|$)/
const NUMBER = /^(\d+(\.\d+){0,3}(\/\d+)?|[0-9a-f]*:[0-9a-f:]+(\/\d+)?)(?=[\s;{}[\]]|$)/i

const parser: StreamParser<JunosState> = {
  name: 'junos',
  startState: () => ({ inAnnotation: false, lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true
    if (state.inAnnotation) {
      if (stream.skipTo('*/')) {
        stream.match('*/')
        state.inAnnotation = false
      } else stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null
    const first = state.lineStart
    state.lineStart = false
    if (stream.match('/*')) {
      if (stream.skipTo('*/')) stream.match('*/')
      else {
        stream.skipToEnd()
        state.inAnnotation = true
      }
      return 'comment'
    }
    if (stream.peek() === '#') {
      stream.skipToEnd()
      return 'lineComment'
    }
    if (stream.peek() === '"') {
      stream.next()
      while (!stream.eol()) {
        const c = stream.next()
        if (c === '\\') stream.next()
        else if (c === '"') break
      }
      return 'string'
    }
    if (stream.match(/^[{}]/)) return 'brace'
    if (stream.match(/^[[\]]/)) return 'squareBracket'
    if (stream.match(';')) return 'punctuation'
    if (stream.match(TAGS)) return 'modifier'
    if (first && stream.match(COMMANDS)) return 'keyword'
    if (stream.match(NUMBER)) return 'number'
    if (!stream.match(/^[^\s;{}[\]"]+/)) stream.next()
    return null
  }
}

export const junos = StreamLanguage.define(parser)
