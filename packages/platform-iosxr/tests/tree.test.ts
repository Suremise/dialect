// The indentation tree: nesting by IOS-XR's one-space indents, `!` separators and comments, and route policies, sets
// and banners kept whole.
import { describe, expect, it } from 'vitest'
import { parseTree, type XrNode } from '../src/tree'

const shape = (nodes: readonly XrNode[]): unknown[] => nodes.map((n) => (n.children.length ? { [n.text]: shape(n.children) } : n.text))

describe('parseTree', () => {
  it('nests by indentation, skips bare ! and blank lines, and keeps comments', () => {
    const text = ['!! IOS XR Configuration 7.3.2', '', 'hostname r1', '!', 'router static', ' address-family ipv4 unicast', '  0.0.0.0/0 192.0.2.1', ' !', ' vrf A', '  address-family ipv4 unicast', '   0.0.0.0/0 192.0.2.9', 'interface Loopback0', ' ! a comment', ' shutdown'].join('\n')
    const { nodes, diagnostics } = parseTree(text)
    expect(diagnostics).toEqual([])
    expect(shape(nodes)).toEqual([
      '!! IOS XR Configuration 7.3.2',
      'hostname r1',
      { 'router static': [{ 'address-family ipv4 unicast': ['0.0.0.0/0 192.0.2.1'] }, { 'vrf A': [{ 'address-family ipv4 unicast': ['0.0.0.0/0 192.0.2.9'] }] }] },
      { 'interface Loopback0': ['! a comment', 'shutdown'] }
    ])
    expect(nodes[0].kind).toBe('comment')
    expect(nodes[3].children[0].kind).toBe('comment')
  })

  it('gives each statement an id by its line, a span and its full label', () => {
    const { nodes } = parseTree('interface GigabitEthernet0/0/0/0\r\n ipv4 address 192.0.2.1 255.255.255.0\r\n')
    const child = nodes[0].children[0]
    expect(child.id).toBe('L2')
    expect(child.label).toBe('interface GigabitEthernet0/0/0/0 ipv4 address 192.0.2.1 255.255.255.0')
    expect(child.span).toEqual({ startLine: 2, startColumn: 2, endLine: 2, endColumn: 38 })
  })

  it('keeps words in quotes together', () => {
    const { nodes } = parseTree('router static\n address-family ipv4 unicast\n  10.0.0.0/8 Null0 description "two words"')
    expect(nodes[0].children[0].children[0].words.slice(-2)).toEqual(['description', '"two words"'])
  })

  describe('route policies are one atomic statement', () => {
    it('with a body that isn\'t indented, nested if … endif and comments inside', () => {
      const body = ['route-policy CUSTOMER-IN', 'if destination in CUSTOMERS then', '  if community matches-any BLACKHOLE then', '    drop', '  else', '    pass', '  endif', '# a comment', '! not a separator here', 'elseif destination in (0.0.0.0/0) then', 'drop', 'endif', 'end-policy']
      const { nodes, diagnostics } = parseTree([...body, 'hostname r1'].join('\n'))
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['policy', 1, 13], ['statement', 14, 14]])
      expect(nodes[0].text).toBe(body.join('\n'))
      expect(nodes[0].children).toEqual([])
      expect(nodes[0].label).toBe('route-policy CUSTOMER-IN (13 lines)')
    })

    it('with parameters, and as many as there are', () => {
      const { nodes } = parseTree(['route-policy set-med($med)', '  set med $med', 'end-policy', 'route-policy pass-all', '  pass', 'end-policy'].join('\n'))
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['policy', 1, 3], ['policy', 4, 6]])
    })

    it('but a policy named inside a block is a reference to one, not the start of one', () => {
      const { nodes } = parseTree(['router bgp 65000', ' neighbor 192.0.2.2', '  address-family ipv4 unicast', '   route-policy PASS in', '   route-policy PASS out', 'hostname r1'].join('\n'))
      expect(nodes.map((n) => n.kind)).toEqual(['statement', 'statement'])
      expect(nodes[0].children[0].children[0].children.map((n) => n.text)).toEqual(['route-policy PASS in', 'route-policy PASS out'])
    })

    it('an unterminated one takes the rest of the text, with an error', () => {
      const { nodes, diagnostics } = parseTree(['route-policy OPEN', '  pass', 'hostname r1', ''].join('\n'))
      expect(nodes).toHaveLength(1)
      expect(nodes[0].span).toMatchObject({ startLine: 1, endLine: 3 })
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'iosxr.unterminated-policy', statement: 'L1' }])
    })
  })

  describe('sets are one atomic statement', () => {
    it('every kind, to its end-set, with comments and continuation commas inside', () => {
      const sets = [
        ['prefix-set P', '  # first', '  192.0.2.0/24 le 32,', '  2001:db8::/32', 'end-set'],
        ['community-set C', '  65000:1,', '  ios-regex \'_65000:.*\'', 'end-set'],
        ['as-path-set A', '  originates-as \'65000\'', 'end-set'],
        ['rd-set R', '  65000:*', 'end-set'],
        ['extcommunity-set rt RT', '  65000:100', 'end-set'],
        ['large-community-set L', '  65000:1:1', 'end-set'],
        ['tag-set T', '  100', 'end-set']
      ]
      const { nodes, diagnostics } = parseTree(sets.map((s) => s.join('\n')).join('\n!\n'))
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => n.kind)).toEqual(sets.map(() => 'set'))
      expect(nodes.map((n) => n.text)).toEqual(sets.map((s) => s.join('\n')))
    })

    it('an unterminated one takes the rest of the text, with an error', () => {
      const { nodes, diagnostics } = parseTree(['prefix-set P', '  192.0.2.0/24', 'route-policy X', 'end-policy'].join('\n'))
      expect(nodes).toHaveLength(1)
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'iosxr.unterminated-set' }])
    })
  })

  describe('banners are one atomic statement', () => {
    it('over several lines, with any delimiter', () => {
      const text = ['banner motd "Hello there!', '... Welcome to \'$(hostname)\',', 'your sandbox"', 'hostname r1'].join('\n')
      const { nodes, diagnostics } = parseTree(text)
      expect(diagnostics).toEqual([])
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['banner', 1, 3], ['statement', 4, 4]])
    })

    it('with ^C as one delimiter, and ^ alone as another', () => {
      const { nodes } = parseTree(['banner exec ^CFirst line.', 'Second line.^Cignored text', 'banner login ^First line.', 'Second line.^', 'hostname r1'].join('\n'))
      expect(nodes.map((n) => [n.kind, n.span.startLine, n.span.endLine])).toEqual([['banner', 1, 2], ['banner', 3, 4], ['statement', 5, 5]])
    })

    it('an unterminated banner takes the rest of the text, with an error', () => {
      const { diagnostics } = parseTree(['banner motd #open', 'hostname r1'].join('\n'))
      expect(diagnostics).toMatchObject([{ severity: 'error', code: 'iosxr.unterminated-banner', statement: 'L1' }])
    })
  })
})
