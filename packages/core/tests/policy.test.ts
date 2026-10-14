// termSkipSafe() and filterTermSkipSafe() (policy.ts): whether a policy's or filter's term can be left out while the
// rest is converted, the per-term rule's question (docs/ARCHITECTURE.md).
import { describe, expect, it } from 'vitest'
import { filterReliesOnImplicitAction, filterTermSkipSafe, termSkipSafe, type Filter, type FilterAction, type Policy, type PolicyTerm } from '../src'

/** A policy of `terms`, keyed 10, 20, 30… in order. */
const policy = (...terms: PolicyTerm[]): Policy => ({ fallThrough: 'reject', terms: Object.fromEntries(terms.map((t, i) => [String((i + 1) * 10), t])) })
const later = (matches: PolicyTerm['matches']): PolicyTerm => ({ matches, actions: { flow: 'accept' } })

describe('termSkipSafe', () => {
  it('is safe for the last term, whatever it does, and for a key the policy doesn\'t have', () => {
    expect(termSkipSafe(policy(later({ tags: [1] }), { actions: { flow: 'reject', tag: 7 } }), '20')).toBe(true)
    expect(termSkipSafe(policy({ actions: { flow: 'accept' } }), '10')).toBe(true)
    expect(termSkipSafe(policy(), '10')).toBe(true)
    expect(termSkipSafe(policy({ actions: { flow: 'accept' } }), 'toString')).toBe(true)
  })

  it('is unsafe for a term that decides routes before later terms: accept, reject, next policy', () => {
    for (const flow of ['accept', 'reject', 'next-policy'] as const) expect(termSkipSafe(policy({ actions: { flow } }, later({})), '10'), flow).toBe(false)
  })

  it('is safe for a term that decides nothing and changes nothing later terms match on', () => {
    expect(termSkipSafe(policy({}, later({ communitySets: ['C'] })), '10')).toBe(true)
    expect(termSkipSafe(policy({ matches: { tags: [1] } }, later({ tags: [1] })), '10')).toBe(true)
    expect(termSkipSafe(policy({ actions: { flow: 'next-term', localPreference: 200, med: 10, nextHop: '192.0.2.1', nextHopSelf: true } }, later({ communitySets: ['C'], asPathSets: ['A'], tags: [1] })), '10')).toBe(true)
    // Changing communities, the AS path or the tag is safe when no later term looks at it.
    expect(termSkipSafe(policy({ actions: { communityAdd: { values: ['65000:1'] }, asPathPrepend: [65000], tag: 7 } }, later({ prefixLists: { ipv4: ['L'] }, protocols: ['bgp'], family: 'ipv4' })), '10')).toBe(true)
  })

  it('is unsafe for a term that changes what a later term matches on', () => {
    for (const action of [{ communityAdd: { values: ['65000:1'] } }, { communitySet: { sets: ['C'] } }, { communityDelete: { sets: ['C'] } }] as const)
      expect(termSkipSafe(policy({ actions: action }, {}, later({ communitySets: ['C'] })), '10'), JSON.stringify(action)).toBe(false)
    expect(termSkipSafe(policy({ actions: { asPathPrepend: [65000] } }, later({ asPathSets: ['A'] })), '10')).toBe(false)
    expect(termSkipSafe(policy({ actions: { tag: 7 } }, later({ tags: [7] })), '10')).toBe(false)
  })

  it('counts what it doesn\'t know against the term: a later version\'s action, or a later term\'s match', () => {
    const unknownAction = { actions: { weight: 100 } } as unknown as PolicyTerm
    expect(termSkipSafe(policy(unknownAction, later({})), '10')).toBe(false)
    const unknownMatch = { matches: { routeType: 'external' }, actions: { flow: 'accept' } } as unknown as PolicyTerm
    expect(termSkipSafe(policy({ actions: { communityAdd: { values: ['65000:1'] } } }, unknownMatch), '10')).toBe(false)
    // A term that changes nothing is safe whatever later terms match on.
    expect(termSkipSafe(policy({ actions: { flow: 'next-term' } }, unknownMatch), '10')).toBe(true)
  })

  it('takes the terms in the order of their positions, not the order they were added in', () => {
    const terms: Record<string, PolicyTerm> = {}
    terms['20'] = later({ tags: [7] })
    terms['10'] = { actions: { tag: 7 } }
    expect(termSkipSafe({ fallThrough: 'reject', terms }, '10')).toBe(false)
    expect(termSkipSafe({ fallThrough: 'reject', terms }, '20')).toBe(true)
  })
})

describe('filterReliesOnImplicitAction', () => {
  it('is true unless a term matching every packet accepts, discards or rejects it', () => {
    expect(filterReliesOnImplicitAction({ implicitAction: 'deny' })).toBe(true)
    expect(filterReliesOnImplicitAction({ implicitAction: 'deny', terms: { '10': { matches: { protocols: [6] }, actions: { action: 'accept' } } } })).toBe(true)
    // Counting everything decides nothing; a term with an empty matches object matches everything.
    expect(filterReliesOnImplicitAction({ implicitAction: 'discard', terms: { '10': { actions: { action: 'next-term', count: 'all' } } } })).toBe(true)
    for (const action of ['accept', 'discard', 'reject'] as const) {
      expect(filterReliesOnImplicitAction({ implicitAction: 'discard', terms: { '10': { matches: { protocols: [6] }, actions: { action: 'accept' } }, '20': { actions: { action } } } }), action).toBe(false)
      expect(filterReliesOnImplicitAction({ implicitAction: 'discard', terms: { '20': { matches: {}, actions: { action } } } }), action).toBe(false)
    }
  })
})

describe('filterTermSkipSafe', () => {
  const filter = (...actions: FilterAction[]): Filter => ({ implicitAction: 'discard', terms: Object.fromEntries(actions.map((action, i) => [String(i + 1), { matches: { protocols: [6] }, actions: { action, count: `c${i}` } }])) })

  it('is safe for the last term, and for a key the filter doesn\'t have', () => {
    expect(filterTermSkipSafe(filter('accept', 'discard'), '2')).toBe(true)
    expect(filterTermSkipSafe(filter('accept'), 'toString')).toBe(true)
    expect(filterTermSkipSafe({ implicitAction: 'deny' }, '1')).toBe(true)
  })

  it('is safe only for a term that decides nothing (next-term: it counts or logs) before later terms', () => {
    expect(filterTermSkipSafe(filter('next-term', 'accept'), '1')).toBe(true)
    for (const action of ['accept', 'discard', 'reject'] as const) expect(filterTermSkipSafe(filter(action, 'accept'), '1'), action).toBe(false)
  })
})
