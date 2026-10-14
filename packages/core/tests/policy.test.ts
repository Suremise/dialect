// termSkipSafe() (policy.ts): whether a policy term can be left out while the rest of its policy is converted, the
// per-term rule's question (docs/ARCHITECTURE.md).
import { describe, expect, it } from 'vitest'
import { termSkipSafe, type Policy, type PolicyTerm } from '../src'

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
    expect(termSkipSafe({ terms }, '10')).toBe(false)
    expect(termSkipSafe({ terms }, '20')).toBe(true)
  })
})
