// Routing policy (model 0.5.0) beyond its fixture: NX-OS's `seq` on community and AS-path lists, `eq` on prefix lists,
// regexes in double quotes, what is left out whole and why (the per-term rule), `no` forms, names as own keys, and
// rendering policies NX-OS can't write.
import { describe, expect, it } from 'vitest'
import { checkFixture } from '@dialect/conformance'
import { buildLedger, MODEL_VERSION, type Device, type ParseResult } from '@dialect/core'
import plugin from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
const lines = (...l: string[]) => l.join('\n')
/** Each statement's disposition, by its line number. */
const at = (result: ParseResult, n: number) => result.dispositions[`L${n}`]
/** The kit's checks on `text` against its own parse: no error, a complete ledger, a stable round trip. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

describe('routing policy (model 0.5.0)', () => {
  it('numbers community and AS-path list entries by seq, or 1 after the highest, and takes one out by seq', () => {
    const text = lines('ip community-list standard C permit 1:1', 'ip community-list standard C seq 10 permit 10:10', 'ip community-list standard C seq 5 permit 5:5', 'ip community-list standard C permit 11:11', 'ip as-path access-list P permit "_1_"', 'ip as-path access-list P seq 20 deny ".*"', 'no ip as-path access-list P seq 1')
    const result = parse(text)
    expect(Object.keys(result.model.routingPolicy?.communitySets?.C?.entries ?? {})).toEqual(['1', '5', '10', '11'])
    expect(result.model.routingPolicy?.asPathSets?.P).toEqual({ regexDialect: 'cisco', entries: { '20': { action: 'deny', regex: '.*' } } })
    expect(at(result, 5)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 7' })
    expect(roundTrips(text)).toEqual([])
  })

  it('takes eq as one length, and leaves out a list with mask or a length NX-OS refuses', () => {
    const text = lines('ip prefix-list L seq 5 permit 10.0.0.0/8 eq 16', 'ip prefix-list M seq 5 permit 10.0.0.0/16 mask 0.0.255.0', 'ip prefix-list N seq 5 permit 10.0.0.0/16 ge 8')
    const result = parse(text)
    expect(result.model.routingPolicy?.prefixLists?.ipv4).toEqual({ L: { entries: { '5': { action: 'permit', prefix: '10.0.0.0/8', minLength: 16, maxLength: 16 } } } })
    expect(render(result.model).text).toContain('ip prefix-list L seq 5 permit 10.0.0.0/8 eq 16\n')
    expect(at(result, 3)).toEqual({ kind: 'unsupported', reason: 'not a prefix length range NX-OS takes (the prefix\'s length < ge ≤ le ≤ the longest; mask isn\'t converted)' })
    expect(roundTrips(text)).toEqual([])
  })

  it('keeps a regex as written inside its quotes, spaces too, and never one with a quote of its own', () => {
    const text = lines('ip as-path access-list P permit " 65000 "', 'ip community-list expanded C permit "65000:1 "', 'ip community-list expanded D permit _65000:2_')
    const result = parse(text)
    expect(result.model.routingPolicy?.asPathSets?.P?.entries?.['1']?.regex).toBe(' 65000 ')
    expect(result.model.routingPolicy?.communitySets?.D?.entries?.['1']?.regexes).toEqual(['_65000:2_'])
    expect(render(result.model).text).toContain('ip community-list expanded D seq 1 permit "_65000:2_"\n')
    expect(roundTrips(text)).toEqual([])
    const quoted = parse('ip as-path access-list Q permit a"b')
    expect(quoted.model.routingPolicy).toBeUndefined()
    expect(at(quoted, 1)).toEqual({ kind: 'unsupported', reason: 'a regex with a double quote in it: NX-OS writes regexes in double quotes' })
  })

  it('leaves a sequence out whole, and the route map with it unless it is the last', () => {
    const unsafe = parse(lines('route-map M permit 10', '  match ip address ACL', '  set tag 1', 'route-map M permit 20'))
    expect(unsafe.model.routingPolicy).toBeUndefined()
    expect(at(unsafe, 3)).toEqual({ kind: 'unsupported', reason: 'part of the route map sequence of line 1, converted whole or not at all: line 2 isn\'t converted' })
    expect(at(unsafe, 4)).toEqual({ kind: 'unsupported', reason: 'left out whole: the sequence of line 1 isn\'t converted, and the sequences after it would see the routes it decides' })
    expect(buildLedger(unsafe).complete).toBe(true)
    const text = lines('route-map M deny 10', '  match tag 7', 'route-map M permit 20', '  continue 30')
    expect(parse(text).model.routingPolicy?.policies).toEqual({ M: { terms: { '10': { matches: { tags: [7] }, actions: { flow: 'reject' } } }, fallThrough: 'reject' } })
    expect(roundTrips(text)).toEqual([])
  })

  it('takes a route map statement with no sequence number as sequence 10, and one with no action as permit, as NX-OS does', () => {
    const policies = (text: string) => parse(text).model.routingPolicy?.policies
    // Sequence 10 missing: made, beside one other sequence or several.
    const one = lines('route-map M deny 20', '  match tag 1', 'route-map M permit', '  set tag 2')
    expect(policies(one)).toEqual({ M: { terms: { '10': { actions: { flow: 'accept', tag: 2 } }, '20': { matches: { tags: [1] }, actions: { flow: 'reject' } } }, fallThrough: 'reject' } })
    expect(roundTrips(one)).toEqual([])
    expect(Object.keys(policies(lines('route-map M permit 20', 'route-map M permit 30', 'route-map M permit'))?.M?.terms ?? {})).toEqual(['10', '20', '30'])
    // Sequence 10 there: edited, beside other sequences too.
    expect(policies(lines('route-map M permit 10', '  match tag 1', 'route-map M deny 20', 'route-map M permit', '  set tag 3'))?.M?.terms?.['10']).toEqual({ matches: { tags: [1] }, actions: { flow: 'accept', tag: 3 } })
    // No action on a sequence that denied: it permits now.
    const denied = lines('route-map M deny 10', '  match tag 1', 'route-map M 10', '  set metric 20')
    expect(policies(denied)?.M?.terms?.['10']).toEqual({ matches: { tags: [1] }, actions: { flow: 'accept', med: 20 } })
    expect(render(parse(denied).model).text).toContain('route-map M permit 10\n')
    expect(roundTrips(denied)).toEqual([])
  })

  it('keeps any name as an own key, and leaves Object.prototype alone', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const text = lines('ip prefix-list __proto__ seq 5 permit 10.0.0.0/8', 'ip as-path access-list constructor permit "_1_"', 'route-map toString permit 10', '  match ip address prefix-list __proto__', '  match as-path constructor')
    const rp = parse(text).model.routingPolicy!
    expect(Object.hasOwn(rp.prefixLists!.ipv4!, '__proto__')).toBe(true)
    expect(Object.hasOwn(rp.asPathSets!, 'constructor')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(rp.policies, 'toString')?.value?.terms?.['10']?.matches).toEqual({ prefixLists: { ipv4: ['__proto__'] }, asPathSets: ['constructor'] })
    expect(roundTrips(text)).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
  })

  it('never writes another dialect\'s regex, a regex with a quote, an empty list, or a name NX-OS can\'t take', () => {
    const result = render({
      routingPolicy: {
        asPathSets: { J: { regexDialect: 'junos', entries: { '1': { action: 'permit', regex: '65000 .*' } } }, Q: { regexDialect: 'cisco', entries: { '1': { action: 'permit', regex: 'a"b' } } } },
        communitySets: { 'TWO WORDS': { entries: { '1': { action: 'permit', members: ['65000:1'] } } }, GSHUT: { entries: { '1': { action: 'permit', members: ['graceful-shutdown'] } } } },
        prefixLists: { ipv4: { EMPTY: { entries: {} } } }
      }
    })
    expect(result.text).toBe('\n')
    for (const [path, d] of Object.entries(result.dispositions)) expect(d, path).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['routingPolicy.asPathSets.J.entries["1"].regex']).toEqual({ kind: 'unsupported', reason: 'a Junos regex: regexes are never translated silently, and NX-OS\'s are another dialect' })
  })
})
