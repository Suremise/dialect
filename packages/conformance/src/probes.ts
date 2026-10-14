// Probes for the bug classes reviews kept finding in plugins (#33): each plugin supplies small sources in its own
// syntax through a ProbeAdapter, and the kit checks what comes out, the same way for every platform:
// 1. prototype keys: `__proto__`, `constructor` and `toString` as an interface, VRF, SNMP community, DNS name, VLAN
//    name and BGP group stay own keys (or values), round-trip, and leave Object.prototype as it was;
// 2. SNMP access never widens: a community limited to some clients comes out with its clients, or not at all, from
//    the parse, the render and a render of the kit's own model; never open to every client;
// 3. negation clears state: a `no …` / `delete` after a value leaves nothing of it in the model or the render;
// 4. malformed values are flagged, not mapped: a bad address, mask, next hop, AS number or VLAN ID is in no model and
//    maps no statement;
// 5. VRF scoping: a change in one VRF (its static routes, DNS, OSPF or BGP) changes nothing outside it.
// Every probe source also goes through the five fixture checks (checks.ts), the secrets check among them: a probe
// source with a secret (a community, the prototype keys used as one) has it checked like any fixture's.
// A probe a plugin can't run yet (an area it doesn't support) is declared `notApplicable` with why, never left out:
// the adapter's types make every probe and case a choice. The cases model 0.4.0 added (VLANs, OSPF, BGP) are optional
// in the types until each plugin's phase 2 card gives them: one left out isn't run (probesNotGiven() lists it, and
// describeConformance() shows it as a skipped test), so an adapter written before 0.4.0 runs as it did.
import { fieldPath, MODEL_VERSION, statementsOf, type Context, type Device, type PathSegment, type PlatformPlugin } from '@dialect/core'
import { checkFixture, type CheckResult } from './checks'
import { findSecrets, type SecretsOptions } from './secrets'

/** A probe or case a plugin can't run yet, with why (the area it doesn't support, the syntax it can't say). */
export interface NotApplicable {
  readonly notApplicable: string
}
export type Probe<T> = T | NotApplicable

/** Where a prototype key is used as a name. */
export type NameUse = 'interface' | 'vrf' | 'community' | 'dns' | 'vlan' | 'bgp-group'
export type NegationKind = 'address' | 'description' | 'name-server' | 'static-route' | 'community' | 'bgp-neighbor' | 'ospf-interface'
export type MalformedKind = 'ipv4-address' | 'ipv6-address' | 'mask' | 'next-hop' | 'as-number' | 'vlan-id'
export type ScopingKind = 'delete' | 'dns' | 'static-route' | 'ospf' | 'bgp'

/** The name uses and cases model 0.4.0 added: optional in an adapter until its plugin's phase 2 card gives them. */
export type NameUse04 = 'vlan' | 'bgp-group'
export type NegationKind04 = 'bgp-neighbor' | 'ospf-interface'
export type MalformedKind04 = 'as-number' | 'vlan-id'
export type ScopingKind04 = 'ospf' | 'bgp'

/** Every key of `K` given, except those of `Later`, which may be left out (`not given yet`). */
type Choices<K extends string, Later extends K, V> = { readonly [P in Exclude<K, Later>]: V } & { readonly [P in Later]?: V }

/** Each kind in the order the probes run and report them. */
const NAME_USES: readonly NameUse[] = ['interface', 'vrf', 'community', 'dns', 'vlan', 'bgp-group']
const NEGATION_KINDS: readonly NegationKind[] = ['address', 'description', 'name-server', 'static-route', 'community', 'bgp-neighbor', 'ospf-interface']
const MALFORMED_KINDS: readonly MalformedKind[] = ['ipv4-address', 'ipv6-address', 'mask', 'next-hop', 'as-number', 'vlan-id']
const SCOPING_KINDS: readonly ScopingKind[] = ['delete', 'dns', 'static-route', 'ospf', 'bgp']
/** Marks a model 0.4.0 case an adapter leaves out: not run, and listed by probesNotGiven(). */
const NOT_GIVEN: NotApplicable = Object.freeze({ notApplicable: 'not given yet' })
/** An adapter's case or use of `kind`, or NOT_GIVEN when it leaves a model 0.4.0 one out. */
const choice = <V>(cases: object, kind: string): V | NotApplicable => (cases as Partial<Record<string, V>>)[kind] ?? NOT_GIVEN

/**
 * The model 0.4.0 cases `adapter` leaves out (`negation: bgp-neighbor`, `prototype-keys: as a VLAN name`): runProbes()
 * doesn't run them, and the suite shows them as one skipped test until the plugin's phase 2 card gives each, or
 * declares it not applicable.
 */
export function probesNotGiven(adapter: ProbeAdapter): string[] {
  const out: string[] = []
  if (!isNotApplicable(adapter.prototypeKeys)) for (const use of NAME_USES) if (choice(adapter.prototypeKeys.uses, use) === NOT_GIVEN) out.push(`prototype-keys: as ${USE_NAMES[use]}`)
  for (const [probe, cases, kinds] of [
    ['negation', adapter.negation, NEGATION_KINDS],
    ['malformed', adapter.malformed, MALFORMED_KINDS],
    ['vrf-scoping', adapter.vrfScoping, SCOPING_KINDS]
  ] as const)
    for (const kind of kinds) if (choice(cases, kind) === NOT_GIVEN) out.push(`${probe}: ${kind}`)
  return out
}

const USE_NAMES: Record<NameUse, string> = { interface: 'an interface', vrf: 'a VRF', community: 'an SNMP community', dns: 'a DNS name', vlan: 'a VLAN name', 'bgp-group': 'a BGP group' }

/** A value set, then cleared by the platform's `no …` or `delete`. */
export interface NegationCase {
  /** The source that sets the value. */
  readonly set: string
  /** The same source with the value cleared after it (`set` plus a `no …`, as the device would take it). */
  readonly negated: string
  /** Where the value is in the model: present after `set`, absent after `negated`. */
  readonly path: readonly PathSegment[]
}

/** A source with one malformed value in it. */
export interface MalformedCase {
  readonly source: string
  /**
   * The malformed value, as written in the source: it may be in no model (as a key, a string or a number), and no
   * statement on its line may map.
   */
  readonly value: string
  /** The 1-based line of the statement that has it, when the value is on more than one line or the statement spans several. */
  readonly line?: number
}

/** A change made in one VRF. */
export interface ScopingCase {
  /** A source with the same things in that VRF, in another VRF and in the global table. */
  readonly base: string
  /** `base` with one change in `vrf` (a delete, a DNS, static route, OSPF or BGP change). */
  readonly changed: string
  readonly vrf: string
}

/** What a plugin supplies for the probes, in its own syntax. Every probe and case is given or declared not applicable. */
export interface ProbeAdapter {
  /**
   * One source using `key` as each kind of name it can (an interface, a VRF, an SNMP community, a DNS name: a search
   * domain, a server's VRF; a VLAN's name, a BGP group in the default instance), in one text, so a key that is a
   * community is also a VRF's name; and which uses it has.
   */
  readonly prototypeKeys: Probe<{ readonly source: (key: string) => string; readonly uses: Choices<NameUse, NameUse04, true | NotApplicable> }>
  /** A source with one SNMP community limited to some clients (an access list, a client list), per access. */
  readonly snmpAccess: Probe<{ readonly 'read-only': string; readonly 'read-write': string }>
  /** Negating a BGP neighbor or an OSPF interface clears it, as negating an address does. */
  readonly negation: Choices<NegationKind, NegationKind04, Probe<NegationCase>>
  /** An AS number out of range (`4294967296`), a VLAN ID out of range (`4095`), as an address is. */
  readonly malformed: Choices<MalformedKind, MalformedKind04, Probe<MalformedCase>>
  /** A change to the VRF's OSPF or BGP stays in it, as a static route change does. */
  readonly vrfScoping: Choices<ScopingKind, ScopingKind04, Probe<ScopingCase>>
}

export type ProbeName = 'prototype-keys' | 'snmp-access' | 'negation' | 'malformed' | 'vrf-scoping'

export interface ProbeResult {
  readonly probe: ProbeName
  /** The case: a key, an access, a kind. */
  readonly case: string
  readonly status: 'passed' | 'failed' | 'not-applicable'
  /** What failed, or why it doesn't apply. */
  readonly problems: readonly string[]
  /** Leaks the secrets check let through on its sources, each with its temporary allowance (allowances.ts). */
  readonly allowed?: CheckResult['allowed']
}

export const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'toString']

/** The community the SNMP probe renders from the kit's own model, and its clients. */
export const PROBE_COMMUNITY = 'PROBE-COMMUNITY'
export const PROBE_CLIENTS: readonly string[] = ['192.0.2.0/24']

const isNotApplicable = (p: unknown): p is NotApplicable => typeof p === 'object' && p !== null && Object.hasOwn(p, 'notApplicable')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** The own value at `path`, never one inherited from Object.prototype. */
const at = (value: unknown, path: readonly PathSegment[]): unknown => {
  let v = value
  for (const seg of path) {
    if (!isObject(v) && !Array.isArray(v)) return undefined
    const key = String(seg)
    if (!Object.hasOwn(v, key)) return undefined
    v = (v as Record<string, unknown>)[key]
  }
  return v
}
const show = (path: readonly PathSegment[]) => path.map(String).join('.')

/** Every leaf of a model with its path (segments) and value; an empty object or array is a leaf of its own. */
function leaves(value: unknown, prefix: PathSegment[] = []): { path: PathSegment[]; value: unknown }[] {
  if (Array.isArray(value)) return [{ path: prefix, value: JSON.stringify(value) }]
  if (!isObject(value)) return value === undefined ? [] : [{ path: prefix, value }]
  const keys = Object.keys(value)
  if (!keys.length) return [{ path: prefix, value: '{}' }]
  return keys.flatMap((k) => leaves(value[k], [...prefix, k]))
}

/**
 * Whether `needle` is an own key, a string value or a number's decimal form anywhere in `value` (case-insensitive): an
 * AS number out of range taken as a number is found too.
 */
function contains(value: unknown, needle: string): boolean {
  const n = needle.toLowerCase()
  if (typeof value === 'string') return value.toLowerCase() === n
  if (typeof value === 'number') return String(value) === n
  if (Array.isArray(value)) return value.some((v) => contains(v, needle))
  if (!isObject(value)) return false
  return Object.keys(value).some((k) => k.toLowerCase() === n || contains(value[k], needle))
}

/** Object.prototype as it is: every own property's descriptor (names and symbols), and its own prototype. */
interface PrototypeSnapshot {
  readonly descriptors: ReadonlyMap<string | symbol, PropertyDescriptor>
  readonly proto: object | null
}
function snapshotPrototype(): PrototypeSnapshot {
  return { descriptors: new Map(Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)!])), proto: Object.getPrototypeOf(Object.prototype) as object | null }
}
const DESCRIPTOR_PARTS = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'] as const
/** How Object.prototype differs from `snapshot`: a property added, removed or changed (a value or accessor replaced, a flag flipped), or its prototype. */
function prototypeChanges(snapshot: PrototypeSnapshot): string[] {
  const out: string[] = []
  const now = snapshotPrototype()
  const name = (k: string | symbol) => (typeof k === 'symbol' ? k.toString() : k)
  for (const [k, d] of now.descriptors) {
    const was = snapshot.descriptors.get(k)
    if (!was) out.push(`Object.prototype has a new property ${name(k)}`)
    else if (DESCRIPTOR_PARTS.some((part) => !Object.is(was[part], d[part]))) out.push(`Object.prototype.${name(k)} was changed`)
  }
  for (const k of snapshot.descriptors.keys()) if (!now.descriptors.has(k)) out.push(`Object.prototype.${name(k)} was removed`)
  if (now.proto !== snapshot.proto) out.push('Object.prototype\'s prototype was changed')
  return out
}
/** Puts Object.prototype back as `snapshot` had it, so a careless plugin doesn't change the rest of the test run. */
function restorePrototype(snapshot: PrototypeSnapshot): void {
  for (const k of Reflect.ownKeys(Object.prototype)) if (!snapshot.descriptors.has(k)) Reflect.deleteProperty(Object.prototype, k)
  for (const [k, d] of snapshot.descriptors) Reflect.defineProperty(Object.prototype, k, d)
  // Object.prototype's own prototype is immutable (an exotic object): nothing to put back.
}

/** Runs every probe `adapter` supplies on `plugin`. Secrets options go to the fixture checks each probe source gets. */
export function runProbes(plugin: PlatformPlugin, adapter: ProbeAdapter, { modelVersion = MODEL_VERSION, ...options }: SecretsOptions & { modelVersion?: string } = {}): ProbeResult[] {
  const context: Context = { modelVersion }
  const results: ProbeResult[] = []
  /** The allowances the current case's fixture checks used, given with its result. */
  let allowed: NonNullable<CheckResult['allowed']>[number][] = []
  const add = (probe: ProbeName, name: string, problems: string[]) => {
    results.push({ probe, case: name, status: problems.length ? 'failed' : 'passed', problems, ...(allowed.length ? { allowed } : {}) })
    allowed = []
  }
  const notApplicable = (probe: ProbeName, name: string, p: NotApplicable) => results.push({ probe, case: name, status: 'not-applicable', problems: [p.notApplicable] })

  if (!plugin.parse || !plugin.render) {
    for (const probe of ['prototype-keys', 'snmp-access', 'negation', 'malformed', 'vrf-scoping'] as const) add(probe, 'all', [`the plugin has no ${!plugin.parse ? 'parse' : 'render'}()`])
    return results
  }
  const parse = (text: string) => plugin.parse!(text, context)
  const render = (model: Device) => plugin.render!(model, context)
  const errors = (step: string, r: { diagnostics: readonly { severity: string; message: string }[] }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${step} error: ${d.message}`)
  /** The SNMP community names a model has: secrets, whatever syntax the plugin writes them in. */
  const communities = (model: Device) => Object.keys((at(model, ['system', 'snmp', 'communities']) as object | undefined) ?? {})
  /**
   * The five fixture checks on a probe source against its own parse (as JSON carries it). Its secrets: those the kit's
   * patterns find, every community name its parse has, and `extra` (a community named in a source the case cleared
   * it from), each one the source has.
   */
  const fixtureChecks = (name: string, source: string, extra: readonly string[] = []) => {
    const parsed = parse(source)
    const expectedModel = JSON.parse(JSON.stringify(parsed.model)) as Device
    const secrets = [...new Set([...findSecrets(source), ...communities(parsed.model), ...extra])].filter((v) => source.includes(v))
    const checks = checkFixture(plugin, { name, source, expectedModel, ...(secrets.length ? { secrets } : {}) }, { modelVersion, ...options })
    for (const r of checks) allowed.push(...(r.allowed ?? []))
    return checks.flatMap((r) => (r.status === 'failed' ? r.problems.map((p) => `${r.check}: ${p}`) : []))
  }

  // ---- 1. prototype keys
  const proto = adapter.prototypeKeys
  if (isNotApplicable(proto)) notApplicable('prototype-keys', 'all', proto)
  else {
    const places: Record<NameUse, readonly PathSegment[]> = {
      interface: ['interfaces'],
      vrf: ['networkInstances'],
      community: ['system', 'snmp', 'communities'],
      dns: ['system', 'dns'],
      vlan: ['vlans'],
      'bgp-group': ['networkInstances', 'default', 'bgp', 'groups']
    }
    /** Where the key is a value, not a key: a DNS name, a VLAN's name. */
    const asValue: ReadonlySet<NameUse> = new Set(['dns', 'vlan'])
    const given = (use: NameUse) => choice<true>(proto.uses, use)
    for (const use of NAME_USES) {
      const u = given(use)
      if (u !== NOT_GIVEN && isNotApplicable(u)) notApplicable('prototype-keys', `as ${USE_NAMES[use]}`, u)
    }
    const uses = NAME_USES.filter((use) => !isNotApplicable(given(use)))
    for (const key of PROTOTYPE_KEYS) {
      const before = snapshotPrototype()
      const problems: string[] = []
      try {
        // Twice: a polluted prototype would show on the second parse.
        for (let run = 0; run < 2; run++) {
          const source = proto.source(key)
          const parsed = parse(source)
          problems.push(...errors('parse', parsed))
          for (const use of uses) {
            const place = at(parsed.model, places[use])
            const found = asValue.has(use) ? contains(place, key) : isObject(place) && Object.hasOwn(place, key)
            if (!found && run === 0) problems.push(`${key} as ${use}: not an own key at ${show(places[use])}`)
          }
          render(parsed.model)
        }
        // The key as a community is a secret, and so wherever else the text has it (a VRF of the same name).
        problems.push(...fixtureChecks(`prototype key ${key}`, proto.source(key), uses.includes('community') ? [key] : []))
      } finally {
        const changes = prototypeChanges(before)
        problems.push(...changes)
        if (changes.length) restorePrototype(before)
      }
      add('prototype-keys', key, problems)
    }
  }

  // ---- 2. SNMP access never widens
  const snmp = adapter.snmpAccess
  if (isNotApplicable(snmp)) notApplicable('snmp-access', 'all', snmp)
  else {
    /** Problems with the communities of `model`: each one is limited to clients, or isn't there. */
    const widened = (step: string, model: Device) =>
      Object.entries((at(model, ['system', 'snmp', 'communities']) as Record<string, { clients?: readonly string[] }> | undefined) ?? {})
        .filter(([, c]) => !Array.isArray(c?.clients) || !c.clients.length)
        .map(() => `${step}: a community limited to some clients came out open to every client`)
    for (const access of ['read-only', 'read-write'] as const) {
      const source = snmp[access]
      const parsed = parse(source)
      const problems = [...errors('parse', parsed), ...widened('parse', parsed.model)]
      const rendered = render(parsed.model)
      problems.push(...widened('render → reparse', parse(rendered.text).model))
      problems.push(...fixtureChecks(`snmp ${access}`, source))
      // From the kit's own model, as another platform would give it: back exactly as given (its access and its
      // clients, no more), or left out and saying so on each field.
      const model: Device = { system: { snmp: { communities: { [PROBE_COMMUNITY]: { access, clients: PROBE_CLIENTS } } } } }
      const own = render(model)
      const ownReparse = parse(own.text)
      problems.push(...errors('render', own), ...errors('reparse', ownReparse), ...widened('render of a limited community → reparse', ownReparse.model))
      const community = ['system', 'snmp', 'communities', PROBE_COMMUNITY]
      const back = at(ownReparse.model, ['system', 'snmp', 'communities'])
      const others = isObject(back) ? Object.keys(back).filter((k) => k !== PROBE_COMMUNITY) : []
      if (others.length) problems.push(`render of a limited community → reparse: ${others.length} other communit${others.length === 1 ? 'y' : 'ies'} came back`)
      const fields = [fieldPath(...community, 'access'), fieldPath(...community, 'clients')]
      const came = at(ownReparse.model, community)
      if (came === undefined) {
        for (const field of fields) {
          const d = own.dispositions[field]
          if (!d) problems.push(`render: ${field} has no disposition`)
          else if (d.kind !== 'unsupported') problems.push(`render: ${field} is ${d.kind}, but the community isn't in the text`)
        }
      } else {
        const c = came as { access?: string; clients?: readonly string[] }
        if (c.access !== access) problems.push(`render of a limited community → reparse: its access is ${String(c.access)}, not ${access}`)
        const clients = Array.isArray(c.clients) ? [...c.clients].sort() : []
        if (JSON.stringify(clients) !== JSON.stringify([...PROBE_CLIENTS].sort())) problems.push(`render of a limited community → reparse: its clients are ${JSON.stringify(clients)}, not ${JSON.stringify(PROBE_CLIENTS)}`)
        for (const field of fields) if (own.dispositions[field]?.kind !== 'rendered') problems.push(`render: ${field} is ${own.dispositions[field]?.kind ?? 'without a disposition'}, but the community is in the text`)
      }
      add('snmp-access', access, problems)
    }
  }

  // ---- 3. negation clears state
  for (const kind of NEGATION_KINDS) {
    const c = choice<NegationCase>(adapter.negation, kind)
    if (c === NOT_GIVEN) continue
    if (isNotApplicable(c)) {
      notApplicable('negation', kind, c)
      continue
    }
    const set = parse(c.set)
    const negated = parse(c.negated)
    const problems = [...errors('parse', set), ...errors('parse', negated)]
    if (at(set.model, c.path) === undefined) problems.push(`the case's set source has nothing at ${show(c.path)}`)
    if (at(negated.model, c.path) !== undefined) problems.push(`parse: ${show(c.path)} is still in the model after it was cleared`)
    const reparsed = parse(render(negated.model).text)
    if (at(reparsed.model, c.path) !== undefined) problems.push(`render → reparse: ${show(c.path)} is back after it was cleared`)
    problems.push(...fixtureChecks(`negation ${kind}`, c.negated, communities(set.model)))
    add('negation', kind, problems)
  }

  // ---- 4. malformed values are flagged, not mapped
  for (const kind of MALFORMED_KINDS) {
    const c = choice<MalformedCase>(adapter.malformed, kind)
    if (c === NOT_GIVEN) continue
    if (isNotApplicable(c)) {
      notApplicable('malformed', kind, c)
      continue
    }
    const parsed = parse(c.source)
    const problems: string[] = []
    const lines = c.line !== undefined ? [c.line] : c.source.split(/\r\n?|\n/).flatMap((text, i) => (text.includes(c.value) ? [i + 1] : []))
    if (!lines.length) problems.push('the case\'s value isn\'t in its source')
    const flagged = parsed.diagnostics.some((d) => d.severity === 'error')
    if (!flagged) {
      if (contains(parsed.model, c.value)) problems.push('parse: the malformed value is in the model')
      const statements = statementsOf(parsed.tree)
      for (const n of statements) {
        const disposition = parsed.dispositions[n.id]?.kind
        if (!n.span || !lines.includes(n.span.startLine)) continue
        if (disposition === 'mapped') problems.push(`parse: ${n.id} on the malformed value's line is mapped`)
        // Malformed isn't by design: it is what can't be converted.
        if (disposition === 'ignored-by-design') problems.push(`parse: ${n.id} on the malformed value's line is ignored by design, not flagged`)
      }
      // Evidence it was flagged: a statement on its line (or one spanning it), unsupported. Gone without a word fails.
      const covering = statements.filter((n) => n.span && lines.some((l) => n.span!.startLine <= l && l <= n.span!.endLine))
      if (!covering.some((n) => parsed.dispositions[n.id]?.kind === 'unsupported')) problems.push('parse: the malformed value is flagged nowhere: no error, and no unsupported statement on its line')
      problems.push(...fixtureChecks(`malformed ${kind}`, c.source))
    }
    add('malformed', kind, problems)
  }

  // ---- 5. VRF scoping
  for (const kind of SCOPING_KINDS) {
    const c = choice<ScopingCase>(adapter.vrfScoping, kind)
    if (c === NOT_GIVEN) continue
    if (isNotApplicable(c)) {
      notApplicable('vrf-scoping', kind, c)
      continue
    }
    const base = parse(c.base)
    const changed = parse(c.changed)
    const problems = [...errors('parse', base), ...errors('parse', changed)]
    /**
     * Whether a path is the VRF's: under its network instance, or under an entry that belongs to it. An entry the base
     * has belongs where the base puts it (no `networkInstance`: the global table), so a change can't move another
     * VRF's entry into this one and make its edits look in scope; a new entry belongs where the change puts it.
     */
    const inScope = (path: readonly PathSegment[]) => {
      if (path[0] === 'networkInstances') return path[1] === c.vrf
      for (let i = path.length; i > 0; i--) {
        const prefix = path.slice(0, i)
        const was = at(base.model, prefix)
        const now = at(changed.model, prefix)
        const owns = (v: unknown) => isObject(v) && Object.hasOwn(v, 'networkInstance')
        if (isObject(was) && (owns(was) || owns(now))) return was.networkInstance === c.vrf
        if (was === undefined && owns(now)) return (now as Record<string, unknown>).networkInstance === c.vrf
      }
      return false
    }
    const a = new Map(leaves(base.model).map((l) => [JSON.stringify(l.path), l]))
    const b = new Map(leaves(changed.model).map((l) => [JSON.stringify(l.path), l]))
    const differing = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k)?.value !== b.get(k)?.value).map((k) => (a.get(k) ?? b.get(k))!.path)
    if (!differing.length) problems.push('the case changes nothing in the model')
    for (const path of differing) if (!inScope(path)) problems.push(`a change in VRF ${c.vrf} changed ${show(path)}, outside it`)
    problems.push(...fixtureChecks(`vrf scoping ${kind}`, c.changed))
    add('vrf-scoping', kind, problems)
  }
  return results
}
