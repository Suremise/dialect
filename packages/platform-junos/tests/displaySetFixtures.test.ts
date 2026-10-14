// jcc's 22 display set pairs (tests/fixtures/display-set, cleaned from fixtures/public/junos/pairs by cleanFixtures.ts).
// To regenerate them after changing the cleaner: DIALECT_WRITE_FIXTURES=1 npx vitest run packages/platform-junos
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { displaySet } from '../src/index'
import { cleanPairs, correctTagOrder, leftovers, ORDER_CORRECTIONS, type Pair } from './cleanFixtures'

const PUBLIC = join(__dirname, '../../../fixtures/public/junos/pairs')
const CLEANED = join(__dirname, 'fixtures/display-set')
const NUMBERS = Array.from({ length: 22 }, (_, i) => i + 1)

const read = (path: string): string => readFileSync(path, 'utf8')

function originals(): Pair[] {
  return NUMBERS.map((n) => ({ n, conf: read(join(PUBLIC, `jcc__config_${n}.conf`)), set: read(join(PUBLIC, `jcc__config_${n}_set.set`)) }))
}

if (process.env.DIALECT_WRITE_FIXTURES === '1') {
  mkdirSync(CLEANED, { recursive: true })
  for (const { n, conf, set } of cleanPairs(originals())) {
    writeFileSync(join(CLEANED, `config_${n}.conf`), conf)
    writeFileSync(join(CLEANED, `config_${n}.set`), set)
  }
}

function cleaned(n: number): Pair {
  return { n, conf: read(join(CLEANED, `config_${n}.conf`)), set: read(join(CLEANED, `config_${n}.set`)) }
}

/** A set file's lines, without blank lines or trailing whitespace. */
const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')

describe("jcc's display set pairs", () => {
  it.each(NUMBERS)('config_%i gives its expected set lines, in order', (n) => {
    const { conf, set } = cleaned(n)
    const result = displaySet(conf)
    if (!result.ok) throw new Error(`config_${n}: ${JSON.stringify(result.error)}`)
    expect(result.lines.map((line) => line.text)).toEqual(lines(set))
  })

  it('are the cleaned public pairs, exactly', () => {
    for (const expected of cleanPairs(originals())) expect(cleaned(expected.n)).toEqual(expected)
  })

  it('have no public addresses, secrets or real-looking names left', () => {
    for (const n of NUMBERS) {
      const { conf, set } = cleaned(n)
      expect({ n, found: [...leftovers(conf), ...leftovers(set)] }).toEqual({ n, found: [] })
    }
  })

  it("differ from jcc's expected order only in the corrected deactivate and protect lines", () => {
    const jcc = cleanPairs(originals(), { correctOrder: false })
    for (const [n, tagLines] of Object.entries(ORDER_CORRECTIONS)) {
      const jccOrder = jcc[Number(n) - 1].set
      const ours = cleaned(Number(n)).set
      expect(ours).not.toEqual(jccOrder)
      expect([...lines(ours)].sort()).toEqual([...lines(jccOrder)].sort())
      for (const tagLine of tagLines) {
        const at = lines(ours).indexOf(tagLine)
        const path = `set ${tagLine.slice(tagLine.indexOf(' ') + 1)} `
        expect(lines(ours).slice(at + 1).some((line) => line.startsWith(path))).toBe(false)
        expect(lines(ours)[at - 1].startsWith(path)).toBe(true)
      }
    }
  })
})

describe('correctTagOrder', () => {
  it("moves a container's tag line after its subtree, keeping the line breaks", () => {
    expect(correctTagOrder('deactivate a b\nset a b c\nset a b d\nset a e\n', ['deactivate a b'])).toBe('set a b c\nset a b d\ndeactivate a b\nset a e\n')
    expect(correctTagOrder('protect a\r\nset a x', ['protect a'])).toBe('set a x\r\nprotect a')
  })

  it('fails on a tag line that is missing or has no subtree', () => {
    expect(() => correctTagOrder('set a b\n', ['deactivate a c'])).toThrow("no line 'deactivate a c' to move")
    expect(() => correctTagOrder('deactivate z\nset a b\n', ['deactivate z'])).toThrow("no subtree under 'deactivate z'")
  })
})
