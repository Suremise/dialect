// Firewall filters beyond the conformance fixtures (tests/fixtures/conformance/filters): the per-term ledger of each
// negative fixture (tests/fixtures/conformance/filters-unsupported), line by line; names Junos gives ports, ICMP types,
// protocols and code points; groups in firewall; and a model from another platform (a Cisco ACL) rendered in Junos
// terms, where what Junos can't say is left out whole and says why. Messages never quote a name or a value.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildLedger, ledgerProblems, modelProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { parse, render } from '../src'
import { PORT_NUMBERS, port } from '../src/filters'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
const unsupportedLines = (p: ParseResult): number[] =>
  Object.entries(p.dispositions)
    .filter(([, d]) => d.kind === 'unsupported')
    .map(([id]) => Number(id.slice(1)))
    .sort((a, b) => a - b)
const fixture = (name: string) => readFileSync(new URL(`./fixtures/conformance/filters-unsupported/${name}.set`, import.meta.url), 'utf8')
const told = (r: RenderResult): string[] => [...Object.values(r.dispositions).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])), ...r.diagnostics.map((d) => d.message)]
/** Each IPv4 filter the parse has, with its terms' names. */
const terms = (p: ParseResult) => Object.fromEntries(Object.entries(p.model.filters?.ipv4 ?? {}).map(([name, f]) => [name, Object.values(f.terms ?? {}).map((t) => t.name)]))

describe('the per-term ledger of each negative fixture', () => {
  // Per fixture: the lines left unsupported, and the IPv4 filters the model still has with their terms.
  const cases: readonly [name: string, lines: number[], filters: Record<string, (string | undefined)[]>, why: string][] = [
    ['policer', [1, 2, 3, 4], {}, 'a term with a policer, which may discard, is left out, so the whole filter is'],
    ['routing-instance', [1, 2, 3], {}, 'a term that forwards in another routing instance decides packets: the whole filter is left out'],
    // #103: an only term that accepts (or whose action isn't converted) can't be left out alone, as the filter would
    // then discard everything by its end: the whole filter is left out.
    ['next-ip', [1], {}, 'next-ip in the only term: the whole filter is left out'],
    ['reject-type', [1], {}, 'a reject with a particular ICMP message: the whole filter is left out'],
    ['address-except', [1, 2, 3], {}, 'an address excepted from the match: the whole filter is left out'],
    ['match-except', [1, 2], {}, 'an -except match: the whole filter is left out'],
    ['address-mask', [1, 2], {}, 'a mask that isn’t a prefix length, never approximated: the whole filter is left out'],
    ['address-and-prefix-list', [2, 3, 4], {}, 'an address and a prefix list of one direction, which Junos takes as one list: the whole filter is left out'],
    ['unknown-prefix-list', [1, 2], {}, 'a prefix list nothing defines: the whole filter is left out'],
    ['nested-filter', [2, 3], { CHILD: ['T'] }, 'a term that runs another filter decides packets: the whole filter is left out, the one it runs converts'],
    ['next-term-skip', [1, 2, 3], { F: ['REST'] }, 'a term that only counts and goes on (next term) is left out alone'],
    ['no-then-unsafe', [1, 2], {}, 'a term with no then accepts, so leaving it out isn’t safe: the whole filter is left out'],
    ['ethernet-switching', [1], {}, 'filters of other families'],
    ['input-list', [4, 5], { A: ['T'], B: ['T'] }, 'an input-list replaces the input before it, and isn’t converted: the unit applies nothing in'],
    ['filter-group', [2], { F: ['T'] }, 'filter groups'],
    ['group-term-order', [1, 3], {}, 'terms only a group gives beside the filter’s own'],
    ['insert', [1, 2, 3], {}, 'insert reorders the terms']
  ]
  for (const [name, lines, filters, why] of cases) {
    it(`${name}: ${why}`, () => {
      const p = parse(fixture(name), context)
      expect(unsupportedLines(p)).toEqual(lines)
      expect(terms(p)).toEqual(filters)
      expect(modelProblems(p.model)).toEqual([])
    })
  }

  it('input-list: the unit applies no filter that way, as the list it has isn’t converted', () => {
    expect(parse(fixture('input-list'), context).model.interfaces).toBeUndefined()
  })

  // #103: a last term left out sends what it decided to the filter's end (Junos discards), so it can go alone only
  // when it discards too; otherwise the whole filter and the units applying it are left out.
  describe('a last term left out, and the unit applying the filter', () => {
    const source = (then: string) => set(
      'set firewall family inet filter F term SSH from protocol tcp',
      'set firewall family inet filter F term SSH from destination-port 22',
      'set firewall family inet filter F term SSH then accept',
      'set firewall family inet filter F term LAST from source-address 10.1.0.0/16 except',
      `set firewall family inet filter F term LAST then ${then}`,
      'set interfaces ge-0/0/0 unit 0 family inet filter input F'
    )
    it('a discard goes alone: the filter keeps its other terms and is still applied', () => {
      const p = parse(source('discard'), context)
      expect(terms(p)).toEqual({ F: ['SSH'] })
      expect(unsupportedLines(p)).toEqual([4, 5])
      expect(p.model.interfaces?.['ge-0/0/0'].subinterfaces?.['0'].filters).toEqual({ ipv4: { input: 'F' } })
    })
    it.each(['accept', 'reject', 'next-ip 192.0.2.1/32'])('a last %s takes the whole filter and its attachment with it', (then) => {
      const p = parse(source(then), context)
      expect(terms(p)).toEqual({})
      expect(unsupportedLines(p)).toEqual([1, 2, 3, 4, 5, 6])
      expect(p.model.interfaces).toBeUndefined()
      expect(modelProblems(p.model)).toEqual([])
    })
    it('a next term goes alone, wherever it is: it decides nothing', () => {
      expect(terms(parse(source('next term'), context))).toEqual({ F: ['SSH'] })
    })
  })
})

describe('names Junos gives values', () => {
  const term = (...from: string[]) => parse(set(...from.map((f) => `set firewall family inet filter F term T from ${f}`), 'set firewall family inet filter F term T then accept'), context).model.filters?.ipv4?.F.terms?.['1'].matches
  it('reads ports, protocols, ICMP types and code points by name or number, and ranges as the model has them', () => {
    expect(term('protocol udp', 'source-port [ bgp 0100 1000-2000 ]', 'destination-port domain')).toEqual({ protocols: [17], sourcePorts: ['179', '100', '1000-2000'], destinationPorts: ['53'] })
    expect(term('protocol 89')).toEqual({ protocols: [89] })
    expect(term('icmp-type [ echo-request 13-14 ]', 'icmp-code 0-1')).toEqual({ icmpTypes: [8, 13, 14], icmpCodes: [0, 1] })
    expect(term('dscp [ ef af11 cs6 ]')).toEqual({ dscp: [46, 10, 48] })
  })
  // Every port name Junos has that the parser declares, hyphenated ones too (ftp-data, netbios-ns…): a whole name is one
  // port, never split as a range.
  describe.each(Object.entries(PORT_NUMBERS))('port name %s', (name, number) => {
    it.each([
      ['source-port', 'sourcePorts'],
      ['destination-port', 'destinationPorts'],
      ['port', 'ports']
    ] as const)('%s, in inet and inet6 filters, is port %i, and an attached filter keeps its allow term through render', (word, field) => {
      for (const family of ['inet', 'inet6'] as const) {
        const model = family === 'inet' ? 'ipv4' : 'ipv6'
        const source = set(
          `set firewall family ${family} filter F term T from ${word} ${name}`,
          `set firewall family ${family} filter F term T then accept`,
          `set interfaces ge-0/0/0 unit 0 family ${family} filter input F`
        )
        const p = parse(source, context)
        expect(unsupportedLines(p), `${family} ${word}`).toEqual([])
        expect(p.model.filters?.[model]?.F.terms?.['1'], `${family} ${word}`).toEqual({ name: 'T', matches: { [field]: [String(number)] }, actions: { action: 'accept' } })
        const back = parse(render(p.model, context).text, context)
        expect(back.model.filters, `${family} ${word}`).toEqual(p.model.filters)
        expect(back.model.interfaces?.['ge-0/0/0'].subinterfaces?.['0'].filters?.[model]?.input, `${family} ${word}`).toBe('F')
      }
    })
  })

  it('reads a range of names or numbers split at the one hyphen whose sides are ports, and leaves an unclear one out', () => {
    expect(port('ftp-data-ssh')).toBe('20-22')
    expect(port('1024-netbios-ssn')).toBeNull()
    expect(port('netbios-ns-netbios-ssn')).toBe('137-139')
    expect(port('ssh-ftp-data')).toBeNull()
    expect(port('1000-2000')).toBe('1000-2000')
    expect(port('kerberos-sec')).toBe('88')
  })

  it('reads inet6 filters by next-header and traffic-class, and ICMPv6 names', () => {
    const p = parse(set('set firewall family inet6 filter F term T from next-header icmpv6', 'set firewall family inet6 filter F term T from icmp-type neighbor-solicit', 'set firewall family inet6 filter F term T from traffic-class af41'), context)
    expect(p.model.filters?.ipv6?.F.terms?.['1']).toEqual({ name: 'T', matches: { protocols: [58], icmpTypes: [135], dscp: [34] }, actions: { action: 'accept' } })
  })
  it('leaves out what it can’t read, never a part of it', () => {
    for (const from of ['protocol 1-5', 'source-port 2000-1000', 'destination-port no-such-port', 'icmp-code unreachable-host', 'dscp 64', 'tcp-flags "syn | ack"', 'tcp-flags "(syn & ack)"']) {
      const p = parse(set(`set firewall family inet filter F term T from ${from}`, 'set firewall family inet filter F term T then accept'), context)
      expect(unsupportedLines(p), from).toEqual([1, 2])
    }
  })
})

describe('groups in firewall (R1–R12 apply as everywhere)', () => {
  it("takes a group's statements under firewall, the configuration's own single setting winning", () => {
    const p = parse(set('set groups G firewall family inet filter F term T then discard', 'set groups G firewall family inet filter F term T then count C', 'set firewall apply-groups G', 'set firewall family inet filter F term T then accept'), context)
    expect(p.model.filters?.ipv4?.F.terms?.['1']).toEqual({ name: 'T', actions: { action: 'accept', count: 'C' } })
    expect(p.dispositions.L1).toMatchObject({ kind: 'ignored-by-design', reason: 'superseded by line 4' })
  })
  it('a group adding to a term the configuration has keeps the configuration’s order', () => {
    const p = parse(set('set groups G firewall family inet filter F term SECOND then count C', 'set firewall apply-groups G', 'set firewall family inet filter F term FIRST then accept', 'set firewall family inet filter F term SECOND then discard'), context)
    expect(terms(p)).toEqual({ F: ['FIRST', 'SECOND'] })
  })
})

describe('render from another platform’s model', () => {
  /** An extended ACL as an IOS-XE parse gives it: entries by sequence number, no names, the implicit deny. */
  const acl: Device = {
    filters: {
      ipv4: {
        EDGE: {
          implicitAction: 'deny',
          terms: {
            '10': { matches: { protocols: [6], destinationPrefixes: ['192.0.2.10/32'], destinationPorts: ['443'] }, actions: { action: 'accept' } },
            '20': { matches: { protocols: [17], sourcePorts: ['53'] }, actions: { action: 'accept', log: true } },
            '30': { matches: { sourcePrefixes: ['10.0.0.0/8'] }, actions: { action: 'discard' } }
          }
        }
      }
    },
    interfaces: { GigabitEthernet1: { subinterfaces: { '0': { filters: { ipv4: { input: 'EDGE', output: 'MISSING' } } } } } }
  }

  it('writes entries under their sequence numbers, applies the filter on the unit, and warns that the end differs', () => {
    const r = render(acl, context)
    expect(r.text).toContain(['        filter EDGE {', '            term 10 {', '                from {', '                    destination-address 192.0.2.10;', '                    protocol tcp;', '                    destination-port 443;', '                }', '                then {', '                    accept;', '                }', '            }'].join('\n'))
    expect(r.text).toContain('family inet {\n                filter {\n                    input EDGE;\n                }\n            }')
    expect(r.dispositions['interfaces.GigabitEthernet1.subinterfaces["0"].filters.ipv4.output']).toMatchObject({ kind: 'unsupported' })
    const warnings = r.diagnostics.filter((d) => d.code === 'junos.filter-implicit-action')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ severity: 'warning', category: 'semantic', field: 'filters.ipv4.EDGE.implicitAction' })
    expect(ledgerProblems(buildLedger(parse('', context), r, acl))).toEqual([])
  })

  it('leaves out a term Junos can’t say, and the whole filter when that isn’t safe, and the unit applying it', () => {
    const model: Device = {
      filters: {
        ipv4: {
          ECE: { implicitAction: 'deny', terms: { '10': { matches: { tcpFlags: { set: ['ece'] } }, actions: { action: 'discard' } }, '20': { actions: { action: 'accept' } } } },
          LAST: { implicitAction: 'discard', terms: { '10': { actions: { action: 'accept' } }, '20': { matches: { sourcePrefixLists: ['NOT-WRITTEN'] }, actions: { action: 'discard' } } } }
        }
      },
      interfaces: { ge1: { subinterfaces: { '0': { filters: { ipv4: { input: 'ECE' } } } } } }
    }
    const r = render(model, context)
    expect(r.text).not.toContain('filter ECE')
    expect(r.dispositions['filters.ipv4.ECE.terms["20"].actions.action']).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('per-term rule') })
    expect(r.dispositions['interfaces.ge1.subinterfaces["0"].filters.ipv4.input']).toMatchObject({ kind: 'unsupported' })
    // The last term can always be left out.
    expect(r.text).toContain('filter LAST')
    expect(r.dispositions['filters.ipv4.LAST.terms["20"].actions.action']).toMatchObject({ kind: 'unsupported' })
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })

  it('names no filter, counter or prefix list in a message', () => {
    const secret = 'SECRET-NAME'
    const model: Device = { filters: { ipv4: { [secret]: { implicitAction: 'deny', terms: { '10': { matches: { sourcePrefixLists: [secret] }, actions: { action: 'accept', count: secret } }, '20': { actions: { action: 'discard' } } } } } } }
    expect(told(render(model, context)).filter((m) => m.includes(secret))).toEqual([])
  })
})
