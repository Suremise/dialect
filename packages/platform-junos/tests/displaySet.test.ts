// The spike prototype's 12 self-test cases (spike/display_set/junos_set.py --selftest, card #1), and a case for each
// jcc failure in the spike report (docs/spike-desktop-app.md, "Prior art: … jcc", "What I tested").
import { describe, expect, it } from 'vitest'
import { displaySet, JunosParseError, parseConfig, tokenize } from '../src/index'

/** The set lines for `src`, failing the test on a parse error. */
function setLines(src: string): string[] {
  const result = displaySet(src)
  if (!result.ok) throw new Error(`unexpected parse error: ${JSON.stringify(result.error)}`)
  return result.lines.map((line) => line.text)
}

function parseError(src: string): { message: string; line: number; column: number } {
  const result = displaySet(src)
  if (result.ok) throw new Error(`expected a parse error, got ${JSON.stringify(result.lines)}`)
  return result.error
}

describe("the prototype's self-test cases", () => {
  it('leaf, CRLF, tabs', () => {
    expect(setLines('system {\r\n\thost-name r1;\r\n}\r\n')).toEqual(['set system host-name r1'])
  })

  it('no trailing newline', () => {
    expect(setLines('version 21.4R3;')).toEqual(['set version 21.4R3'])
  })

  it('annotation not in output', () => {
    expect(setLines('system {\n    /* mgmt */\n    host-name r1;\n}\n')).toEqual(['set system host-name r1'])
  })

  it('quoted with ; { and escaped quote', () => {
    expect(setLines('interfaces {\n    ge-0/0/0 {\n        description "a; {b} \\"c d\\"";\n    }\n}\n')).toEqual(['set interfaces ge-0/0/0 description "a; {b} \\"c d\\""'])
  })

  it('list', () => {
    expect(setLines('vlans {\n    v10 {\n        vlan-id-list [ 10 20 ];\n    }\n}\n')).toEqual(['set vlans v10 vlan-id-list 10', 'set vlans v10 vlan-id-list 20'])
  })

  it("'set' inside a name", () => {
    const src = 'firewall {\n    filter F {\n        inactive: term block-reset {\n            then {\n                inactive: reject tcp-reset;\n            }\n        }\n    }\n}\n'
    expect(setLines(src)).toEqual([
      'set firewall filter F term block-reset then reject tcp-reset',
      'deactivate firewall filter F term block-reset then reject tcp-reset',
      'deactivate firewall filter F term block-reset'
    ])
  })

  it("inactive stanza: deactivate after its subtree (Juniper's documented example)", () => {
    const src = 'interfaces {\n    xe-0/0/0 {\n        inactive: unit 1 {\n            family inet {\n                address 10.0.0.1/8;\n            }\n        }\n    }\n}\n'
    expect(setLines(src)).toEqual(['set interfaces xe-0/0/0 unit 1 family inet address 10.0.0.1/8', 'deactivate interfaces xe-0/0/0 unit 1'])
  })

  it('leading underscore and @', () => {
    expect(setLines('system {\n    host-name _r1;\n    location @lab;\n}\n')).toEqual(['set system host-name _r1', 'set system location @lab'])
  })

  it('empty container', () => {
    expect(setLines('interfaces {\n    ge-0/0/1 {\n    }\n}\n')).toEqual(['set interfaces ge-0/0/1'])
  })

  it('unterminated quote', () => {
    expect(parseError('system {\n    host-name "r1;\n}\n')).toEqual({ message: 'unterminated quoted string', line: 2, column: 15 })
  })

  it('missing brace', () => {
    expect(parseError('system {\n    host-name r1;\n')).toEqual({ message: "missing '}' for the '{' at line 1, column 8", line: 3, column: 1 })
  })

  it('stray brace', () => {
    expect(parseError('}\n')).toEqual({ message: "unexpected '}'", line: 1, column: 1 })
  })
})

describe("jcc's failure cases, from the spike report", () => {
  it("prints an inactive or protected stanza's deactivate and protect after its subtree, not before", () => {
    const src = 'interfaces {\n    inactive: protect: ge-0/0/0 {\n        description x;\n        unit 0 {\n            family inet;\n        }\n    }\n}\n'
    expect(setLines(src)).toEqual([
      'set interfaces ge-0/0/0 description x',
      'set interfaces ge-0/0/0 unit 0 family inet',
      'deactivate interfaces ge-0/0/0',
      'protect interfaces ge-0/0/0'
    ])
  })

  it("doesn't rewrite 'set' inside words when deactivating (block-reset, tcp-reset)", () => {
    const lines = setLines('firewall {\n    filter F {\n        inactive: term block-reset {\n            then {\n                inactive: reject tcp-reset;\n            }\n        }\n    }\n}\n')
    expect(lines.join('\n')).not.toContain('redeactivate')
    expect(lines).toContain('deactivate firewall filter F term block-reset')
  })

  it("keeps annotations out of the path, and warns that they aren't shown", () => {
    const result = displaySet('system {\n    /* management box */\n    host-name r1;\n}\n')
    expect(result).toEqual({
      ok: true,
      lines: [{ text: 'set system host-name r1', sourceLine: 3 }],
      warnings: [{ code: 'annotation', message: "annotation /* management box */ on 'system host-name r1' isn't shown in display set", line: 3, column: 5 }]
    })
  })

  it('reads a last line with no trailing newline', () => {
    expect(setLines('system {\n    host-name r1;\n}\nversion 21.4R3;')).toEqual(['set system host-name r1', 'set version 21.4R3'])
  })

  it('reports an unterminated quote as an error with its position, without hanging', () => {
    expect(parseError('system {\n    login {\n        message "welcome;\n    }\n}\n')).toEqual({ message: 'unterminated quoted string', line: 3, column: 17 })
  })

  it('keeps the first character of words starting with _, @ or =', () => {
    expect(setLines('system {\n    host-name _r1;\n    location @lab;\n    domain-name =x;\n}\n')).toEqual(['set system host-name _r1', 'set system location @lab', 'set system domain-name =x'])
  })

  it("keeps an unknown tag such as 'deleted:' as a word, with a warning", () => {
    const result = displaySet('protocols {\n    deleted: ospf {\n        area 0.0.0.0;\n    }\n}\n')
    expect(result).toEqual({
      ok: true,
      lines: [{ text: 'set protocols deleted: ospf area 0.0.0.0', sourceLine: 3 }],
      warnings: [{ code: 'unknown-tag', message: "unknown tag 'deleted:' kept as a word", line: 2, column: 5 }]
    })
  })

  it('reports bad input as an error with a line and column, not wrong output', () => {
    expect(parseError('system {\n    host-name r1\n}\n')).toEqual({ message: "missing ';' after 'host-name r1'", line: 3, column: 1 })
    expect(parseError('system {\n    name-server [ 192.0.2.1 { ];\n}\n')).toEqual({ message: "expected ']', got '{'", line: 2, column: 29 })
  })
})

describe('the parser', () => {
  it("works out what jcc gets right too: protect and replace, lists, groups, quoted strings, '#' comments", () => {
    const src = [
      '## Last commit: 2026-01-01 00:00:00 UTC',
      'version 21.4R3;',
      'groups {',
      '    G {',
      '        interfaces {',
      '            <*> {',
      '                mtu 9192;',
      '            }',
      '        }',
      '    }',
      '}',
      'apply-groups G;',
      'system {',
      '    replace: syslog {',
      '        file messages {',
      '            any notice;',
      '        }',
      '    }',
      '    protect: name-server [ 192.0.2.1 192.0.2.2 ];',
      '    root-authentication {',
      '        encrypted-password "$6$PLACEHOLDER"; ## SECRET-DATA',
      '    }',
      '    login {',
      '        message "a; {b} \\"c\\"";',
      '    }',
      '}'
    ].join('\n')
    expect(setLines(src)).toEqual([
      'set version 21.4R3',
      'set groups G interfaces <*> mtu 9192',
      'set apply-groups G',
      'set system syslog file messages any notice',
      'set system name-server 192.0.2.1',
      'set system name-server 192.0.2.2',
      'protect system name-server',
      'set system root-authentication encrypted-password "$6$PLACEHOLDER"',
      'set system login message "a; {b} \\"c\\""'
    ])
  })

  it('keeps a redacted secret placeholder as a word', () => {
    expect(setLines('system {\n    root-authentication {\n        encrypted-password /* SECRET-DATA */;\n    }\n}\n')).toEqual(['set system root-authentication encrypted-password /* SECRET-DATA */'])
  })

  it('maps each set line back to its source line', () => {
    const result = displaySet('system {\n    host-name r1;\n    inactive: services {\n        ssh;\n    }\n}\n')
    expect(result.ok && result.lines).toEqual([
      { text: 'set system host-name r1', sourceLine: 2 },
      { text: 'set system services ssh', sourceLine: 4 },
      { text: 'deactivate system services', sourceLine: 3 }
    ])
  })

  it('warns about an annotation with no statement after it, and about an empty list', () => {
    const result = displaySet('system {\n    host-name r1;\n    /* nothing after this */\n}\nvlans {\n    v10 {\n        vlan-id-list [ ];\n    }\n}\n')
    expect(result.ok && result.warnings).toEqual([
      { code: 'stray-annotation', message: "annotation /* nothing after this */ isn't followed by a statement and isn't shown", line: 3, column: 5 },
      { code: 'empty-list', message: "empty list '[ ]' on 'vlan-id-list' gives no set line", line: 7, column: 22 }
    ])
  })

  it('reports the other syntax errors with their positions', () => {
    expect(parseError('system {\n    /* never closed\n}\n')).toEqual({ message: 'unterminated /* annotation */', line: 2, column: 5 })
    expect(parseError('system {\n    name-server [ 192.0.2.1')).toEqual({ message: "missing ']' for the '[' at line 2, column 17", line: 2, column: 28 })
    expect(parseError('system {\n    name-server [ 192.0.2.1 ]\n}\n')).toEqual({ message: "expected ';' after ']', got '}'", line: 3, column: 1 })
    expect(parseError('system {\n    host-name r1')).toEqual({ message: "statement isn't ended by ';' or '{'", line: 2, column: 17 })
    expect(parseError('system {\n    ;\n}\n')).toEqual({ message: "expected a statement, got ';'", line: 2, column: 5 })
    expect(parseError('system {\n    host-name r1 ]\n}\n')).toEqual({ message: "unexpected ']'", line: 2, column: 18 })
  })

  it('throws JunosParseError from parseConfig, with the position in the message', () => {
    expect(() => parseConfig('}')).toThrow(JunosParseError)
    expect(() => parseConfig('}')).toThrow("line 1, column 1: unexpected '}'")
  })

  it('tokenizes with 1-based lines and columns, tabs as one column', () => {
    expect(tokenize('a {\r\n\tb "c d";\n}')).toEqual([
      { kind: 'word', text: 'a', line: 1, column: 1 },
      { kind: 'lbrace', text: '{', line: 1, column: 3 },
      { kind: 'word', text: 'b', line: 2, column: 2 },
      { kind: 'word', text: '"c d"', line: 2, column: 4 },
      { kind: 'semi', text: ';', line: 2, column: 9 },
      { kind: 'rbrace', text: '}', line: 3, column: 1 }
    ])
  })
})
