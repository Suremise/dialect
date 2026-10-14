// A stub platform for the probes' own tests (src/probes.ts): a line language small enough to say what each probe needs,
// a careful parser and renderer, and one switch per bug class the probes look for, so each can be shown failing its
// probe. Not a real platform. One statement per line:
//
//   interface N | interface N description TEXT | interface N address A/L | interface N vrf V
//   vrf V | vrf V route P H | route P H
//   community C ro|rw | community C clients P
//   name-server A [vrf V] | search D
//   vlandef N [name X]
//   [vrf V] bgp as A | [vrf V] bgp group G | [vrf V] bgp neighbor A as N | [vrf V] bgp neighbor A group G
//   [vrf V] ospf area X interface I
//   bgp neighbor A import P
//   prefix-list L seq N permit|deny P [ge X] [le Y]
//   community-set C seq N permit|deny member M | community-set C seq N permit|deny regex R   (Cisco's dialect)
//   as-path-set A seq N permit|deny regex R                                                  (Cisco's dialect)
//   policy P term N match prefix-list L | match community C | match as-path A | action accept|reject|next-term|next-policy
//   no <any of them> (no interface N description, no interface N address A/L, no vrf V [route P], no route P,
//   no community C, no name-server A [vrf V], no search D, no [vrf V] bgp neighbor A, no [vrf V] ospf area X interface I,
//   no prefix-list L seq N, no policy P term N)
//
// A policy term is converted whole or not at all (the per-term rule): a term with a line the stub can't take is left out
// with all its lines unsupported, and its whole policy too when leaving it out isn't safe (termSkipSafe()).
import { communityType, fieldPath, parsePrefix, populatedLeaves, termSkipSafe, type Context, type Device, type Diagnostic, type FieldDisposition, type ParseResult, type PathSegment, type PlatformPlugin, type Policy, type RenderResult, type StatementDisposition, type SyntaxNode } from '@dialect/core'
import type { ProbeAdapter } from '../src'

/** The bug classes the probes look for, each as the stub can be told to make it. */
export type ProbeBug =
  /** Containers made with `{}` and plain assignment: `__proto__` sets a prototype instead of making a key. */
  | 'prototype'
  /** A community's client list is unsupported on parse, and the community kept open to every client. */
  | 'snmp-parse'
  /** The render writes a community without its clients, and says it wrote them. */
  | 'snmp-render'
  /** `no …` forms are ignored-by-design and remove nothing. */
  | 'negation'
  /** Any address, next hop, AS number and VLAN ID is taken as one. */
  | 'malformed'
  /** A `no …` in one VRF removes the same thing (a route, a BGP neighbor, an OSPF interface) in every VRF and the global table. */
  | 'vrf-scope'
  /** A name a term or a BGP neighbor gives is kept, whether or not anything has it. */
  | 'reference'
  /** A regex of another dialect is written as if it were the stub's own, with no word said. */
  | 'regex'

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
/** An IPv6 address, as a URL's host takes one. */
const isIpv6 = (text: string): boolean => text.includes(':') && URL.canParse(`http://[${text}]/`)
const isAddress = (text: string) => IPV4.test(text) || isIpv6(text)
/** A decimal number from `min` to `max` with no sign or leading zero, or null; any number at all when careless. */
function bounded(text: string, min: number, max: number, careless: boolean): number | null {
  if (careless) return Number.isNaN(Number(text)) ? null : Number(text)
  if (!/^[1-9]\d*$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

/** `A/L` as [address, length, family], or null. */
function prefix(text: string, careless: boolean): [string, number, 'ipv4' | 'ipv6'] | null {
  const m = /^(\S+)\/(\d+)$/.exec(text)
  if (!m) return null
  const family = m[1].includes(':') ? 'ipv6' : 'ipv4'
  if (careless) return [m[1], Number(m[2]), family]
  if (!(family === 'ipv4' ? IPV4.test(m[1]) : isIpv6(m[1]))) return null
  if (Number(m[2]) > (family === 'ipv4' ? 32 : 128)) return null
  return [m[1], Number(m[2]), family]
}

export function probeStub(bugs: readonly ProbeBug[] = []): PlatformPlugin {
  const bug = new Set(bugs)
  return {
    id: `probe-stub${bugs.length ? `-${bugs.join('-')}` : ''}`,
    name: 'Probe stub (tests only)',
    modelApi: '>=0.3.0 <1.0.0',
    capabilities: {
      interfaces: { parse: 'partial', render: 'partial' },
      'static-routes': { parse: 'partial', render: 'partial' },
      dns: { parse: 'partial', render: 'partial' },
      snmp: { parse: 'partial', render: 'partial' },
      vlans: { parse: 'partial', render: 'partial' },
      ospf: { parse: 'partial', render: 'partial' },
      bgp: { parse: 'partial', render: 'partial' },
      'routing-policy': { parse: 'partial', render: 'partial' }
    },
    parse(text: string, _context: Context): ParseResult {
      const model: Obj = {}
      const tree: SyntaxNode[] = []
      const dispositions: Record<string, StatementDisposition> = {}
      /** The object at `path`, made if missing: own keys only, unless told to be careless. */
      const object = (path: readonly string[]): Obj => {
        let o = model
        for (const key of path) {
          let next = Object.hasOwn(o, key) ? o[key] : undefined
          if (!isObject(next)) {
            next = {}
            if (bug.has('prototype')) o[key] = next
            else Object.defineProperty(o, key, { value: next, enumerable: true, writable: true, configurable: true })
          }
          o = next as Obj
        }
        return o
      }
      const put = (path: readonly string[], value: unknown) => {
        const o = object(path.slice(0, -1))
        Object.defineProperty(o, path[path.length - 1], { value, enumerable: true, writable: true, configurable: true })
        return fieldPath(...path)
      }
      const get = (path: readonly string[]): unknown => path.reduce<unknown>((o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined), model)
      const remove = (path: readonly string[]) => {
        const parent = get(path.slice(0, -1))
        if (isObject(parent)) delete parent[path[path.length - 1]]
        // Containers left empty go with it.
        for (let n = path.length - 1; n > 0; n--) {
          const o = get(path.slice(0, n))
          if (isObject(o) && !Object.keys(o).length) {
            const up = get(path.slice(0, n - 1))
            if (isObject(up)) delete up[path[n - 1]]
          }
        }
      }
      const mapped = (...fields: string[]): StatementDisposition => ({ kind: 'mapped', fields })
      const unsupported = (reason: string): StatementDisposition => ({ kind: 'unsupported', reason })
      const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })

      const statement = (w: readonly string[]): StatementDisposition => {
        const negate = w[0] === 'no'
        if (negate) {
          if (bug.has('negation')) return ignored('a no form')
          return removal(w.slice(1))
        }
        if (w[0] === 'interface' && w.length === 2) return mapped(put(['interfaces', w[1], 'type'], 'ethernet'))
        if (w[0] === 'interface' && w[2] === 'description' && w.length > 3) return mapped(put(['interfaces', w[1], 'description'], w.slice(3).join(' ')))
        if (w[0] === 'interface' && w[2] === 'address' && w.length === 4) {
          const p = prefix(w[3], bug.has('malformed'))
          if (!p) return unsupported('not an address with a prefix length')
          return mapped(put(['interfaces', w[1], 'subinterfaces', '0', p[2], 'addresses', p[0], 'prefixLength'], p[1]))
        }
        if (w[0] === 'interface' && w[2] === 'vrf' && w.length === 4) return mapped(put(['interfaces', w[1], 'subinterfaces', '0', 'networkInstance'], w[3]))
        if (w[0] === 'vrf' && w.length === 2) return mapped(put(['networkInstances', w[1], 'type'], 'vrf'))
        if (w[0] === 'vrf' && w[2] === 'route' && w.length === 5) return route(w[1], w[3], w[4])
        if (w[0] === 'route' && w.length === 3) return route('default', w[1], w[2])
        if (w[0] === 'community' && (w[2] === 'ro' || w[2] === 'rw') && w.length === 3) return mapped(put(['system', 'snmp', 'communities', w[1], 'access'], w[2] === 'ro' ? 'read-only' : 'read-write'))
        if (w[0] === 'community' && w[2] === 'clients' && w.length === 4) {
          if (bug.has('snmp-parse')) return unsupported('a client list')
          const clients = (get(['system', 'snmp', 'communities', w[1], 'clients']) as string[] | undefined) ?? []
          return mapped(put(['system', 'snmp', 'communities', w[1], 'clients'], [...clients, w[3]]))
        }
        if (w[0] === 'name-server' && (w.length === 2 || (w.length === 4 && w[2] === 'vrf'))) {
          if (!isAddress(w[1]) && !bug.has('malformed')) return unsupported('not an address')
          return mapped(w.length === 4 ? put(['system', 'dns', 'servers', w[1], 'networkInstance'], w[3]) : put(['system', 'dns', 'servers', w[1]], get(['system', 'dns', 'servers', w[1]]) ?? {}))
        }
        if (w[0] === 'search' && w.length === 2) {
          const search = (get(['system', 'dns', 'search']) as string[] | undefined) ?? []
          return mapped(put(['system', 'dns', 'search'], [...search, w[1]]))
        }
        if (w[0] === 'vlandef' && (w.length === 2 || (w.length === 4 && w[2] === 'name'))) {
          const id = bounded(w[1], 1, 4094, bug.has('malformed'))
          if (id === null) return unsupported('not a VLAN ID')
          if (w.length === 4) return mapped(put(['vlans', String(id), 'name'], w[3]))
          object(['vlans', String(id)])
          return mapped(fieldPath('vlans', String(id)))
        }
        if (w[0] === 'vrf' && (w[2] === 'bgp' || w[2] === 'ospf')) return protocol(w[1], w.slice(2))
        if (w[0] === 'bgp' || w[0] === 'ospf') return protocol('default', w)
        if (w[0] === 'prefix-list' || w[0] === 'community-set' || w[0] === 'as-path-set' || w[0] === 'policy') return policyStatement(w)
        return unsupported('the probe stub has no rule for it')
      }
      const rp = ['routingPolicy']
      /** Whether a name is one the source defined before (or, careless, any name at all). */
      const defined = (path: readonly string[]) => bug.has('reference') || isObject(get(path))
      /** Adds `value` to the leaf-list at `path`. */
      const push = (path: readonly string[], value: unknown) => put(path, [...((get(path) as unknown[] | undefined) ?? []), value])
      const position = (word: string | undefined) => (word !== undefined && /^(0|[1-9]\d{0,9})$/.test(word) && Number(word) <= 4294967294 ? word : null)
      /** A prefix list, a set or a policy term. */
      const policyStatement = (w: readonly string[]): StatementDisposition => {
        const seq = position(w[3])
        const action = w[4] === 'permit' || w[4] === 'deny' ? w[4] : null
        if (w[0] === 'prefix-list' && w[2] === 'seq' && seq !== null && action !== null && w.length >= 6) {
          const p = prefix(w[5], bug.has('malformed'))
          if (!p || (!bug.has('malformed') && !parsePrefix(w[5]))) return unsupported('not a prefix with no host bits set')
          const bits = p[2] === 'ipv4' ? 32 : 128
          const options = new Map<string, number | null>()
          for (let i = 6; i + 1 < w.length + 1; i += 2) options.set(w[i], w[i + 1] === undefined ? null : bounded(w[i + 1], 0, 128, bug.has('malformed')))
          const ge = options.get('ge')
          const le = options.get('le')
          if ([...options.keys()].some((k) => k !== 'ge' && k !== 'le') || ge === null || le === null) return unsupported('not a prefix list entry')
          const minLength = ge ?? p[1]
          const maxLength = le ?? (ge !== undefined ? bits : p[1])
          if (!bug.has('malformed') && !(p[1] <= minLength && minLength <= maxLength && maxLength <= bits && (ge === undefined || ge > p[1]))) return unsupported('lengths out of range')
          const form = ge !== undefined ? (le !== undefined ? 'ge-le' : 'ge') : le !== undefined ? 'le' : 'exact'
          const at = [...rp, 'prefixLists', p[2], w[1], 'entries', seq]
          put(at, { action, prefix: `${p[0]}/${p[1]}`, minLength, maxLength, form })
          return mapped(...populatedLeaves(get(at), at).map((l) => l.path))
        }
        if ((w[0] === 'community-set' || w[0] === 'as-path-set') && w[2] === 'seq' && seq !== null && action !== null && w.length === 7) {
          const set = [...rp, w[0] === 'community-set' ? 'communitySets' : 'asPathSets', w[1]]
          const at = [...set, 'entries', seq]
          if (w[0] === 'community-set' && w[5] === 'member') {
            if (communityType(w[6]) === null && !bug.has('malformed')) return unsupported('not a community')
            return mapped(put([...at, 'action'], action), push([...at, 'members'], w[6]))
          }
          if (w[5] !== 'regex') return unsupported('the probe stub has no rule for it')
          const dialect = put([...set, 'regexDialect'], 'cisco')
          return w[0] === 'community-set' ? mapped(dialect, put([...at, 'action'], action), push([...at, 'regexes'], w[6])) : mapped(dialect, put([...at, 'action'], action), put([...at, 'regex'], w[6]))
        }
        const term = position(w[3])
        if (w[0] === 'policy' && w[2] === 'term' && term !== null) {
          const at = [...rp, 'policies', w[1], 'terms', term]
          const fallThrough = put([...rp, 'policies', w[1], 'fallThrough'], 'reject')
          if (w[4] === 'action' && ['accept', 'reject', 'next-term', 'next-policy'].includes(w[5]) && w.length === 6) return mapped(fallThrough, put([...at, 'actions', 'flow'], w[5]))
          if (w[4] === 'match' && w.length === 7) {
            if (w[5] === 'prefix-list') {
              const family = ['ipv4', 'ipv6'].find((f) => isObject(get([...rp, 'prefixLists', f, w[6]]))) ?? (bug.has('reference') ? 'ipv4' : undefined)
              return family ? mapped(fallThrough, push([...at, 'matches', 'prefixLists', family], w[6])) : unsupported('names a prefix list the source doesn\'t have')
            }
            if (w[5] === 'community') return defined([...rp, 'communitySets', w[6]]) ? mapped(fallThrough, push([...at, 'matches', 'communitySets'], w[6])) : unsupported('names a community set the source doesn\'t have')
            if (w[5] === 'as-path') return defined([...rp, 'asPathSets', w[6]]) ? mapped(fallThrough, push([...at, 'matches', 'asPathSets'], w[6])) : unsupported('names an AS-path set the source doesn\'t have')
          }
        }
        return unsupported('the probe stub has no rule for it')
      }
      /** A BGP or OSPF statement in `instance`. */
      const protocol = (instance: string, w: readonly string[]): StatementDisposition => {
        const bgp = ['networkInstances', instance, 'bgp']
        const as = (word: string) => bounded(word, 1, 0xffffffff, bug.has('malformed'))
        if (w[0] === 'bgp' && w[1] === 'as' && w.length === 3) {
          const n = as(w[2])
          return n === null ? unsupported('not an AS number') : mapped(put([...bgp, 'localAs'], n))
        }
        if (w[0] === 'bgp' && w[1] === 'group' && w.length === 3) {
          object([...bgp, 'groups', w[2]])
          return mapped(fieldPath(...bgp, 'groups', w[2]))
        }
        if (w[0] === 'bgp' && w[1] === 'neighbor' && w[3] === 'as' && w.length === 5) {
          const n = as(w[4])
          if (!isAddress(w[2]) && !bug.has('malformed')) return unsupported('not an address')
          return n === null ? unsupported('not an AS number') : mapped(put([...bgp, 'neighbors', w[2], 'peerAs'], n))
        }
        if (w[0] === 'bgp' && w[1] === 'neighbor' && w[3] === 'group' && w.length === 5) return mapped(put([...bgp, 'neighbors', w[2], 'group'], w[4]))
        if (w[0] === 'bgp' && w[1] === 'neighbor' && w[3] === 'import' && w.length === 5) {
          if (!defined(['routingPolicy', 'policies', w[4]])) return unsupported('names a policy the source doesn\'t have')
          return mapped(push([...bgp, 'neighbors', w[2], 'importPolicies'], w[4]))
        }
        if (w[0] === 'ospf' && w[1] === 'area' && w[3] === 'interface' && w.length === 5) {
          if (!IPV4.test(w[2])) return unsupported('not an area in dotted form')
          object(['networkInstances', instance, 'ospf', 'areas', w[2], 'interfaces', w[4]])
          return mapped(fieldPath('networkInstances', instance, 'ospf', 'areas', w[2], 'interfaces', w[4]))
        }
        return unsupported('the probe stub has no rule for it')
      }
      const route = (instance: string, p: string, hop: string): StatementDisposition => {
        const pre = prefix(p, bug.has('malformed'))
        if (!pre || (!isAddress(hop) && !bug.has('malformed'))) return unsupported('not a route')
        return mapped(put(['networkInstances', instance, 'staticRoutes', p, 'nextHops', '0', 'address'], hop))
      }
      /** A `no …` form: removes what it names, in its own VRF only (unless told otherwise). */
      const removal = (w: readonly string[]): StatementDisposition => {
        const instances = () => Object.keys((get(['networkInstances']) as Obj | undefined) ?? {})
        if (w[0] === 'interface' && w[2] === 'description' && w.length === 3) remove(['interfaces', w[1], 'description'])
        else if (w[0] === 'interface' && w[2] === 'address' && w.length === 4) {
          const p = prefix(w[3], false)
          if (p) remove(['interfaces', w[1], 'subinterfaces', '0', p[2], 'addresses', p[0]])
        } else if (w[0] === 'vrf' && w.length === 2) {
          remove(['networkInstances', w[1]])
          if (bug.has('vrf-scope')) for (const i of instances()) remove(['networkInstances', i, 'staticRoutes'])
        } else if (w[0] === 'vrf' && w[2] === 'route' && w.length === 4) {
          for (const i of bug.has('vrf-scope') ? instances() : [w[1]]) remove(['networkInstances', i, 'staticRoutes', w[3]])
        } else if (w[0] === 'route' && w.length === 2) remove(['networkInstances', 'default', 'staticRoutes', w[1]])
        else if ((w[0] === 'vrf' && w[2] === 'bgp' && w[3] === 'neighbor' && w.length === 5) || (w[0] === 'bgp' && w[1] === 'neighbor' && w.length === 3)) {
          const [instance, address] = w[0] === 'vrf' ? [w[1], w[4]] : ['default', w[2]]
          for (const i of bug.has('vrf-scope') ? instances() : [instance]) remove(['networkInstances', i, 'bgp', 'neighbors', address])
        } else if ((w[0] === 'vrf' && w[2] === 'ospf' && w[3] === 'area' && w[5] === 'interface' && w.length === 7) || (w[0] === 'ospf' && w[1] === 'area' && w[3] === 'interface' && w.length === 5)) {
          const [instance, area, ifc] = w[0] === 'vrf' ? [w[1], w[4], w[6]] : ['default', w[2], w[4]]
          for (const i of bug.has('vrf-scope') ? instances() : [instance]) remove(['networkInstances', i, 'ospf', 'areas', area, 'interfaces', ifc])
        }
        else if (w[0] === 'community' && w.length === 2) remove(['system', 'snmp', 'communities', w[1]])
        else if (w[0] === 'name-server' && (w.length === 2 || (w.length === 4 && w[2] === 'vrf'))) {
          const server = get(['system', 'dns', 'servers', w[1]])
          const vrf = w.length === 4 ? w[3] : undefined
          if (isObject(server) && (bug.has('vrf-scope') || server.networkInstance === vrf)) remove(['system', 'dns', 'servers', w[1]])
        } else if (w[0] === 'search' && w.length === 2) {
          const rest = ((get(['system', 'dns', 'search']) as string[] | undefined) ?? []).filter((d) => d !== w[1])
          if (rest.length) put(['system', 'dns', 'search'], rest)
          else remove(['system', 'dns', 'search'])
        } else if (w[0] === 'prefix-list' && w[2] === 'seq' && w.length === 4) {
          for (const family of ['ipv4', 'ipv6']) if (isObject(get(['routingPolicy', 'prefixLists', family, w[1], 'entries', w[3]]))) remove(['routingPolicy', 'prefixLists', family, w[1], 'entries', w[3]])
        } else if (w[0] === 'policy' && w[2] === 'term' && w.length === 4) {
          remove(['routingPolicy', 'policies', w[1], 'terms', w[3]])
          const policy = get(['routingPolicy', 'policies', w[1]])
          if (isObject(policy) && !isObject(policy.terms)) remove(['routingPolicy', 'policies', w[1]])
        } else return unsupported('the probe stub has no rule for it')
        return ignored('removes what it names: nothing to convert')
      }

      text.split(/\r\n?|\n/).forEach((line, i) => {
        const w = line.trim().split(/\s+/).filter(Boolean)
        if (!w.length) return
        const node: SyntaxNode = { id: `L${i + 1}`, label: w.join(' '), span: { startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: line.length + 1 } }
        tree.push(node)
        dispositions[node.id] = statement(w)
      })
      // The per-term rule: a term with a line the stub couldn't take is left out whole, every line of it unsupported,
      // and its policy too when that isn't safe. Careless about references, it keeps the term as it is.
      const lines = (policy: string, term?: string) => tree.filter((n) => n.label.startsWith(`policy ${policy} term `) && (term === undefined || n.label.split(' ')[3] === term))
      for (const n of tree) {
        const [first, policy, , term] = n.label.split(' ')
        if (first !== 'policy' || dispositions[n.id].kind !== 'unsupported' || term === undefined) continue
        const p = get(['routingPolicy', 'policies', policy]) as Policy | undefined
        const whole = p?.terms !== undefined && Object.hasOwn(p.terms, term) && !termSkipSafe(p, term)
        for (const l of lines(policy, whole ? undefined : term)) if (dispositions[l.id].kind === 'mapped') dispositions[l.id] = unsupported(whole ? 'its policy is converted whole or not at all' : 'its term is converted whole or not at all')
        remove(['routingPolicy', 'policies', policy, ...(whole ? [] : ['terms', term])])
        const left = get(['routingPolicy', 'policies', policy])
        if (isObject(left) && !isObject(left.terms)) remove(['routingPolicy', 'policies', policy])
      }
      // A statement whose fields a later `no` removed: it says so, as a removed statement's disposition would.
      for (const [id, d] of Object.entries(dispositions)) {
        if (d.kind === 'mapped' && d.fields.some((f) => !hasField(model, f))) dispositions[id] = ignored('removed by a later statement')
      }
      return { tree, model: model as Device, dispositions, diagnostics: [] }
    },
    render(model: Device, _context: Context): RenderResult {
      const lines: string[] = []
      const dispositions: Record<string, FieldDisposition> = {}
      const emit = (line: string, ...fields: PathSegment[][]) => {
        lines.push(line)
        for (const f of fields) dispositions[fieldPath(...f)] = { kind: 'rendered', span: { startLine: lines.length, startColumn: 1, endLine: lines.length, endColumn: line.length + 1 } }
      }
      for (const [name, i] of Object.entries(model.interfaces ?? {})) {
        emit(`interface ${name}`, ...(i.type !== undefined ? [['interfaces', name, 'type']] : []))
        if (i.description !== undefined) emit(`interface ${name} description ${i.description}`, ['interfaces', name, 'description'])
        const sub = i.subinterfaces?.['0']
        if (sub?.networkInstance !== undefined) emit(`interface ${name} vrf ${sub.networkInstance}`, ['interfaces', name, 'subinterfaces', '0', 'networkInstance'])
        for (const family of ['ipv4', 'ipv6'] as const)
          for (const [a, v] of Object.entries(sub?.[family]?.addresses ?? {})) emit(`interface ${name} address ${a}/${v.prefixLength}`, ['interfaces', name, 'subinterfaces', '0', family, 'addresses', a, 'prefixLength'])
      }
      for (const [id, v] of Object.entries(model.vlans ?? {})) emit(`vlandef ${id}${v.name !== undefined ? ` name ${v.name}` : ''}`, v.name !== undefined ? ['vlans', id, 'name'] : ['vlans', id])
      for (const [name, instance] of Object.entries(model.networkInstances ?? {})) {
        const vrf = name === 'default' ? '' : `vrf ${name} `
        const at = ['networkInstances', name]
        if (name !== 'default') emit(`vrf ${name}`, ...(instance.type !== undefined ? [[...at, 'type']] : []))
        for (const [p, r] of Object.entries(instance.staticRoutes ?? {}))
          for (const [i, hop] of Object.entries(r.nextHops ?? {})) emit(`${vrf}route ${p} ${hop.address}`, [...at, 'staticRoutes', p, 'nextHops', i, 'address'])
        const bgp = instance.bgp
        if (bgp?.localAs !== undefined) emit(`${vrf}bgp as ${bgp.localAs}`, [...at, 'bgp', 'localAs'])
        for (const g of Object.keys(bgp?.groups ?? {})) emit(`${vrf}bgp group ${g}`, [...at, 'bgp', 'groups', g])
        for (const [a, n] of Object.entries(bgp?.neighbors ?? {})) {
          if (n.peerAs !== undefined) emit(`${vrf}bgp neighbor ${a} as ${n.peerAs}`, [...at, 'bgp', 'neighbors', a, 'peerAs'])
          if (n.group !== undefined) emit(`${vrf}bgp neighbor ${a} group ${n.group}`, [...at, 'bgp', 'neighbors', a, 'group'])
        }
        for (const [area, a] of Object.entries(instance.ospf?.areas ?? {}))
          for (const i of Object.keys(a.interfaces ?? {})) emit(`${vrf}ospf area ${area} interface ${i}`, [...at, 'ospf', 'areas', area, 'interfaces', i])
      }
      for (const [name, c] of Object.entries(model.system?.snmp?.communities ?? {})) {
        const at = ['system', 'snmp', 'communities', name]
        if (c.clients?.length && bug.has('snmp-render')) {
          emit(`community ${name} ${c.access === 'read-write' ? 'rw' : 'ro'}`, [...at, 'access'], [...at, 'clients'])
          continue
        }
        emit(`community ${name} ${c.access === 'read-write' ? 'rw' : 'ro'}`, [...at, 'access'])
        c.clients?.forEach((client, i) => emit(`community ${name} clients ${client}`, ...(i === 0 ? [[...at, 'clients']] : [])))
      }
      for (const [a, s] of Object.entries(model.system?.dns?.servers ?? {})) emit(`name-server ${a}${s.networkInstance ? ` vrf ${s.networkInstance}` : ''}`, ['system', 'dns', 'servers', a, ...(s.networkInstance ? ['networkInstance'] : [])])
      model.system?.dns?.search?.forEach((d, i) => emit(`search ${d}`, ...(i === 0 ? [['system', 'dns', 'search']] : [])))
      // Routing policy: the stub writes Cisco's regex dialect only, and route policies that reject what no term decides.
      const diagnostics: Diagnostic[] = []
      const rp = model.routingPolicy
      const leavesOf = (value: unknown, ...at: PathSegment[]) => populatedLeaves(value, at).map((l) => l.path)
      for (const family of ['ipv4', 'ipv6'] as const)
        for (const [name, list] of Object.entries(rp?.prefixLists?.[family] ?? {}))
          for (const [seq, e] of Object.entries(list.entries ?? {})) {
            const length = Number(e.prefix.split('/')[1])
            const options = e.form === 'ge' ? ` ge ${e.minLength}` : e.form === 'le' ? ` le ${e.maxLength}` : e.form === 'ge-le' ? ` ge ${e.minLength} le ${e.maxLength}` : e.minLength === length && e.maxLength === length ? '' : ` ge ${e.minLength} le ${e.maxLength}`
            emit(`prefix-list ${name} seq ${seq} ${e.action} ${e.prefix}${options}`, ...['action', 'prefix', 'minLength', 'maxLength', 'form'].filter((leaf) => Object.hasOwn(e, leaf)).map((leaf) => ['routingPolicy', 'prefixLists', family, name, 'entries', seq, leaf]))
          }
      /** A set's regexes: written when they are Cisco's, or (careless) whatever they are; else unsupported, never rewritten. */
      const foreign = (dialect: string | undefined) => dialect !== undefined && dialect !== 'cisco' && !bug.has('regex')
      for (const [kind, sets] of [['community-set', rp?.communitySets], ['as-path-set', rp?.asPathSets]] as const)
        for (const [name, set] of Object.entries(sets ?? {})) {
          const at = ['routingPolicy', kind === 'community-set' ? 'communitySets' : 'asPathSets', name]
          if (foreign(set.regexDialect)) {
            for (const path of leavesOf(set, ...at)) dispositions[path] = { kind: 'unsupported', reason: 'the stub writes Cisco\'s regex dialect only' }
            continue
          }
          if (set.regexDialect !== undefined) dispositions[fieldPath(...at, 'regexDialect')] = { kind: 'not-applicable', reason: 'the stub writes Cisco\'s regex dialect' }
          for (const [seq, e] of Object.entries((set.entries ?? {}) as Record<string, { action: string; members?: readonly string[]; regexes?: readonly string[]; regex?: string }>)) {
            const entry = [...at, 'entries', seq]
            e.members?.forEach((m, i) => emit(`${kind} ${name} seq ${seq} ${e.action} member ${m}`, ...(i === 0 ? [[...entry, 'action'], [...entry, 'members']] : [])))
            e.regexes?.forEach((r, i) => emit(`${kind} ${name} seq ${seq} ${e.action} regex ${r}`, ...(i === 0 ? [[...entry, 'regexes'], ...(e.members?.length ? [] : [[...entry, 'action']])] : [])))
            if (e.regex !== undefined) emit(`${kind} ${name} seq ${seq} ${e.action} regex ${e.regex}`, [...entry, 'action'], [...entry, 'regex'])
          }
        }
      for (const [name, policy] of Object.entries(rp?.policies ?? {})) {
        const at = ['routingPolicy', 'policies', name]
        if (policy.fallThrough !== undefined) {
          dispositions[fieldPath(...at, 'fallThrough')] = { kind: 'not-applicable', reason: 'the stub\'s policies reject what no term decides' }
          if (policy.fallThrough !== 'reject') diagnostics.push({ severity: 'warning', category: 'semantic', code: 'probe-stub.fall-through', message: 'A policy goes on to the next policy when no term decides, and the stub\'s rejects.', field: fieldPath(...at, 'fallThrough') })
        }
        for (const [seq, term] of Object.entries(policy.terms ?? {})) {
          const t = [...at, 'terms', seq]
          for (const [family, names] of Object.entries(term.matches?.prefixLists ?? {}) as [string, readonly string[] | undefined][]) names?.forEach((n, i) => emit(`policy ${name} term ${seq} match prefix-list ${n}`, ...(i === 0 ? [[...t, 'matches', 'prefixLists', family]] : [])))
          term.matches?.communitySets?.forEach((n, i) => emit(`policy ${name} term ${seq} match community ${n}`, ...(i === 0 ? [[...t, 'matches', 'communitySets']] : [])))
          term.matches?.asPathSets?.forEach((n, i) => emit(`policy ${name} term ${seq} match as-path ${n}`, ...(i === 0 ? [[...t, 'matches', 'asPathSets']] : [])))
          if (term.actions?.flow !== undefined) emit(`policy ${name} term ${seq} action ${term.actions.flow}`, [...t, 'actions', 'flow'])
        }
      }
      for (const [name, instance] of Object.entries(model.networkInstances ?? {}))
        for (const [a, n] of Object.entries(instance.bgp?.neighbors ?? {}))
          n.importPolicies?.forEach((p, i) => emit(`${name === 'default' ? '' : `vrf ${name} `}bgp neighbor ${a} import ${p}`, ...(i === 0 ? [['networkInstances', name, 'bgp', 'neighbors', a, 'importPolicies']] : [])))
      return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics }
    }
  }
}

/** Whether a mapped field's path is still in the model. */
function hasField(model: Obj, field: string): boolean {
  // Field paths name keys with dots or brackets: find the field among the model's own.
  const fields = new Set<string>()
  const walk = (v: unknown, at: string[]) => {
    fields.add(fieldPath(...at))
    if (isObject(v)) for (const k of Object.keys(v)) walk(v[k], [...at, k])
  }
  walk(model, [])
  return fields.has(field)
}

/** The same OSPF interface and BGP neighbor in the global table and in VRFs A and B, for the scoping probe. */
const OSPF_BASE = ['interface e1', 'vrf A', 'vrf B', 'ospf area 0.0.0.0 interface e1', 'vrf A ospf area 0.0.0.0 interface e1', 'vrf B ospf area 0.0.0.0 interface e1'].join('\n')
const BGP_BASE = ['vrf A', 'vrf B', 'bgp neighbor 192.0.2.2 as 65001', 'vrf A bgp neighbor 192.0.2.2 as 65002', 'vrf B bgp neighbor 192.0.2.2 as 65003'].join('\n')
/** A prefix list of two entries and a policy of two terms, for the policy negation cases. */
const POLICY_BASE = ['prefix-list L seq 5 permit 10.0.0.0/8 le 24', 'prefix-list L seq 10 deny 0.0.0.0/0 le 32', 'policy P term 10 match prefix-list L', 'policy P term 10 action accept', 'policy P term 20 action reject'].join('\n')

/** The stub's probe adapter: every probe and case, in its syntax. */
export const PROBE_STUB_ADAPTER: ProbeAdapter = {
  prototypeKeys: {
    source: (key) =>
      [
        `community ${key} ro`,
        `interface ${key}`,
        `interface ${key} description d`,
        `vrf ${key}`,
        `vrf ${key} route 10.0.0.0/8 192.0.2.1`,
        `search ${key}`,
        `name-server 192.0.2.53 vrf ${key}`,
        `vlandef 10 name ${key}`,
        `bgp group ${key}`,
        `bgp neighbor 192.0.2.2 group ${key}`,
        `ospf area 0.0.0.0 interface ${key}`
      ].join('\n'),
    uses: { interface: true, vrf: true, community: true, dns: true, vlan: true, 'bgp-group': true }
  },
  snmpAccess: {
    'read-only': 'community PLACEHOLDER-RO ro\ncommunity PLACEHOLDER-RO clients 192.0.2.0/24',
    'read-write': 'community PLACEHOLDER-RW rw\ncommunity PLACEHOLDER-RW clients 192.0.2.0/24'
  },
  negation: {
    address: { set: 'interface e1\ninterface e1 address 192.0.2.1/24', negated: 'interface e1\ninterface e1 address 192.0.2.1/24\nno interface e1 address 192.0.2.1/24', path: ['interfaces', 'e1', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1'] },
    description: { set: 'interface e1\ninterface e1 description uplink', negated: 'interface e1\ninterface e1 description uplink\nno interface e1 description', path: ['interfaces', 'e1', 'description'] },
    'name-server': { set: 'name-server 192.0.2.53', negated: 'name-server 192.0.2.53\nno name-server 192.0.2.53', path: ['system', 'dns', 'servers', '192.0.2.53'] },
    'static-route': { set: 'route 10.0.0.0/8 192.0.2.1', negated: 'route 10.0.0.0/8 192.0.2.1\nno route 10.0.0.0/8', path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8'] },
    community: { set: 'community PLACEHOLDER ro', negated: 'community PLACEHOLDER ro\nno community PLACEHOLDER', path: ['system', 'snmp', 'communities', 'PLACEHOLDER'] },
    'bgp-neighbor': { set: 'bgp as 65000\nbgp neighbor 192.0.2.2 as 65001', negated: 'bgp as 65000\nbgp neighbor 192.0.2.2 as 65001\nno bgp neighbor 192.0.2.2', path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2'] },
    'ospf-interface': { set: 'interface e1\nospf area 0.0.0.0 interface e1', negated: 'interface e1\nospf area 0.0.0.0 interface e1\nno ospf area 0.0.0.0 interface e1', path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'e1'] },
    'policy-term': { set: POLICY_BASE, negated: `${POLICY_BASE}\nno policy P term 10`, path: ['routingPolicy', 'policies', 'P', 'terms', '10'] },
    'prefix-list-entry': { set: POLICY_BASE, negated: `${POLICY_BASE}\nno prefix-list L seq 10`, path: ['routingPolicy', 'prefixLists', 'ipv4', 'L', 'entries', '10'] }
  },
  malformed: {
    'ipv4-address': { source: 'interface e1\ninterface e1 address 999.1.1.1/24', value: '999.1.1.1' },
    'ipv6-address': { source: 'interface e1\ninterface e1 address dead::beef::1/64', value: 'dead::beef::1' },
    mask: { source: 'interface e1\ninterface e1 address 192.0.2.1/33', value: '192.0.2.1/33' },
    'next-hop': { source: 'route 10.0.0.0/8 192.0.2.300', value: '192.0.2.300' },
    'as-number': { source: 'bgp neighbor 192.0.2.2 as 4294967296', value: '4294967296' },
    'vlan-id': { source: 'vlandef 4095', value: '4095' },
    prefix: { source: 'prefix-list L seq 5 permit 10.0.0.0/33', value: '10.0.0.0/33' },
    'prefix-length': { source: 'prefix-list L seq 5 permit 10.0.0.0/8 le 33', value: '33' }
  },
  vrfScoping: {
    delete: { base: 'route 10.0.0.0/8 192.0.2.1\nvrf A\nvrf A route 10.0.0.0/8 192.0.2.2\nvrf B\nvrf B route 10.0.0.0/8 192.0.2.3', changed: 'route 10.0.0.0/8 192.0.2.1\nvrf A\nvrf A route 10.0.0.0/8 192.0.2.2\nvrf B\nvrf B route 10.0.0.0/8 192.0.2.3\nno vrf A', vrf: 'A' },
    dns: { base: 'vrf A\nname-server 192.0.2.53\nname-server 192.0.2.54 vrf A', changed: 'vrf A\nname-server 192.0.2.53\nname-server 192.0.2.54 vrf A\nno name-server 192.0.2.53 vrf A\nno name-server 192.0.2.54 vrf A', vrf: 'A' },
    'static-route': { base: 'route 10.0.0.0/8 192.0.2.1\nvrf A\nvrf A route 10.0.0.0/8 192.0.2.2\nvrf B\nvrf B route 10.0.0.0/8 192.0.2.3', changed: 'route 10.0.0.0/8 192.0.2.1\nvrf A\nvrf A route 10.0.0.0/8 192.0.2.2\nvrf B\nvrf B route 10.0.0.0/8 192.0.2.3\nno vrf A route 10.0.0.0/8', vrf: 'A' },
    ospf: { base: OSPF_BASE, changed: `${OSPF_BASE}\nno vrf A ospf area 0.0.0.0 interface e1`, vrf: 'A' },
    bgp: { base: BGP_BASE, changed: `${BGP_BASE}\nno vrf A bgp neighbor 192.0.2.2`, vrf: 'A' }
  },
  unknownReference: {
    'prefix-list': { source: 'policy P term 10 match prefix-list MISSING\npolicy P term 10 action accept', value: 'MISSING' },
    'community-set': { source: 'policy P term 10 match community MISSING\npolicy P term 10 action accept', value: 'MISSING' },
    'as-path-set': { source: 'policy P term 10 match as-path MISSING\npolicy P term 10 action accept', value: 'MISSING' },
    policy: { source: 'bgp as 65000\nbgp neighbor 192.0.2.2 as 65001\nbgp neighbor 192.0.2.2 import MISSING', value: 'MISSING' }
  },
  regex: { source: 'as-path-set A seq 1 permit regex _65000_\ncommunity-set C seq 1 permit regex _65000:[0-9]+_', regexes: ['_65000_', '_65000:[0-9]+_'] }
}
