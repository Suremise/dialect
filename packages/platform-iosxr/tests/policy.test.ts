// IOS-XR routing policy beyond its fixtures (#79): the order of a block's community actions, community sets with a
// regex never set or added, regexes kept byte for byte, and RFC 8212's needs-input where a policy can't be written.
import { describe, expect, it } from 'vitest'
import { MODEL_VERSION, type Device, type Policy } from '@dialect/core'
import { parse as parseText, render as renderModel } from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => parseText(text, context)
const render = (model: Device, inputs?: Record<string, string>) => renderModel(model, { ...context, ...(inputs ? { inputs } : {}) })
const lines = (...l: string[]) => l.join('\n')
const SETS = lines('community-set LITERAL', '  65000:1', 'end-set', '!', 'community-set REGEX', '  ios-regex \'_65000:.*_\'', 'end-set', '!')
const policy = (...body: string[]) => lines(SETS, 'route-policy P', ...body.map((b) => `  ${b}`), 'end-policy')

describe('a block\'s community actions keep their order (RPL runs them in turn)', () => {
  it('converts them deleted, then replaced, then added, and writes them in that order', () => {
    const result = parse(policy('delete community in REGEX', 'set community LITERAL additive', 'done'))
    expect(result.model.routingPolicy?.policies?.P.terms?.['1'].actions).toEqual({ communityDelete: { sets: ['REGEX'] }, communityAdd: { sets: ['LITERAL'] }, flow: 'accept' })
    const text = render(result.model).text
    expect(text.indexOf('delete community in REGEX')).toBeLessThan(text.indexOf('set community LITERAL additive'))
    expect(parse(text).model).toEqual(result.model)
  })

  it('leaves a policy out whole when its block adds or replaces before it deletes', () => {
    for (const [first, then] of [
      ['set community LITERAL additive', 'delete community in LITERAL'],
      ['set community LITERAL', 'delete community in LITERAL']
    ]) {
      const result = parse(policy(first, then, 'done'))
      expect(result.model.routingPolicy?.policies).toBeUndefined()
      expect(result.dispositions.L9).toEqual({ kind: 'unsupported', reason: 'a route policy, 5 lines, left out whole: community actions in an order the model can\'t keep (it deletes, then replaces, then adds)' })
    }
  })
})

describe('a community set with a regex matches and deletes, but is never set or added', () => {
  it('leaves out a source policy that sets or adds one, and keeps one that matches or deletes it', () => {
    for (const setter of ['set community REGEX', 'set community REGEX additive']) {
      const result = parse(policy(setter, 'done'))
      expect(result.model.routingPolicy?.policies, setter).toBeUndefined()
      expect(result.dispositions.L9, setter).toEqual({ kind: 'unsupported', reason: 'a route policy, 4 lines, left out whole: it sets or adds a community set with a regex, which IOS-XR refuses' })
    }
    const fine = parse(policy('if community matches-any REGEX then', '  delete community in REGEX', '  set community LITERAL additive', '  done', 'endif'))
    expect(fine.model.routingPolicy?.policies?.P).toBeDefined()
  })

  it('leaves out on render a term that sets or adds one, and its policy where that isn\'t safe', () => {
    const sets = parse(SETS).model.routingPolicy!
    const model = (p: Policy): Device => ({ routingPolicy: { ...sets, policies: { P: p } } })
    const adds: Policy = { fallThrough: 'reject', terms: { '1': { actions: { communityAdd: { sets: ['REGEX'] }, flow: 'accept' } } } }
    const r = render(model(adds))
    expect(r.text).not.toContain('set community REGEX')
    expect(r.dispositions['routingPolicy.policies.P.terms["1"].actions.communityAdd.sets']).toEqual({ kind: 'unsupported', reason: 'a community set with a regex, which IOS-XR doesn\'t set or add' })
    // A later term: leaving it out would let the route on to the next, so the whole policy goes.
    const before: Policy = { fallThrough: 'reject', terms: { '1': { actions: { communitySet: { sets: ['REGEX'] }, flow: 'accept' } }, '2': { actions: { flow: 'reject' } } } }
    expect(render(model(before)).text).not.toContain('route-policy P')
  })
})

describe('regexes are kept byte for byte', () => {
  it('keeps repeated spaces and commas inside the quotes, and makes only the spaces outside them one', () => {
    const result = parse(lines('as-path-set A', '  ios-regex   \'_65000_  _65001_\'  ,', '  ios-regex \'_1,2_\'', 'end-set', '!', 'community-set C', '  ios-regex \' _65000:1 \'', 'end-set'))
    expect(result.model.routingPolicy?.asPathSets?.A.entries).toEqual({ '1': { action: 'permit', regex: '_65000_  _65001_' }, '2': { action: 'permit', regex: '_1,2_' } })
    expect(result.model.routingPolicy?.communitySets?.C.entries).toEqual({ '1': { action: 'permit', regexes: [' _65000:1 '] } })
    expect(parse(render(result.model).text).model).toEqual(result.model)
  })
})

describe('RFC 8212: a route policy that can\'t be written asks for one, as no policy does', () => {
  /** An eBGP neighbor with policy P each way in IPv4, P's body given; a group G with its own, when `group` is given. */
  const model = (p: Policy, chain = false, group?: Policy): Device => ({
    routingPolicy: { policies: { P: p, ...(group ? { G: group } : {}) } },
    networkInstances: {
      default: {
        bgp: {
          localAs: 65000,
          ...(group ? { groups: { PEERS: { addressFamilies: { 'ipv4-unicast': { importPolicies: ['G'], exportPolicies: ['G'] } } } } } : {}),
          neighbors: { '192.0.2.2': { peerAs: 65001, ...(group ? { group: 'PEERS' } : {}), addressFamilies: { 'ipv4-unicast': { importPolicies: chain ? ['P', 'P'] : ['P'], exportPolicies: ['P'] } } } }
        }
      }
    }
  })
  const writable: Policy = { fallThrough: 'reject', terms: { '1': { actions: { flow: 'accept' } } } }
  // Its first term matches what IOS-XR's simple form can't say, and leaving it out would change what the second sees.
  const unwritable: Policy = { fallThrough: 'reject', terms: { '1': { matches: { protocols: ['bgp'] }, actions: { flow: 'accept' } }, '2': { actions: { flow: 'reject' } } } }
  const id = 'iosxr.ebgp-policy:networkInstances.default.bgp.neighbors["192.0.2.2"]'
  const asked = (d: Device) => (render(d).needsInput ?? []).map((n) => n.id)

  it('asks nothing while the neighbor\'s policy is written', () => {
    expect(asked(model(writable))).toEqual([])
    expect(render(model(writable)).text).toContain('   route-policy P in\n   route-policy P out\n')
  })

  it('asks when its policy\'s body can\'t be written, or it names a chain, and writes the answer, the field left unsupported', () => {
    for (const d of [model(unwritable), model(writable, true)]) expect(asked(d)).toEqual([id])
    const answered = render(model(unwritable), { [id]: 'PASS-ALL' })
    expect(answered.text).toContain('   route-policy PASS-ALL in\n   route-policy PASS-ALL out\n')
    expect(answered.dispositions['networkInstances.default.bgp.neighbors["192.0.2.2"].addressFamilies["ipv4-unicast"].importPolicies']).toMatchObject({ kind: 'unsupported' })
    // A chain on import only: the export is written, the import asked for.
    const chain = render(model(writable, true), { [id]: 'PASS-ALL' })
    expect(chain.text).toContain('   route-policy PASS-ALL in\n   route-policy P out\n')
  })

  it('asks nothing when the group\'s written policy covers what the neighbor\'s can\'t (IOS-XR inherits it)', () => {
    expect(asked(model(unwritable, false, writable))).toEqual([])
    expect(asked(model(unwritable, false, unwritable))).toEqual([id])
  })
})
