// IOS-XR access lists beyond their fixtures (#88): sequence numbers as IOS-XR gives them, the one-line form, edits and
// removals, the port operators, and what an interface applies.
import { describe, expect, it } from 'vitest'
import { checkFixture } from '@dialect/conformance'
import { MODEL_VERSION } from '@dialect/core'
import plugin, { parse as parseText, render as renderModel } from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => parseText(text, context)
const lines = (...l: string[]) => l.join('\n')
const terms = (text: string, name = 'F') => parse(text).model.filters?.ipv4?.[name]?.terms

describe('sequence numbers', () => {
  it('numbers an entry without one 10 after the highest, a remark\'s included, and orders entries by number', () => {
    const t = terms(lines('ipv4 access-list F', ' 10 remark first', ' permit tcp any any eq 22', ' 5 permit udp any any eq 53', ' deny ipv4 any any'))
    expect(Object.keys(t ?? {})).toEqual(['5', '20', '30'])
    expect(t?.['20'].matches?.destinationPorts).toEqual(['22'])
  })

  it('takes the one-line form, with or without a number, and blocks that add to the same list', () => {
    const t = terms(lines('ipv4 access-list F', ' 10 permit tcp any any eq 22', '!', 'ipv4 access-list F permit tcp any any eq 23', 'ipv4 access-list F 15 permit tcp any any eq 24', 'ipv4 access-list F', ' 40 deny ipv4 any any'))
    expect(Object.entries(t ?? {}).map(([k, v]) => [k, v.matches?.destinationPorts?.[0] ?? null])).toEqual([['10', '22'], ['15', '24'], ['20', '23'], ['40', null]])
  })

  it('replaces an entry with a later one of its number, and removes one with no N', () => {
    const r = parse(lines('ipv4 access-list F', ' 10 permit tcp any any eq 22', ' 10 permit tcp any any eq 23', ' 20 deny ipv4 any any', ' no 20'))
    expect(Object.keys(r.model.filters?.ipv4?.F.terms ?? {})).toEqual(['10'])
    expect(r.model.filters?.ipv4?.F.terms?.['10'].matches?.destinationPorts).toEqual(['23'])
    expect(r.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 3' })
    expect(r.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5' })
  })
})

describe('ports, addresses and options', () => {
  it('reads eq, gt, lt and range, by number or name, as port ranges, and leaves neq out', () => {
    const port = (op: string) => terms(entryText(`permit tcp any any ${op}`))?.['10']?.matches?.destinationPorts
    expect([port('eq www'), port('gt 1023'), port('lt 1024'), port('range 8080 8090'), port('range 22 22'), port('gt 65534')]).toEqual([['80'], ['1024-65535'], ['0-1023'], ['8080-8090'], ['22'], ['65535']])
    // The only entry, and a permit: leaving it out would deny everything, so the list goes with it (#103).
    expect(parse(entryText('permit tcp any any neq 23')).dispositions.L2).toEqual({ kind: 'unsupported', reason: 'left out whole: the entry on line 2 isn\'t converted (neq: two ranges the simple form doesn\'t write), and leaving it out would change what the entries after it see' })
  })

  it('writes every port range back in a form IOS-XR takes and reads as the same, at the bounds, both ways and families', () => {
    // As the parse reads each, then a later deciding entry, so an entry that didn't read back would leave the list out.
    const forms: [said: string, range: string][] = [
      ['range 0 65535', '0-65535'],
      ['eq 0', '0'],
      ['eq 65535', '65535'],
      ['lt 1', '0'],
      ['lt 2', '0-1'],
      ['gt 65534', '65535'],
      ['gt 65533', '65534-65535'],
      ['range 1 65534', '1-65534'],
      ['gt 0', '1-65535'],
      ['lt 65535', '0-65534']
    ]
    for (const family of ['ipv4', 'ipv6'] as const)
      for (const side of ['source', 'destination'] as const)
        for (const [said, range] of forms) {
          const entry = side === 'source' ? `permit tcp any ${said} any` : `permit tcp any any ${said}`
          const text = lines(`${family} access-list F`, ` 10 ${entry}`, ` 20 deny ${family} any any`)
          const what = `${family} ${side} ${said}`
          const parsed = parse(text)
          const t = parsed.model.filters?.[family]?.F.terms?.['10']
          expect(t?.matches?.[side === 'source' ? 'sourcePorts' : 'destinationPorts'], what).toEqual([range])
          // Rendered, then read back: the same model, and through the kit's checks.
          const fixture = { name: what, source: text, expectedModel: parsed.model }
          expect(checkFixture(plugin, fixture).filter((r) => r.status === 'failed').flatMap((r) => r.problems), what).toEqual([])
        }
  })

  it('takes a contiguous wildcard as a prefix, and never approximates a non-contiguous one', () => {
    expect(terms(entryText('deny ipv4 10.0.0.0 0.255.255.255 any'))?.['10'].matches?.sourcePrefixes).toEqual(['10.0.0.0/8'])
    expect(parse(entryText('deny ipv4 10.0.0.0 0.255.0.255 any')).model.filters?.ipv4?.F.terms).toBeUndefined()
  })

  it('reads ICMP types by name (with their code) or number, and the options it knows', () => {
    const t = terms(lines('ipv4 access-list F', ' 10 permit icmp any any port-unreachable', ' 20 permit icmp any any 8 0 log', ' 30 permit tcp any any established dscp ef counter C', ' 40 permit ipv4 any any fragments'))
    expect(t?.['10'].matches).toEqual({ protocols: [1], icmpTypes: [3], icmpCodes: [3] })
    expect(t?.['20']).toEqual({ matches: { protocols: [1], icmpTypes: [8], icmpCodes: [0] }, actions: { action: 'accept', log: true } })
    expect(t?.['30']).toEqual({ matches: { protocols: [6], tcpEstablished: true, dscp: [46] }, actions: { action: 'accept', count: 'C' } })
    expect(t?.['40'].matches).toEqual({ fragment: 'non-initial' })
  })
})

describe('what an interface applies', () => {
  it('applies a converted list by family and direction, on the main interface or a subinterface; no access-group removes it', () => {
    const base = lines('ipv4 access-list F', ' 10 permit ipv4 any any', '!', 'ipv6 access-list F6', ' 10 permit ipv6 any any', '!', 'interface GigabitEthernet0/0/0/0', ' ipv4 access-group F ingress', ' ipv6 access-group F6 egress', '!', 'interface GigabitEthernet0/0/0/0.10', ' ipv4 access-group F egress')
    const r = parse(base)
    expect(r.model.interfaces?.['GigabitEthernet0/0/0/0'].subinterfaces).toEqual({ '0': { filters: { ipv4: { input: 'F' }, ipv6: { output: 'F6' } } }, '10': { filters: { ipv4: { output: 'F' } } } })
    const removed = parse(lines(base, '!', 'interface GigabitEthernet0/0/0/0', ' no ipv4 access-group F ingress'))
    expect(removed.model.interfaces?.['GigabitEthernet0/0/0/0'].subinterfaces?.['0'].filters).toEqual({ ipv6: { output: 'F6' } })
    expect(removed.dispositions.L8).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 15' })
  })

  it('leaves out an access group naming a list of another family, one removed, or one not converted', () => {
    const r = parse(lines('ipv4 access-list F', ' 10 permit ipv4 any any', '!', 'ipv4 access-list G', ' 10 permit ipv4 any any', '!', 'no ipv4 access-list G', 'interface GigabitEthernet0/0/0/0', ' ipv6 access-group F ingress', ' ipv4 access-group G egress'))
    expect(r.model.interfaces?.['GigabitEthernet0/0/0/0'].subinterfaces).toBeUndefined()
    for (const id of ['L9', 'L10']) expect(r.dispositions[id]).toEqual({ kind: 'unsupported', reason: 'applies an access list the configuration doesn\'t define, or one that isn\'t converted' })
  })
})

describe('the render', () => {
  it('denies what no entry decides: a warning where the source discards, or where the list relies on it', () => {
    const filter = { implicitAction: 'deny' as const, terms: { '10': { matches: { protocols: [6] }, actions: { action: 'accept' as const } } } }
    const codes = (implicitAction: 'deny' | 'discard', catchAll: boolean) =>
      renderModel({ filters: { ipv4: { F: { ...filter, implicitAction, terms: { ...filter.terms, ...(catchAll ? { '20': { actions: { action: 'discard' as const } } } : {}) } } } } }, context).diagnostics.map((d) => d.code)
    expect([codes('deny', true), codes('deny', false), codes('discard', true)]).toEqual([[], ['iosxr.filter-implicit-action'], ['iosxr.filter-implicit-action']])
  })
})

// #103: an entry left out sends what it decided to the list's end, IOS-XR's implicit deny, so it can go alone only when
// it is the last and denies; otherwise the whole list is left out, and so is every access-group applying it.
describe('a last entry left out, and the interfaces applying the list', () => {
  const source = (last: string) => lines('ipv4 access-list F', ' 10 permit tcp any any eq 22', ` 20 ${last}`, '!', 'interface GigabitEthernet0/0/0/0', ' ipv4 access-group F ingress')
  const attached = (text: string) => parse(text).model.interfaces?.['GigabitEthernet0/0/0/0']?.subinterfaces?.['0']?.filters

  it('a deny goes alone: the list keeps its other entries and is still applied', () => {
    const r = parse(source('deny tcp any any neq 23'))
    expect(Object.keys(r.model.filters?.ipv4?.F.terms ?? {})).toEqual(['10'])
    expect(r.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'neq: two ranges the simple form doesn\'t write' })
    expect(attached(source('deny tcp any any neq 23'))).toEqual({ ipv4: { input: 'F' } })
  })

  it('a permit takes the whole list and the access-group with it', () => {
    const r = parse(source('permit tcp any any neq 23'))
    expect(r.model.filters).toBeUndefined()
    expect(r.dispositions.L6.kind).toBe('unsupported')
    expect(attached(source('permit tcp any any neq 23'))).toBeUndefined()
  })

  it('renders likewise: a last discard IOS-XR can\'t write goes alone; a last reject takes the list and its access-group', () => {
    const model = (action: 'discard' | 'reject') => ({
      interfaces: { 'GigabitEthernet0/0/0/0': { subinterfaces: { '0': { filters: { ipv4: { input: 'F' } } } } } },
      filters: { ipv4: { F: { implicitAction: 'discard' as const, terms: { '1': { matches: { protocols: [6], destinationPorts: ['22'] }, actions: { action: 'accept' as const } }, '2': { matches: { protocols: [6], tcpFlags: { set: ['syn' as const] } }, actions: { action } } } } } }
    })
    const kept = renderModel(model('discard'), context)
    expect(kept.text).toContain('ipv4 access-list F\n 1 permit tcp any any eq 22\n!')
    expect(kept.text).toContain(' ipv4 access-group F ingress')
    const left = renderModel(model('reject'), context)
    expect(left.text).not.toContain('access-list')
    expect(left.text).not.toContain('access-group')
    expect(left.dispositions['interfaces["GigabitEthernet0/0/0/0"].subinterfaces["0"].filters.ipv4.input'].kind).toBe('unsupported')
  })

  it('warns that the list relies on its end when the catch-all it ended with is the entry left out', () => {
    const codes = (entries: Record<string, { matches?: { protocols: number[] }; actions: { action: 'accept' | 'discard'; count?: string } }>) =>
      renderModel({ interfaces: { 'GigabitEthernet0/0/0/0': { subinterfaces: { '0': { filters: { ipv4: { input: 'F' } } } } } }, filters: { ipv4: { F: { implicitAction: 'deny', terms: entries } } } }, context).diagnostics.map((d) => d.code)
    // A counter name IOS-XR can't take: the entry is left out (a last discard, safely), and the end decides instead.
    const unwritable = { actions: { action: 'discard' as const, count: 'c'.repeat(65) } }
    expect(codes({ '1': unwritable })).toEqual(['iosxr.filter-implicit-action'])
    expect(codes({ '1': { matches: { protocols: [6] }, actions: { action: 'accept' } }, '2': unwritable })).toEqual(['iosxr.filter-implicit-action'])
    // Written, the catch-all decides every packet the entries before it don't: nothing to warn about.
    expect(codes({ '1': { matches: { protocols: [6] }, actions: { action: 'accept' } }, '2': { actions: { action: 'discard' } } })).toEqual([])
  })
})

/** An access list F with one entry, numbered 10, on line 2. */
function entryText(e: string): string {
  return lines('ipv4 access-list F', ` 10 ${e}`)
}
