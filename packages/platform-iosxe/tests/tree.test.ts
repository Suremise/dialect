// The indentation tree: nesting, `!` separators and comments, and the two delimited bodies kept whole (banners and
// certificate chains).
import { describe, expect, it } from 'vitest'
import { parseTree, type IosNode } from '../src/tree'

const shape = (nodes: readonly IosNode[]): unknown[] => nodes.map((n) => (n.children.length ? { [n.text]: shape(n.children) } : n.text))

describe('parseTree', () => {
  it('nests by indentation, skips bare ! and blank lines, and keeps comments', () => {
    const { nodes, diagnostics } = parseTree(['hostname r1', '!', '! a comment', 'interface Gi1', ' description up', '  deeper', ' shutdown', '', 'line vty 0 4', ' login'].join('\n'))
    expect(diagnostics).toEqual([])
    expect(shape(nodes)).toEqual(['hostname r1', '! a comment', { 'interface Gi1': [{ 'description up': ['deeper'] }, 'shutdown'] }, { 'line vty 0 4': ['login'] }])
    expect(nodes[1].kind).toBe('comment')
  })

  it('gives each statement an id by its line, a span and its full label', () => {
    const { nodes } = parseTree('interface Gi1\r\n ip address 192.0.2.1 255.255.255.0\r\n')
    const child = nodes[0].children[0]
    expect(child.id).toBe('L2')
    expect(child.label).toBe('interface Gi1 ip address 192.0.2.1 255.255.255.0')
    expect(child.span).toEqual({ startLine: 2, startColumn: 2, endLine: 2, endColumn: 36 })
  })

  it('keeps words in quotes together', () => {
    const { nodes } = parseTree('ip route vrf M 0.0.0.0 0.0.0.0 192.0.2.1 name "two words"')
    expect(nodes[0].words.slice(-2)).toEqual(['name', '"two words"'])
  })

  describe('banners are one atomic statement', () => {
    it('with ^C as show running-config writes it, over several lines', () => {
      const text = ['banner motd ^C', 'line one', '  indented line', '! not a comment', 'interface Gi9', '^C', 'hostname r1'].join('\n')
      const { nodes, diagnostics } = parseTree(text)
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => n.kind)).toEqual(['banner', 'statement'])
      expect(nodes[0].text).toBe(text.split('\n').slice(0, 6).join('\n'))
      expect(nodes[0].children).toEqual([])
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 6 })
      expect(nodes[1].text).toBe('hostname r1')
    })

    it('with any delimiter, closing on the same line or with text after it', () => {
      const { nodes } = parseTree(['banner login #Hello#', 'banner exec ^CFirst.', 'Second.^Cignored', 'banner XhiX', 'hostname r1'].join('\n'))
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['banner', 1, 1], ['banner', 2, 3], ['banner', 4, 4], ['statement', 5, 5]])
    })

    it('a body starting with the delimiter\'s letters (^CCCC: the delimiter ^C, then CCC)', () => {
      const { nodes } = parseTree(['banner exec ^CCCC', '****^C', 'hostname r1'].join('\n'))
      expect(nodes.map((n) => n.kind)).toEqual(['banner', 'statement'])
    })

    it('an unterminated banner takes the rest of the text, with an error', () => {
      const { nodes, diagnostics } = parseTree(['banner motd #open', 'hostname r1', ''].join('\n'))
      expect(nodes).toHaveLength(1)
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 2 })
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'iosxe.unterminated-banner', statement: 'L1' }])
    })
  })

  describe('certificate chains are one atomic statement', () => {
    const chain = ['crypto pki certificate chain TP-1', ' certificate self-signed 01', '  3082 0330', '3082 0218', '  \tquit', ' certificate ca 02', '  AAAA', '  quit']

    it('every certificate to its quit, whatever the indentation of its hex', () => {
      const { nodes, diagnostics } = parseTree([...chain, '!', 'hostname r1'].join('\n'))
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => n.kind)).toEqual(['certificate-chain', 'statement'])
      expect(nodes[0].text).toBe(chain.join('\n'))
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 8 })
    })

    it('a certificate with no quit takes the rest of the text, with an error', () => {
      const { nodes, diagnostics } = parseTree(chain.slice(0, 4).join('\n'))
      expect(nodes).toHaveLength(1)
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'iosxe.unterminated-certificate' }])
    })
  })
})
