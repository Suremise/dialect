// Convert mode: a source plugin's parse → the shared model → a target plugin's render, with the interface map between
// them. Interface names never map silently: every interface the model names, as a key or as a reference (a next hop's
// interface, a source interface), is a needs-input item until the user names it on the target. Plugins that describe
// and name ports (PortName) give suggestions, marked as such. Plain strings and objects, as everywhere in the core.
import { buildLedger, statementsOf, type CoverageLedger } from './ledger'
import type { Device, Interface, InterfaceType, NetworkInstance, StaticRoute, System } from './model'
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

/** Where the model names an interface by reference, not as a key: the value is `name` or `name.<subinterface>`. */
function references(model: Device): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  const ntp = model.system?.ntp?.sourceInterface
  if (ntp !== undefined) out.push({ path: fieldPath('system', 'ntp', 'sourceInterface'), value: ntp })
  const logging = model.system?.logging?.sourceInterface
  if (logging !== undefined) out.push({ path: fieldPath('system', 'logging', 'sourceInterface'), value: logging })
  for (const [instance, ni] of Object.entries(model.networkInstances ?? {}))
    for (const [prefix, route] of Object.entries(ni.staticRoutes ?? {}))
      for (const [index, hop] of Object.entries(route.nextHops ?? {}))
        if (hop.interface !== undefined) out.push({ path: fieldPath('networkInstances', instance, 'staticRoutes', prefix, 'nextHops', index, 'interface'), value: hop.interface })
  return out
}

/** The interface a reference names: itself when the model has it, else its base when the model has that. */
function referencedInterface(ref: string, keys: ReadonlySet<string>): string {
  if (keys.has(ref)) return ref
  const split = splitReference(ref)
  return split && keys.has(split.base) ? split.base : (split?.base ?? ref)
}

/** Every interface the model names, in order: its keys, then interfaces only referenced (`st0.0` → `st0`). */
export function modelInterfaces(model: Device): string[] {
  const keys = new Set(Object.keys(model.interfaces ?? {}))
  const names = [...keys]
  for (const r of references(model)) {
    const name = referencedInterface(r.value, keys)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** A null-prototype copy of a keyed map, keys renamed (configuration keys can be `__proto__`: model.ts). */
function keyed<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>
  for (const [k, v] of entries) out[k] = v
  return out
}

/** The model with interfaces renamed by `names` (source → target), as keys and in references. Others are kept. */
export function renameInterfaces(model: Device, names: InterfaceMap): Device {
  const has = (name: string) => Object.hasOwn(names, name)
  const keys = new Set(Object.keys(model.interfaces ?? {}))
  const ref = (value: string): string => {
    if (has(value)) return names[value]
    const split = splitReference(value)
    return split && !keys.has(value) && has(split.base) ? `${names[split.base]}.${split.index}` : value
  }
  const system = model.system && {
    ...model.system,
    ...(model.system.ntp?.sourceInterface !== undefined ? { ntp: { ...model.system.ntp, sourceInterface: ref(model.system.ntp.sourceInterface) } } : {}),
    ...(model.system.logging?.sourceInterface !== undefined ? { logging: { ...model.system.logging, sourceInterface: ref(model.system.logging.sourceInterface) } } : {})
  }
  const route = (r: StaticRoute): StaticRoute =>
    r.nextHops ? { ...r, nextHops: keyed(Object.entries(r.nextHops).map(([i, hop]) => [i, hop.interface !== undefined ? { ...hop, interface: ref(hop.interface) } : hop] as const)) } : r
  const instance = (ni: NetworkInstance): NetworkInstance => (ni.staticRoutes ? { ...ni, staticRoutes: keyed(Object.entries(ni.staticRoutes).map(([p, r]) => [p, route(r)] as const)) } : ni)
  return {
    ...model,
    ...(system ? { system: system as System } : {}),
    ...(model.interfaces ? { interfaces: keyed<Interface>(Object.entries(model.interfaces).map(([name, i]) => [has(name) ? names[name] : name, i] as const)) } : {}),
    ...(model.networkInstances ? { networkInstances: keyed(Object.entries(model.networkInstances).map(([n, ni]) => [n, instance(ni)] as const)) } : {})
  }
}

/** One interface of a conversion: its name on the source, the user's name for it on the target, and a suggestion. */
export interface InterfaceName {
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
 * The statement to show for an interface: the outermost statement whose mapped fields all belong to it (the Junos
 * `ge-0/0/0 { … }` block, not the `interfaces` block around it), or the first that names it by reference.
 */
function interfaceStatement(tree: readonly SyntaxNode[], fields: Map<string, readonly string[]>, name: string, referencedAt: ReadonlySet<string>): string | undefined {
  const prefix = fieldPath('interfaces', name)
  const own = (f: string) => f === prefix || f.startsWith(`${prefix}.`) || f.startsWith(`${prefix}[`)
  const subtree = (n: SyntaxNode): string[] => [...(fields.get(n.id) ?? []), ...(n.children ?? []).flatMap(subtree)]
  const find = (nodes: readonly SyntaxNode[]): string | undefined => {
    for (const n of nodes) {
      const all = subtree(n)
      if (all.length && all.every(own)) return n.id
      if (all.some(own)) return find(n.children ?? [])
    }
    return undefined
  }
  return find(tree) ?? statementsOf(tree).find((n) => (fields.get(n.id) ?? []).some((f) => referencedAt.has(f)))?.id
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

  // The interfaces, and the user's answers. Two given one target name would become one interface: refused, unanswered.
  const names = modelInterfaces(parse.model)
  const keys = new Set(Object.keys(parse.model.interfaces ?? {}))
  const refs = references(parse.model)
  const answers = new Map(names.map((n) => [n, answer(interfaceInputId(n))]))
  const diagnostics: Diagnostic[] = []
  const byTarget = new Map<string, string[]>()
  for (const [n, to] of answers) if (to !== undefined) byTarget.set(to, [...(byTarget.get(to) ?? []), n])
  for (const [to, from] of byTarget) {
    if (from.length < 2) continue
    diagnostics.push({ severity: 'error', category: 'other', code: 'convert.interface-name-taken', message: `${from.length} interfaces are given the one name ${to}: ${from.join(', ')}. Give each its own.` })
    for (const n of from) answers.set(n, undefined)
  }
  const interfaces = names.map((n): InterfaceName => {
    const port = source.describeInterface?.(n)
    const suggestion = port ? target.nameInterface?.(port) : undefined
    const referencedAt = new Set(refs.filter((r) => referencedInterface(r.value, keys) === n).map((r) => r.path))
    const statement = interfaceStatement(parse.tree, fields, n, referencedAt)
    const to = answers.get(n)
    return { source: n, inputId: interfaceInputId(n), ...(to !== undefined ? { target: to } : {}), ...(suggestion ? { suggestion } : {}), ...(statement ? { statement } : {}) }
  })
  const needsInput = interfaces.map(
    (i): NeedsInput => ({
      id: i.inputId,
      kind: 'interface-name',
      message: `Name ${i.source} on ${target.name}.`,
      ...(keys.has(i.source) ? { field: fieldPath('interfaces', i.source) } : {}),
      ...(i.statement ? { statement: i.statement } : {}),
      ...(i.suggestion ? { suggestions: [i.suggestion] } : {})
    })
  )

  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const i of interfaces) if (i.target !== undefined) map[i.source] = i.target
  const model = renameInterfaces(parse.model, map)
  const failed = parse.diagnostics.some((d) => d.severity === 'error')
  const render = failed ? undefined : target.render(model, context)
  const built = buildLedger(parse, render, model)
  const ledger: CoverageLedger = { ...built, diagnostics: [...built.diagnostics, ...diagnostics], needsInput: [...needsInput, ...built.needsInput] }
  const named = new Set(interfaces.filter((i) => i.target !== undefined).map((i) => i.inputId))
  const unanswered = [...needsInput.filter((item) => !named.has(item.id)), ...built.needsInput.filter((item) => answer(item.id) === undefined)]
  return { parse, model, ...(render ? { render } : {}), ledger, interfaces, unanswered, ...sourceSide(ledger, map) }
}

/** By source statement: what didn't fully carry over (one issue per statement and reason), and where its fields went. */
function sourceSide(ledger: CoverageLedger, map: InterfaceMap): Pick<Conversion, 'issues' | 'links'> {
  // The render's fields are the renamed model's: back to the parse's names, to find the statement that filled each.
  const back = new Map(Object.entries(map).map(([from, to]) => [to, from]))
  const sourcePath = (path: string) => {
    const s = pathSegments(path)
    if (s[0] === 'interfaces' && typeof s[1] === 'string' && back.has(s[1])) s[1] = back.get(s[1])!
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

/** Reads an interface map: `from,to` lines (`#` starts a comment), or JSON (an object of names). Problems by line. */
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
    for (const [from, to] of Object.entries(json)) {
      if (typeof to !== 'string' || !to.trim()) problems.push(`${from}: give the target name as a string`)
      else map[from] = to.trim()
    }
    return { map, problems }
  }
  body.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) return
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length !== 2 || !parts[0] || !parts[1]) problems.push(`line ${i + 1}: expected from,to`)
    else if (Object.hasOwn(map, parts[0])) problems.push(`line ${i + 1}: ${parts[0]} is mapped twice`)
    else map[parts[0]] = parts[1]
  })
  return { map, problems }
}

/** An interface map as `from,to` lines, the format parseInterfaceMap() reads. */
export function formatInterfaceMap(map: InterfaceMap): string {
  return Object.entries(map)
    .map(([from, to]) => `${from},${to}\n`)
    .join('')
}
