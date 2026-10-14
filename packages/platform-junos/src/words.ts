// Junos words, quoted and not: the tokenizer keeps a quoted string as written (`"some location"`), the mapper wants its
// value, and the renderer quotes a value when Junos would otherwise read it as more than one word.

/** A word's value: a quoted string without its quotes and with its escapes undone (`\"` → `"`). */
export function unquote(word: string): string {
  if (word.length < 2 || !word.startsWith('"') || !word.endsWith('"')) return word
  return word.slice(1, -1).replace(/\\(.)/gs, '$1')
}

/** A value as one Junos word: quoted when it is empty or has a space or punctuation Junos reads as syntax. */
export function quote(value: string): string {
  return value !== '' && !/[\s"'{}[\];#\\]/.test(value) && !value.startsWith('/*') ? value : `"${value.replace(/["\\]/g, '\\$&')}"`
}
