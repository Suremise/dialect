// Convert mode: a source plugin's parse → the shared model → a target plugin's render, with the interface map between
// them. Interface names never map silently: every interface the model names, as a key or as a reference (a next hop's
// interface, a source interface, an OSPF interface, a BGP update source), is a needs-input item until the user names it
// on the target. Plugins that describe and name ports (PortName) give suggestions, marked as such. Plain strings and
// objects, as everywhere in the core.
import { buildLedger, statementsOf, type CoverageLedger } from './ledger'
import type { Bgp, BgpPeer, Device, Interface, InterfaceType, NetworkInstance, Ospf, StaticRoute, System } from './model'
import { fieldPath, pathSegments } from './paths'
import type { PlatformPlugin } from './plugin'
import type { Context, Diagnostic, NeedsInput, ParseResult, RenderResult, Span, SyntaxNode } from './results'

/** The user's names for interfaces on the target: source name → target name (`ge-0/0/0` → `GigabitEthernet0/0/0`). */
export type InterfaceMap = Readonly<Record<string, string>>

/**
 * What an interface's name says about the port, in no platform's words, so another platform can suggest its own name
 * for it: `ge-1/0/3` is a 1000 Mb/s Ethernet port numbered 1, 0, 3.
 */
export interface PortName {
  readonly type: InterfaceType
  /** An Ethernet port's speed in Mb/s, when its name says it. */
  readonly speed?: number
  /** The numbers in the name, as the platform writes them: `ge-1/0/3` → [1, 0, 3], `lo0` → [0], `xe-0/0/0:2` → [0, 0, 0, 2]. */
  readonly numbers: readonly number[]
}

/** The needs-input id for an interface's name on the target. */
export function interfaceInputId(name: string): string {
  return `interface:${name}`
}

/** An interface map as needs-input answers (Context.inputs). */
export function interfaceInputs(map: InterfaceMap): Record<string, string> {
  const inputs: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [from, to] of Object.entries(map)) inputs[interfaceInputId(from)] = to
  return inputs
}

/** `ge-0/0/0.10` → `ge-0/0/0` and `10`; null for a name with no subinterface index. */
function splitReference(ref: string): { base: string; index: string } | null {
  const m = /^(.+)\.(\d+)$/.exec(ref)
  return m ? { base: m[1], index: m[2] } : null
}

/** A routed VLAN interface (Junos `irb` and EX `vlan`, Cisco `VlanN`), whose subinterfaces each route for a VLAN. */
const routesVlans = (i: Interface | undefined) => i?.type === 'irb-or-svi' || i?.type === 'vlan'

/**
 * Whether an interface is named unit by unit (#80): a routed VLAN interface with units other than a lone `0` (Junos
 * `irb` with units 100 and 200), whose units become separate interfaces on a target that has one per VLAN (Cisco
 * `Vlan100`, `Vlan200`). Its rows are `irb.100` and `irb.200`, never `irb`.
 */
function byUnit(i: Interface | undefined): boolean {
  const units = Object.keys(i?.subinterfaces ?? {})
  return routesVlans(i) && units.length > 0 && !(units.length === 1 && units[0] === '0')
}

/**
 * Where the model names an interface by reference, not as a top-level key: the value is `name` or
 * `name.<subinterface>`, at a leaf (a next hop's interface) or as the key of an entry (an OSPF interface), whose path
 * is the entry's.
 */
function references(model: Device): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  const ntp = model.system?.ntp?.sourceInterface
  if (ntp !== undefined) out.push({ path: fieldPath('system', 'ntp', 'sourceInterface'), value: ntp })
  const logging = model.system?.logging?.sourceInterface
  if (logging !== undefined) out.push({ path: fieldPath('system', 'logging', 'sourceInterface'), value: logging })
  for (const [instance, ni] of Object.entries(model.networkInstances ?? {})) {
    for (const [prefix, route] of Object.entries(ni.staticRoutes ?? {}))
      for (const [index, hop] of Object.entries(route.nextHops ?? {}))
        if (hop.interface !== undefined) out.push({ path: fieldPath('networkInstances', instance, 'staticRoutes', prefix, 'nextHops', index, 'interface'), value: hop.interface })
    for (const [area, a] of Object.entries(ni.ospf?.areas ?? {}))
      for (const ref of Object.keys(a.interfaces ?? {})) out.push({ path: fieldPath('networkInstances', instance, 'ospf', 'areas', area, 'interfaces', ref), value: ref })
    for (const kind of ['groups', 'neighbors'] as const)
      for (const [key, peer] of Object.entries(ni.bgp?.[kind] ?? {}))
        if (peer.updateSource !== undefined) out.push({ path: fieldPath('networkInstances', instance, 'bgp', kind, key, 'updateSource'), value: peer.updateSource })
  }
  return out
}

/** One row of the interface map: a whole interface, or one unit of an interface named unit by unit (`irb.100`). */
interface Row {
  /** The row's name, the interface map's key: `ge-0/0/0`, `irb.100`. */
  readonly name: string
  /** The model's interface (or, for one only referenced, the name its references give). */
  readonly ifc: string
  /** The unit, for a row of one. */
  readonly unit?: string
}

/** The model's rows, in order: its interfaces (unit by unit for those named so), then interfaces only referenced. */
function rows(model: Device): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  const add = (row: Row) => {
    if (!seen.has(row.name)) out.push(row)
    seen.add(row.name)
  }
  for (const [name, i] of Object.entries(model.interfaces ?? {})) {
    if (byUnit(i)) for (const unit of Object.keys(i.subinterfaces ?? {})) add({ name: `${name}.${unit}`, ifc: name, unit })
    else add({ name, ifc: name })
  }
  const keys = new Set(Object.keys(model.interfaces ?? {}))
  for (const r of references(model)) add(rowOf(model, r.value, keys))
  return out
}

/** The row a reference (`name` or `name.<subinterface>`) belongs to. */
function rowOf(model: Device, ref: string, keys: ReadonlySet<string>): Row {
  const split = splitReference(ref)
  if (keys.has(ref)) return { name: ref, ifc: ref }
  if (split && keys.has(split.base)) {
    const i = model.interfaces![split.base]
    return byUnit(i) && Object.hasOwn(i.subinterfaces ?? {}, split.index) ? { name: ref, ifc: split.base, unit: split.index } : { name: split.base, ifc: split.base }
  }
  const name = split?.base ?? ref
  return { name, ifc: name }
}

/**
 * Every row of the interface map the model needs, in order: its interfaces, then interfaces only referenced (`st0.0` →
 * `st0`). A routed VLAN interface with units other than a lone `0` is named unit by unit (`irb.100`, `irb.200`), since a
 * target may give each its own interface (`Vlan100`, `Vlan200`).
 */
export function modelInterfaces(model: Device): string[] {
  return rows(model).map((r) => r.name)
}

/** Where a source interface's parts go on the target: its own leaves, and each subinterface as a target's unit. */
interface Placement {
  /** The target interface that takes the source's own leaves, for each target it goes to. */
  readonly targets: readonly string[]
  /** By source unit: the target interface and unit. */
  readonly units: ReadonlyMap<string, readonly [string, string]>
  /** For a source with no units of its own (a reference only): its target. */
  readonly whole?: string
  /**
   * A Cisco SVI named as a unit (`Vlan100` → `irb.100`): its description and whether it is enabled move to the unit,
   * where the target says them for each VLAN.
   */
  readonly toUnit: boolean
}

/** The model with interfaces placed by `names`, and how to trace its paths and references back. */
interface Placed {
  readonly model: Device
  /** The source path of a renamed model's path (`interfaces.Vlan100.subinterfaces["0"]…` → `interfaces.irb.subinterfaces["100"]…`). */
  readonly sourcePath: (path: string) => string
  /** A reference renamed: `irb.100` → `Vlan100.0`. */
  readonly ref: (value: string) => string
  /** The rows whose names would put two things in one place (one interface name, one unit), each group a clash. */
  readonly clashes: readonly (readonly string[])[]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Places the model's interfaces by `names` (row → target name). A whole interface's answer renames it, as before. A
 * unit's answer (`irb.100` → `Vlan100`) makes that unit the target interface's unit `0`, or with an index
 * (`Vlan100` → `irb.100`, `irb.100` → `irb.100`) that unit of it; units of one target from several sources merge when
 * their interfaces' own leaves agree. Every other overlap is a clash: two rows at one interface name, or one unit.
 */
function place(model: Device, names: InterfaceMap): Placed {
  const has = (name: string) => Object.hasOwn(names, name)
  const interfaces = model.interfaces ?? {}
  const keys = new Set(Object.keys(interfaces))
  const placements = new Map<string, Placement>()
  /** Which rows put something at each target interface, and whether each can share it with another source. */
  const users = new Map<string, { row: string; source: string; shares: boolean }[]>()
  const use = (target: string, row: string, source: string, shares: boolean) => users.set(target, [...(users.get(target) ?? []), { row, source, shares }])
  /** Which rows put a unit at each target interface and unit. */
  const unitUsers = new Map<string, string[]>()
  for (const [name, i] of Object.entries(interfaces)) {
    const units = Object.keys(i.subinterfaces ?? {})
    if (byUnit(i)) {
      const placed = new Map<string, readonly [string, string]>()
      for (const unit of units) {
        const row = `${name}.${unit}`
        const to = has(row) ? names[row] : undefined
        const split = to !== undefined ? splitReference(to) : null
        placed.set(unit, to === undefined ? [name, unit] : split ? [split.base, split.index] : [to, '0'])
      }
      const targets = [...new Set([...placed.values()].map(([t]) => t))]
      placements.set(name, { targets, units: placed, toUnit: false })
      for (const [unit, [t]] of placed) use(t, `${name}.${unit}`, name, true)
      continue
    }
    const to = has(name) ? names[name] : undefined
    const split = to !== undefined && routesVlans(i) && units.every((u) => u === '0') ? splitReference(to) : null
    if (split) {
      placements.set(name, { targets: [split.base], units: new Map(units.map((u) => [u, [split.base, split.index] as const])), toUnit: true })
      use(split.base, name, name, true)
    } else {
      const t = to ?? name
      placements.set(name, { targets: [t], units: new Map(units.map((u) => [u, [t, u] as const])), toUnit: false })
      use(t, name, name, false)
    }
  }
  for (const r of rows(model))
    if (!keys.has(r.ifc) && !placements.has(r.ifc)) {
      const t = has(r.name) ? names[r.name] : r.name
      placements.set(r.ifc, { targets: [], units: new Map(), whole: t, toUnit: false })
      use(t, r.name, r.ifc, false)
    }
  for (const [source, p] of placements) for (const [unit, [t, u]] of p.units) unitUsers.set(JSON.stringify([t, u]), [...(unitUsers.get(JSON.stringify([t, u])) ?? []), byUnit(interfaces[source]) ? `${source}.${unit}` : source])

  /** The leaves a source interface keeps at a target: its own, less its units, and less what moves to a unit. */
  const own = (source: string, p: Placement): Record<string, unknown> => {
    const { subinterfaces: _s, ...rest } = interfaces[source] ?? {}
    if (!p.toUnit) return rest
    const { description: _d, enabled: _e, ...kept } = rest
    return kept
  }
  // Clashes: a target interface used by rows of two sources that can't share it (a whole interface, or own leaves
  // that differ), or one unit used twice.
  const clashes: string[][] = []
  for (const list of users.values()) {
    const sources = [...new Set(list.map((u) => u.source))]
    if (sources.length < 2) continue
    const ownLeaves = sources.map((s) => (placements.get(s)!.whole !== undefined ? null : own(s, placements.get(s)!)))
    if (list.some((u) => !u.shares) || ownLeaves.some((l) => l === null || !same(l, ownLeaves[0]))) clashes.push([...new Set(list.map((u) => u.row))])
  }
  for (const group of unitUsers.values()) if (group.length > 1) clashes.push([...new Set(group)])

  // The placed interfaces, and each placed path's source.
  const back = new Map<string, readonly string[]>()
  const placed = Object.create(null) as Record<string, Interface>
  const build = (target: string): Record<string, unknown> => {
    if (!Object.hasOwn(placed, target)) placed[target] = Object.create(null) as Interface
    return placed[target] as unknown as Record<string, unknown>
  }
  for (const [source, p] of placements) {
    if (p.whole !== undefined || !Object.hasOwn(interfaces, source)) continue
    const i = interfaces[source]
    for (const target of p.targets) {
      const out = build(target)
      if (!back.has(JSON.stringify([target]))) back.set(JSON.stringify([target]), ['interfaces', source])
      for (const [leaf, value] of Object.entries(own(source, p))) {
        if (!Object.hasOwn(out, leaf)) out[leaf] = value
        if (!back.has(JSON.stringify([target, leaf]))) back.set(JSON.stringify([target, leaf]), ['interfaces', source, leaf])
      }
    }
    for (const [unit, [target, to]] of p.units) {
      const out = build(target)
      const subs = (Object.hasOwn(out, 'subinterfaces') ? out.subinterfaces : (out.subinterfaces = Object.create(null))) as Record<string, unknown>
      const sub = i.subinterfaces![unit]
      // A Cisco SVI's description and state go to its unit, unless the unit says its own.
      const moved: Record<string, unknown> = {}
      if (p.toUnit)
        for (const leaf of ['description', 'enabled'] as const)
          if (i[leaf] !== undefined && sub[leaf] === undefined) {
            moved[leaf] = i[leaf]
            back.set(JSON.stringify([target, 'subinterfaces', to, leaf]), ['interfaces', source, leaf])
          }
      subs[to] = { ...sub, ...moved }
      back.set(JSON.stringify([target, 'subinterfaces', to]), ['interfaces', source, 'subinterfaces', unit])
    }
  }

  const ref = (value: string): string => {
    const split = splitReference(value)
    if (keys.has(value)) {
      const p = placements.get(value)!
      if (p.toUnit) {
        const [t, u] = p.units.get('0') ?? [p.targets[0], '0']
        return `${t}.${u}`
      }
      return p.targets[0] ?? value
    }
    if (split && keys.has(split.base)) {
      const at = placements.get(split.base)!.units.get(split.index)
      return at ? `${at[0]}.${at[1]}` : `${placements.get(split.base)!.targets[0]}.${split.index}`
    }
    const whole = placements.get(split?.base ?? value)?.whole
    if (whole === undefined) return value
    return split ? `${whole}.${split.index}` : whole
  }
  const sourcePath = (path: string): string => {
    const s = pathSegments(path)
    if (s[0] !== 'interfaces' || typeof s[1] !== 'string') return path
    // The longest placed prefix: a unit's leaf moved from its SVI, the unit, the interface's own leaf.
    for (const n of [4, 3, 2, 1]) {
      const key = JSON.stringify(s.slice(1, n + 1))
      const was = back.get(key)
      if (was) return fieldPath(...was, ...s.slice(n + 1))
    }
    return path
  }
  return { model: { ...model, ...(model.interfaces ? { interfaces: placed } : {}) }, sourcePath, ref, clashes }
}

/**
 * The OSPF interface references that would have one name after renaming by `ref`, by area: each clash as its source
 * keys, with the area's instance and ID. A rename that made two one would lose one area entry.
 */
function ospfClashes(model: Device, ref: (value: string) => string): { instance: string; area: string; keys: string[] }[] {
  const out: { instance: string; area: string; keys: string[] }[] = []
  for (const [instance, ni] of Object.entries(model.networkInstances ?? {}))
    for (const [area, a] of Object.entries(ni.ospf?.areas ?? {})) {
      const byName = new Map<string, string[]>()
      for (const k of Object.keys(a.interfaces ?? {})) byName.set(ref(k), [...(byName.get(ref(k)) ?? []), k])
      for (const group of byName.values()) if (group.length > 1) out.push({ instance, area, keys: group })
    }
  return out
}

/** A null-prototype copy of a keyed map, keys renamed (configuration keys can be `__proto__`: model.ts). */
function keyed<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>
  for (const [k, v] of entries) out[k] = v
  return out
}

/** The model with references renamed by `ref`, and `interfaces` as placed. */
function withReferences(model: Device, interfaces: Device['interfaces'], ref: (value: string) => string): Device {
  const system = model.system && {
    ...model.system,
    ...(model.system.ntp?.sourceInterface !== undefined ? { ntp: { ...model.system.ntp, sourceInterface: ref(model.system.ntp.sourceInterface) } } : {}),
    ...(model.system.logging?.sourceInterface !== undefined ? { logging: { ...model.system.logging, sourceInterface: ref(model.system.logging.sourceInterface) } } : {})
  }
  const route = (r: StaticRoute): StaticRoute =>
    r.nextHops ? { ...r, nextHops: keyed(Object.entries(r.nextHops).map(([i, hop]) => [i, hop.interface !== undefined ? { ...hop, interface: ref(hop.interface) } : hop] as const)) } : r
  const ospf = (o: Ospf): Ospf =>
    o.areas ? { ...o, areas: keyed(Object.entries(o.areas).map(([id, a]) => [id, a.interfaces ? { ...a, interfaces: keyed(Object.entries(a.interfaces).map(([r, i]) => [ref(r), i] as const)) } : a] as const)) } : o
  const peers = <T extends BgpPeer>(map: Readonly<Record<string, T>>) => keyed(Object.entries(map).map(([k, p]) => [k, p.updateSource !== undefined ? { ...p, updateSource: ref(p.updateSource) } : p] as const))
  const bgp = (b: Bgp): Bgp => ({ ...b, ...(b.groups ? { groups: peers(b.groups) } : {}), ...(b.neighbors ? { neighbors: peers(b.neighbors) } : {}) })
  const instance = (ni: NetworkInstance): NetworkInstance => ({
    ...ni,
    ...(ni.staticRoutes ? { staticRoutes: keyed(Object.entries(ni.staticRoutes).map(([p, r]) => [p, route(r)] as const)) } : {}),
    ...(ni.ospf ? { ospf: ospf(ni.ospf) } : {}),
    ...(ni.bgp ? { bgp: bgp(ni.bgp) } : {})
  })
  return {
    ...model,
    ...(system ? { system: system as System } : {}),
    ...(interfaces ? { interfaces } : {}),
    ...(model.networkInstances ? { networkInstances: keyed(Object.entries(model.networkInstances).map(([n, ni]) => [n, instance(ni)] as const)) } : {})
  }
}

/**
 * The model with interfaces renamed by `names` (a row of the interface map → its target name), as keys and in
 * references. A unit's row (`irb.100` → `Vlan100`) makes it its own interface's unit `0`, or with an index the target's
 * unit of that number (`Vlan100` → `irb.100`). Others are kept. Throws when two interfaces would end up with one name
 * (or one unit), or two OSPF interfaces of an area with one reference (`eth0` → `Gig0.0` beside `eth1.0` with `eth1` →
 * `Gig0`): one would replace the other. convert() refuses such answers first.
 */
export function renameInterfaces(model: Device, names: InterfaceMap): Device {
  const placed = place(model, names)
  // No name in the message: an interface's name can be a secret's value reused (AGENTS.md).
  if (placed.clashes.length) throw new Error('Two interfaces would have one name: refused, so neither is lost.')
  if (ospfClashes(model, placed.ref).length) throw new Error('Two OSPF interfaces of an area would have one name: refused, so neither is lost.')
  return withReferences(model, placed.model.interfaces, placed.ref)
}

/**
 * One row of a conversion's interface map: an interface (or a unit of one named unit by unit, `irb.100`) by its name on
 * the source, the user's name for it on the target, and a suggestion.
 */
export interface InterfaceName {
  /** `ge-0/0/0`, or a unit's `irb.100`. */
  readonly source: string
  /** The needs-input id that answers it. */
  readonly inputId: string
  /** The user's answer; absent while unanswered (or refused: see the conversion's diagnostics). */
  readonly target?: string
  /** The target plugin's suggestion, when it has one: never used until the user takes it. */
  readonly suggestion?: string
  /** The source statement that configures or names it. */
  readonly statement?: string
}

/** A source statement that didn't fully carry over, for the source gutter and the warnings panel. */
export interface ConversionIssue {
  readonly statement: string
  readonly span?: Span
  /**
   * `unmapped`: the source plugin gave it no disposition. `unsupported`: the source plugin doesn't convert it.
   * `not-rendered`: it reached the model, but the target can't write part of it (or gave that part no disposition).
   */
  readonly kind: 'unmapped' | 'unsupported' | 'not-rendered'
  /** Why, in the plugin's words: never the statement's own text, which may hold a secret. */
  readonly reason?: string
}

export interface Conversion {
  readonly parse: ParseResult
  /** What was rendered: the parse's model with the answered interfaces renamed. */
  readonly model: Device
  /** Absent when the parse failed (an error diagnostic), so there was nothing sound to render. */
  readonly render?: RenderResult
  /** The coverage ledger; its needs-input items start with the interfaces. */
  readonly ledger: CoverageLedger
  readonly interfaces: readonly InterfaceName[]
  /** Needs-input items the inputs don't answer. */
  readonly unanswered: readonly NeedsInput[]
  /** By source statement, what didn't fully carry over, in tree order. */
  readonly issues: readonly ConversionIssue[]
  /**
   * Which source statement each part of the output came from: a statement and the output span of a field it filled,
   * one per pair, for linking the source and output panes (display only, like every span).
   */
  readonly links: readonly OutputLink[]
}

export interface OutputLink {
  readonly statement: string
  readonly output: Span
}

export interface ConvertOptions {
  /** Answers to needs-input items by id: an interface's is `interfaceInputs(map)`. */
  readonly inputs?: Readonly<Record<string, string>>
  /** The core's MODEL_VERSION, passed to the plugins. */
  readonly modelVersion: string
}

/** For each mapped statement of the tree, the field paths of its own disposition. */
function statementFields(parse: ParseResult): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  for (const n of statementsOf(parse.tree)) {
    const d = Object.hasOwn(parse.dispositions, n.id) ? parse.dispositions[n.id] : undefined
    if (d?.kind === 'mapped') out.set(n.id, d.fields)
  }
  return out
}

/**
 * The statement to show for an interface (or a unit) whose fields are under `prefix`: the outermost statement whose
 * mapped fields all belong to it (the Junos `ge-0/0/0 { … }` block, not the `interfaces` block around it), or the
 * first that names it by reference. For a unit, its interface's own leaves (`interfaces.irb.type`, which Junos maps
 * with each unit) belong to it too, but not its other units: the Junos `unit 100 { … }` block.
 */
function interfaceStatement(tree: readonly SyntaxNode[], fields: Map<string, readonly string[]>, prefix: string, referencedAt: ReadonlySet<string>, ofInterface?: string): string | undefined {
  const under = (f: string, p: string) => f === p || f.startsWith(`${p}.`) || f.startsWith(`${p}[`)
  const unit = (f: string) => under(f, prefix)
  const own = (f: string) => unit(f) || (ofInterface !== undefined && under(f, ofInterface) && !under(f, `${ofInterface}.subinterfaces`))
  const subtree = (n: SyntaxNode): string[] => [...(fields.get(n.id) ?? []), ...(n.children ?? []).flatMap(subtree)]
  const find = (nodes: readonly SyntaxNode[]): string | undefined => {
    for (const n of nodes) {
      const all = subtree(n)
      if (all.length && all.every(own) && all.some(unit)) return n.id
      if (all.some(unit)) return find(n.children ?? [])
    }
    return undefined
  }
  const at = (f: string) => [...referencedAt].some((r) => f === r || f.startsWith(`${r}.`) || f.startsWith(`${r}[`))
  return find(tree) ?? statementsOf(tree).find((n) => (fields.get(n.id) ?? []).some(at))?.id
}

/**
 * Converts `text` from `source`'s platform to `target`'s: parse, rename the answered interfaces, render, and the
 * ledger over both. The interfaces are needs-input items whether or not a suggestion exists; one left unanswered keeps
 * its source name in the render, and is listed in `unanswered`.
 */
export function convert(source: PlatformPlugin, target: PlatformPlugin, text: string, options: ConvertOptions): Conversion {
  if (!source.parse) throw new Error(`Plugin "${source.id}" can't parse.`)
  if (!target.render) throw new Error(`Plugin "${target.id}" can't render.`)
  const inputs = options.inputs ?? {}
  const context: Context = { modelVersion: options.modelVersion, inputs }
  const parse = source.parse(text, context)
  const fields = statementFields(parse)
  const answer = (id: string) => (Object.hasOwn(inputs, id) && inputs[id].trim() !== '' ? inputs[id].trim() : undefined)

  // The interface map's rows (an interface, or a unit of one named unit by unit), where each is configured or named,
  // and the user's answers.
  const all = rows(parse.model)
  const names = all.map((r) => r.name)
  const keys = new Set(Object.keys(parse.model.interfaces ?? {}))
  const refs = references(parse.model)
  const rowPath = (r: Row) => (r.unit !== undefined ? fieldPath('interfaces', r.ifc, 'subinterfaces', r.unit) : fieldPath('interfaces', r.name))
  const statements = new Map(
    all.map((r) => {
      const referencedAt = new Set(refs.filter((ref) => rowOf(parse.model, ref.value, keys).name === r.name).map((ref) => ref.path))
      return [r.name, interfaceStatement(parse.tree, fields, rowPath(r), referencedAt, r.unit !== undefined ? fieldPath('interfaces', r.ifc) : undefined)] as const
    })
  )
  const spans = new Map(statementsOf(parse.tree).map((node) => [node.id, node.span]))
  const answers = new Map(names.map((n) => [n, answer(interfaceInputId(n))]))

  // Two interfaces with one name on the target would become one, the second replacing the first. Every name counts,
  // the answers and the source names that unanswered interfaces keep: the answers in a clash are refused (unanswered),
  // which leaves each its source name, and those are distinct. The same for two OSPF interfaces of an area whose
  // references the answers would make one (`eth0` → `Gig0.0` beside `eth1.0` with `eth1` → `Gig0`): the answers of the
  // interfaces they name are refused. The message gives lines, never names: an interface's name can be a secret's value
  // reused, and diagnostics reach stderr and logs (AGENTS.md).
  const diagnostics: Diagnostic[] = []
  /** The statement that configures an OSPF interface: the first whose mapped fields are its entry's. */
  const ospfStatement = (instance: string, area: string, key: string) => {
    const entry = fieldPath('networkInstances', instance, 'ospf', 'areas', area, 'interfaces', key)
    return statementsOf(parse.tree).find((n) => (fields.get(n.id) ?? []).some((f) => f === entry || f.startsWith(`${entry}.`) || f.startsWith(`${entry}[`)))?.id
  }
  const refuse = (what: string, group: readonly string[], at: readonly (string | undefined)[]) => {
    const where = at.flatMap((id) => {
      const span = spans.get(id ?? '')
      return span ? [span] : []
    })
    const lineNumbers = [...new Set(where.map((sp) => sp.startLine))].sort((a, b) => a - b)
    const lines = lineNumbers.length ? ` (line${lineNumbers.length > 1 ? 's' : ''} ${lineNumbers.join(', ')})` : ''
    const first = at.find((id) => id !== undefined)
    diagnostics.push({
      severity: 'error',
      category: 'other',
      code: 'convert.interface-name-taken',
      message: `${at.length} ${what} would have one name on ${target.name}${lines}: give each its own.`,
      ...(where[0] ? { span: where[0] } : {}),
      ...(first ? { statement: first } : {})
    })
    for (const n of group) answers.set(n, undefined)
  }
  const answeredMap = () => {
    const answered: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [n, to] of answers) if (to !== undefined) answered[n] = to
    return answered
  }
  for (;;) {
    // Rows left unanswered keep their own (distinct) places, so a clash always has an answered row to refuse.
    const placed = place(parse.model, answeredMap())
    const clashes = placed.clashes.filter((group) => group.some((n) => answers.get(n) !== undefined))
    for (const group of clashes) refuse('interfaces', group, group.map((n) => statements.get(n)))
    if (clashes.length) continue
    const ospf = ospfClashes(parse.model, placed.ref)
      .map((c) => ({ ...c, interfaces: [...new Set(c.keys.map((k) => rowOf(parse.model, k, keys).name))].filter((n) => answers.get(n) !== undefined) }))
      .filter((c) => c.interfaces.length)
    for (const c of ospf) refuse('OSPF interfaces', c.interfaces, c.keys.map((k) => ospfStatement(c.instance, c.area, k)))
    if (!ospf.length) break
  }
  /**
   * What a row's name says, for the target's suggestion: a routed VLAN interface or unit by the VLAN it routes for
   * (`irb.100` and Cisco's `Vlan100` are VLAN 100's), any other interface as the source plugin describes it.
   */
  const portOf = (r: Row): PortName | undefined => {
    const i = keys.has(r.ifc) ? parse.model.interfaces![r.ifc] : undefined
    const subs = i?.subinterfaces ?? {}
    const unit = r.unit ?? (Object.keys(subs).length === 1 && Object.hasOwn(subs, '0') ? '0' : undefined)
    const vlan = routesVlans(i) && unit !== undefined ? subs[unit]?.routedVlan : undefined
    if (vlan !== undefined) return { type: 'irb-or-svi', numbers: [vlan] }
    return r.unit === undefined ? source.describeInterface?.(r.name) : undefined
  }
  const interfaces = all.map((r): InterfaceName => {
    const port = portOf(r)
    const suggestion = port ? target.nameInterface?.(port) : undefined
    const statement = statements.get(r.name)
    const to = answers.get(r.name)
    return { source: r.name, inputId: interfaceInputId(r.name), ...(to !== undefined ? { target: to } : {}), ...(suggestion ? { suggestion } : {}), ...(statement ? { statement } : {}) }
  })
  const needsInput = all.map((r, index): NeedsInput => {
    const i = interfaces[index]
    return {
      id: i.inputId,
      kind: 'interface-name',
      // Which interface is said by `statement` and `field`, not in words (a name can be a reused secret).
      message: `Name this interface on ${target.name}.`,
      ...(keys.has(r.ifc) ? { field: rowPath(r) } : {}),
      ...(i.statement ? { statement: i.statement } : {}),
      ...(i.suggestion ? { suggestions: [i.suggestion] } : {})
    }
  })

  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const i of interfaces) if (i.target !== undefined) map[i.source] = i.target
  const model = renameInterfaces(parse.model, map)
  const failed = parse.diagnostics.some((d) => d.severity === 'error')
  const render = failed ? undefined : target.render(model, context)
  const built = buildLedger(parse, render, model)
  const ledger: CoverageLedger = { ...built, diagnostics: [...built.diagnostics, ...diagnostics], needsInput: [...needsInput, ...built.needsInput] }
  const named = new Set(interfaces.filter((i) => i.target !== undefined).map((i) => i.inputId))
  const unanswered = [...needsInput.filter((item) => !named.has(item.id)), ...built.needsInput.filter((item) => answer(item.id) === undefined)]
  const placed = place(parse.model, map)
  return { parse, model, ...(render ? { render } : {}), ledger, interfaces, unanswered, ...sourceSide(ledger, placed.sourcePath, ospfKeys(parse.model, placed.ref)) }
}

/**
 * For each OSPF area, by its instance and ID, its interface keys after renaming → before (`GigabitEthernet0/0/0.0` →
 * `ge-0/0/0.0`), from the rename itself, which never makes two keys of an area one.
 */
function ospfKeys(model: Device, ref: (value: string) => string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  for (const [instance, ni] of Object.entries(model.networkInstances ?? {}))
    for (const [area, a] of Object.entries(ni.ospf?.areas ?? {})) out.set(JSON.stringify([instance, area]), new Map(Object.keys(a.interfaces ?? {}).map((k) => [ref(k), k])))
  return out
}

/** By source statement: what didn't fully carry over (one issue per statement and reason), and where its fields went. */
function sourceSide(ledger: CoverageLedger, placedPath: (path: string) => string, ospf: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): Pick<Conversion, 'issues' | 'links'> {
  // The render's fields are the renamed model's: back to the parse's names (and units), to find the statement that
  // filled each.
  const sourcePath = (path: string) => {
    const s = pathSegments(placedPath(path))
    // networkInstances.<instance>.ospf.areas.<area>.interfaces.<reference>…
    if (s[0] === 'networkInstances' && s[2] === 'ospf' && s[3] === 'areas' && s[5] === 'interfaces' && typeof s[6] === 'string') {
      const was = ospf.get(JSON.stringify([s[1], s[4]]))?.get(s[6])
      if (was !== undefined) s[6] = was
    }
    return fieldPath(...s)
  }
  const rendered = new Map<string, Span>()
  for (const f of ledger.target?.fields ?? []) if (f.disposition?.kind === 'rendered' && f.disposition.span) rendered.set(sourcePath(f.path), f.disposition.span)
  const links: OutputLink[] = []
  const notRendered = new Map<string, string | undefined>()
  for (const f of ledger.target?.fields ?? []) {
    if (f.disposition === null) notRendered.set(sourcePath(f.path), 'the target plugin gave it no disposition')
    else if (f.disposition.kind === 'unsupported') notRendered.set(sourcePath(f.path), f.disposition.reason)
  }
  const out: ConversionIssue[] = []
  const seen = new Set<string>()
  const add = (issue: ConversionIssue) => {
    const key = `${issue.statement}\0${issue.kind}\0${issue.reason ?? ''}`
    if (!seen.has(key)) out.push(issue)
    seen.add(key)
  }
  for (const s of ledger.source.statements) {
    const span = s.span ? { span: s.span } : {}
    if (s.disposition === null) add({ statement: s.id, ...span, kind: 'unmapped' })
    else if (s.disposition.kind === 'unsupported') add({ statement: s.id, ...span, kind: 'unsupported', ...(s.disposition.reason ? { reason: s.disposition.reason } : {}) })
    else if (s.disposition.kind === 'mapped')
      for (const f of s.disposition.fields) {
        const output = rendered.get(f)
        if (output) links.push({ statement: s.id, output })
        if (!notRendered.has(f)) continue
        const reason = notRendered.get(f)
        add({ statement: s.id, ...span, kind: 'not-rendered', ...(reason ? { reason } : {}) })
      }
  }
  return { issues: out, links }
}

/**
 * The keys of a JSON text's top-level object, in order, duplicates included (JSON.parse keeps only the last of a
 * duplicate). The text must already parse.
 */
function topLevelKeys(text: string): string[] {
  const keys: string[] = []
  const string = /"(?:[^"\\]|\\.)*"/y
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      string.lastIndex = i
      const token = string.exec(text)![0]
      i += token.length - 1
      if (depth === 1 && /^\s*:/.test(text.slice(i + 1))) keys.push(JSON.parse(token) as string)
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
  }
  return keys
}

/**
 * Reads an interface map: `from,to` lines (`#` starts a comment; `from,` with no name is an interface not named yet,
 * as `--write-map` writes it), or JSON (an object of names). Problems by line, never quoting a name: a map's names are
 * a config's, and one can be a secret's value reused (AGENTS.md).
 */
export function parseInterfaceMap(text: string): { map: InterfaceMap; problems: string[] } {
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  const problems: string[] = []
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (/^[[{]/.test(body.trimStart())) {
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      return { map, problems: ['not valid JSON'] }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return { map, problems: ['the JSON is not an object of interface names'] }
    const keys = topLevelKeys(body)
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i).length
    if (twice) return { map: Object.create(null) as InterfaceMap, problems: [`the JSON names ${twice === 1 ? 'an interface' : `${twice} interfaces`} twice`] }
    const notNames = Object.values(json).filter((to) => typeof to !== 'string' || !to.trim()).length
    if (notNames) problems.push(`${notNames === 1 ? 'a target name is' : `${notNames} target names are`} not a name (give each as a string)`)
    for (const [from, to] of Object.entries(json)) if (typeof to === 'string' && to.trim()) map[from] = to.trim()
    return { map, problems }
  }
  const firstLine = new Map<string, number>()
  body.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) return
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length !== 2 || !parts[0]) problems.push(`line ${i + 1}: expected from,to`)
    else if (firstLine.has(parts[0])) problems.push(`line ${i + 1}: an interface mapped twice (first on line ${firstLine.get(parts[0])})`)
    else {
      firstLine.set(parts[0], i + 1)
      if (parts[1]) map[parts[0]] = parts[1]
    }
  })
  return { map, problems }
}

/**
 * An interface map as `from,to` lines, the format parseInterfaceMap() reads. With `interfaces`, every one of them in
 * order, for the user to fill in: a name given, else the suggestion marked `# suggested`, else `from,` with no name.
 */
export function formatInterfaceMap(map: InterfaceMap, interfaces?: readonly Pick<InterfaceName, 'source' | 'suggestion'>[]): string {
  if (!interfaces) return Object.entries(map).map(([from, to]) => `${from},${to}\n`).join('')
  return interfaces
    .map((i) => (Object.hasOwn(map, i.source) ? `${i.source},${map[i.source]}\n` : i.suggestion ? `${i.source},${i.suggestion} # suggested\n` : `${i.source},\n`))
    .join('')
}
