// The indentation tree: nesting by NX-OS's two-space indents, `!` separators and comments, and banners kept whole.
import { describe, expect, it } from 'vitest'
import { parseTree, type NxNode } from '../src/tree'

const shape = (nodes: readonly NxNode[]): unknown[] => nodes.map((n) => (n.children.length ? { [n.text]: shape(n.children) } : n.text))

describe('parseTree', () => {
  it('nests by indentation, skips bare ! and blank lines, and keeps comments', () => {
    const text = ['!Command: show running-config', '', 'hostname n1', '!', 'vrf context A', '  address-family ipv4 unicast', '    route-target both auto', '  ip route 0.0.0.0/0 192.0.2.1', 'interface Ethernet1/1', '  ! a comment', '  no shutdown'].join('\n')
    const { nodes, diagnostics } = parseTree(text)
    expect(diagnostics).toEqual([])
    expect(shape(nodes)).toEqual(['!Command: show running-config', 'hostname n1', { 'vrf context A': [{ 'address-family ipv4 unicast': ['route-target both auto'] }, 'ip route 0.0.0.0/0 192.0.2.1'] }, { 'interface Ethernet1/1': ['! a comment', 'no shutdown'] }])
    expect(nodes[0].kind).toBe('comment')
    expect(nodes[3].children[0].kind).toBe('comment')
  })

  it('gives each statement an id by its line, a span and its full label', () => {
    const { nodes } = parseTree('interface Ethernet1/1\r\n  ip address 192.0.2.1/24\r\n')
    const child = nodes[0].children[0]
    expect(child.id).toBe('L2')
    expect(child.label).toBe('interface Ethernet1/1 ip address 192.0.2.1/24')
    expect(child.span).toEqual({ startLine: 2, startColumn: 3, endLine: 2, endColumn: 26 })
  })

  it('keeps words in quotes together', () => {
    const { nodes } = parseTree('ip route 0.0.0.0/0 192.0.2.1 name "two words"')
    expect(nodes[0].words.slice(-2)).toEqual(['name', '"two words"'])
  })

  describe('banners are one atomic statement', () => {
    it('over several lines, with any delimiter', () => {
      const text = ['banner motd ^', 'Welcome.', '  indented line', '! not a comment', 'interface Ethernet1/9', '^', 'hostname n1'].join('\n')
      const { nodes, diagnostics } = parseTree(text)
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => n.kind)).toEqual(['banner', 'statement'])
      expect(nodes[0].text).toBe(text.split('\n').slice(0, 6).join('\n'))
      expect(nodes[0].children).toEqual([])
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 6 })
    })

    it('closing on the same line, or after text on a later one, with space before the delimiter', () => {
      const { nodes } = parseTree(['banner motd  ^oneline^', 'banner exec *multi', 'line*garbage', 'hostname n1'].join('\n'))
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['banner', 1, 1], ['banner', 2, 3], ['statement', 4, 4]])
    })

    it('an unterminated banner takes the rest of the text, with an error', () => {
      const { nodes, diagnostics } = parseTree(['banner motd #open', 'hostname n1', ''].join('\n'))
      expect(nodes).toHaveLength(1)
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 2 })
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'nxos.unterminated-banner', statement: 'L1' }])
    })
  })
})
