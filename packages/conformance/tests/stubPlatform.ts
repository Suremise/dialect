// A stub platform for the kit's own tests: a tiny brace language (`system { host-name r1; }`), a mapper driven by a
// rule table and a renderer, each of which can be told to leave things out. It's how the kit proves it catches what a
// careless plugin misses. Not a real platform, and nothing to do with the Junos plugin: just enough syntax for the
// counterexamples in the build plan (B2).
import { fieldPath, type Context, type Device, type Diagnostic, type FieldDisposition, type NeedsInput, type ParseResult, type PathSegment, type PlatformPlugin, type RenderResult, type Span, type StatementDisposition, type SyntaxNode } from '@dialect/core'
import type { LeakSite } from '../src'

type Token = { text: string; line: number; column: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /"(?:[^"\\]|\\.)*"|[{};]|[^\s{};"]+/g
  text.split(/\r\n?|\n/).forEach((lineText, i) => {
    for (const m of lineText.matchAll(re)) tokens.push({ text: m[0], line: i + 1, column: (m.index ?? 0) + 1 })
  })
  return tokens
}

/**
 * The tree: each `words…;` is a leaf statement, each `words… { … }` a container. Labels are full paths. A syntax error
 * names punctuation only, unless `quote` has it quote the words before it (a leak, for negative tests).
 */
export function parseTree(text: string, { quote = false }: { quote?: boolean } = {}): SyntaxNode[] {
  const tokens = tokenize(text)
  let at = 0
  const used = new Map<string, number>()
  const idFor = (label: string) => {
    const n = (used.get(label) ?? 0) + 1
    used.set(label, n)
    return n === 1 ? label : `${label}#${n}`
  }
  const block = (parent: string): SyntaxNode[] => {
    const nodes: SyntaxNode[] = []
    while (at < tokens.length && tokens[at].text !== '}') {
      const words: Token[] = []
      while (at < tokens.length && !['{', '}', ';'].includes(tokens[at].text)) words.push(tokens[at++])
      const end = tokens[at]
      if (!end || end.text === '}' || !words.length) throw new SyntaxError(`stub: unexpected ${end ? `"${end.text}"` : 'end of text'}${quote && words.length ? ` after "${words.map((w) => w.text).join(' ')}"` : ''}`)
      at++
      const label = [parent, ...words.map((w) => w.text)].filter(Boolean).join(' ')
      const start = words[0]
      if (end.text === ';') {
        const span: Span = { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column + 1 }
        nodes.push({ id: idFor(label), label, span })
      } else {
        const id = idFor(label)
        const children = block(label)
        const close = tokens[at++]
        if (!close || close.text !== '}') throw new SyntaxError('stub: missing "}"')
        nodes.push({ id, label, span: { startLine: start.line, startColumn: start.column, endLine: close.line, endColumn: close.column + 1 }, children })
      }
    }
    return nodes
  }
  const tree = block('')
  if (at < tokens.length) throw new SyntaxError('stub: unexpected "}"')
  return tree
}

type Rule = { name: string; match: RegExp; set?: (m: RegExpMatchArray, nextIndex: (key: string) => string) => [PathSegment[], string | number | boolean | Record<string, never>][] }

const unquote = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s)
const nh = ['networkInstances', 'default']
const neighbor = (addr: string) => [...nh, 'bgp', 'neighbors', addr]

/** What the stub mapper knows, by rule name. A rule without `set` is a container that only groups its children. */
export const RULES: readonly Rule[] = [
  { name: 'system', match: /^system$/ },
  { name: 'host-name', match: /^system host-name (\S+)$/, set: (m) => [[['system', 'hostname'], m[1]]] },
  { name: 'domain-name', match: /^system domain-name (\S+)$/, set: (m) => [[['system', 'domainName'], m[1]]] },
  { name: 'ntp', match: /^system ntp$/ },
  // A server with no options is an entry with nothing in it: `{}`, its key the configuration.
  { name: 'ntp-server', match: /^system ntp server (\S+)$/, set: (m) => [[['system', 'ntp', 'servers', m[1]], {}]] },
  { name: 'ntp-prefer', match: /^system ntp server (\S+) prefer$/, set: (m) => [[['system', 'ntp', 'servers', m[1], 'prefer'], true]] },
  { name: 'interfaces', match: /^interfaces$/ },
  { name: 'interface', match: /^interfaces (\S+)$/ },
  { name: 'description', match: /^interfaces (\S+) description ("(?:[^"\\]|\\.)*"|\S+)$/, set: (m) => [[['interfaces', m[1], 'description'], unquote(m[2])]] },
  { name: 'disable', match: /^interfaces (\S+) disable$/, set: (m) => [[['interfaces', m[1], 'enabled'], false]] },
  { name: 'unit', match: /^interfaces (\S+) unit (\d+)$/ },
  { name: 'family', match: /^interfaces (\S+) unit (\d+) family inet$/ },
  { name: 'address', match: /^interfaces (\S+) unit (\d+) family inet address ([\d.]+)\/(\d+)$/, set: (m) => [[['interfaces', m[1], 'subinterfaces', m[2], 'ipv4', 'addresses', m[3], 'prefixLength'], Number(m[4])]] },
  // VRF membership and a VRF's own settings (model 0.3.0), for the kit's model checks; the renderer doesn't write them.
  { name: 'unit-vrf', match: /^interfaces (\S+) unit (\d+) vrf (\S+)$/, set: (m) => [[['interfaces', m[1], 'subinterfaces', m[2], 'networkInstance'], m[3]]] },
  { name: 'routing-instances', match: /^routing-instances$/ },
  { name: 'routing-instance', match: /^routing-instances (\S+)$/ },
  { name: 'instance-type', match: /^routing-instances (\S+) instance-type (vrf|virtual-router)$/, set: (m) => [[['networkInstances', m[1], 'type'], m[2]]] },
  { name: 'route-distinguisher', match: /^routing-instances (\S+) route-distinguisher (\S+)$/, set: (m) => [[['networkInstances', m[1], 'routeDistinguisher'], m[2]]] },
  { name: 'routing-options', match: /^routing-options$/ },
  { name: 'static', match: /^routing-options static$/ },
  { name: 'route', match: /^routing-options static route (\S+) next-hop (\S+)$/, set: (m, next) => [[[...nh, 'staticRoutes', m[1], 'nextHops', next(m[1]), 'address'], m[2]]] },
  { name: 'protocols', match: /^protocols$/ },
  { name: 'bgp', match: /^protocols bgp$/ },
  { name: 'neighbor', match: /^protocols bgp neighbor (\S+)$/ },
  { name: 'peer-as', match: /^protocols bgp neighbor (\S+) peer-as (\d+)$/, set: (m) => [[[...neighbor(m[1]), 'peerAs'], Number(m[2])]] },
  { name: 'multihop', match: /^protocols bgp neighbor (\S+) multihop$/ },
  { name: 'ttl', match: /^protocols bgp neighbor (\S+) multihop ttl (\d+)$/, set: (m) => [[[...neighbor(m[1]), 'multihop', 'ttl'], Number(m[2])]] }
]

// Keys come from the configuration, `__proto__` included, so the model is built from null-prototype objects with
// own-property checks (model.ts).
function assign(model: Record<string, unknown>, path: PathSegment[], value: unknown) {
  let at = model
  for (const seg of path.slice(0, -1)) {
    if (!Object.hasOwn(at, seg)) at[seg] = Object.create(null)
    at = at[seg] as Record<string, unknown>
  }
  const key = path[path.length - 1]
  // An empty entry doesn't replace one that already has something in it.
  if (typeof value === 'object' && value !== null && Object.hasOwn(at, key)) return
  at[key] = typeof value === 'object' && value !== null ? Object.assign(Object.create(null), value) : value
}

export interface StubOptions {
  /** The mapper's rules by name; every rule when left out. A statement no known rule matches is `unsupported`. */
  readonly mapRules?: readonly string[]
  /** Leaves the renderer leaves out without a word (for negative tests), by a test on their path. */
  readonly renderSkips?: (path: string) => boolean
  /** Extra dispositions the renderer gives (for negative tests: an object's path instead of its leaves). */
  readonly extraRenderDispositions?: Readonly<Record<string, FieldDisposition>>
  readonly id?: string
  readonly modelApi?: string
  /** Where it quotes the config in what it says, for the secrets check's negative tests; nowhere when left out. */
  readonly leaks?: readonly LeakSite[]
}

/** The stub plugin: careful by default, careless as `options` say. */
export function stubPlugin(options: StubOptions = {}): PlatformPlugin {
  const known = options.mapRules ? RULES.filter((r) => options.mapRules?.includes(r.name)) : RULES
  const careful = !options.mapRules
  const leaks = new Set(options.leaks)
  return {
    id: options.id ?? 'stub',
    name: 'Stub platform (tests only)',
    modelApi: options.modelApi ?? '>=0.1.0 <1.0.0',
    capabilities: { system: { parse: 'partial', render: 'partial' }, interfaces: { parse: 'partial', render: 'partial' }, 'static-routes': { parse: 'partial', render: 'partial' } },
    detect: (text) => (/^\s*(system|interfaces|routing-options|protocols)\s*\{/m.test(text) ? 0.5 : 0),
    parse(text: string, _context: Context): ParseResult {
      let tree: SyntaxNode[]
      try {
        tree = parseTree(text, { quote: leaks.has('parse diagnostic') || leaks.has('thrown error') })
      } catch (e) {
        if (leaks.has('thrown error')) throw e
        return { tree: [], model: {}, dispositions: {}, diagnostics: [{ severity: 'error', category: 'syntax', message: (e as Error).message }] }
      }
      const diagnostics: Diagnostic[] = []
      const needsInput: NeedsInput[] = []
      const model: Record<string, unknown> = Object.create(null)
      const dispositions: Record<string, StatementDisposition> = Object.create(null)
      const hops = new Map<string, number>()
      const nextIndex = (key: string) => {
        const n = hops.get(key) ?? 0
        hops.set(key, n + 1)
        return String(n)
      }
      const walk = (nodes: readonly SyntaxNode[]) => {
        for (const node of nodes) {
          const rule = known.find((r) => r.match.test(node.label))
          if (rule) {
            const sets = rule.set?.(node.label.match(rule.match) as RegExpMatchArray, nextIndex) ?? []
            for (const [path, value] of sets) assign(model, path, value)
            dispositions[node.id] = { kind: 'mapped', fields: sets.map(([path]) => fieldPath(...path)) }
          } else if (careful) {
            dispositions[node.id] = { kind: 'unsupported', reason: leaks.has('statement reason') ? `no rule for "${node.label}"` : 'the stub platform has no rule for it' }
            if (leaks.has('parse diagnostic')) diagnostics.push({ severity: 'warning', message: `"${node.label}" isn't converted`, statement: node.id })
            if (leaks.has('parse needs-input')) needsInput.push({ id: `secret-${node.id}`, kind: 'secret', message: `a value for "${node.label}"`, statement: node.id })
          }
          if (node.children) walk(node.children)
        }
      }
      walk(tree)
      return { tree, model: model as Device, dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }
    },
    render(model: Device, _context: Context): RenderResult {
      const lines: string[] = []
      const dispositions: Record<string, FieldDisposition> = { ...options.extraRenderDispositions }
      const diagnostics: Diagnostic[] = []
      const needsInput: NeedsInput[] = []
      const skip = options.renderSkips ?? (() => false)
      const indent = (depth: number) => '    '.repeat(depth)
      /** Writes a leaf statement for `path`, unless skipped; records where. */
      const leaf = (depth: number, text: string, ...path: PathSegment[]) => {
        const p = fieldPath(...path)
        if (skip(p)) return
        lines.push(`${indent(depth)}${text};`)
        dispositions[p] = { kind: 'rendered', span: { startLine: lines.length, startColumn: depth * 4 + 1, endLine: lines.length, endColumn: depth * 4 + text.length + 2 } }
      }
      const open = (depth: number, text: string) => lines.push(`${indent(depth)}${text} {`)
      const close = (depth: number) => lines.push(`${indent(depth)}}`)
      const m = model as Device & { networkInstances?: Record<string, { bgp?: { neighbors?: Record<string, { peerAs?: number; multihop?: { ttl?: number } }> } }> }

      const servers = Object.entries(m.system?.ntp?.servers ?? {}).filter(([address, server]) => !skip(fieldPath('system', 'ntp', 'servers', address, ...(server.prefer === true ? ['prefer'] : []))))
      if (m.system && (m.system.hostname !== undefined || m.system.domainName !== undefined || servers.length)) {
        open(0, 'system')
        if (m.system.hostname !== undefined && leaks.has('field reason')) dispositions[fieldPath('system', 'hostname')] = { kind: 'unsupported', reason: `host-name ${m.system.hostname} isn't rendered` }
        else if (m.system.hostname !== undefined) leaf(1, `host-name ${m.system.hostname}`, 'system', 'hostname')
        if (m.system.hostname !== undefined && leaks.has('render diagnostic')) diagnostics.push({ severity: 'info', message: `rendered host-name ${m.system.hostname}`, field: 'system.hostname' })
        if (m.system.hostname !== undefined && leaks.has('render needs-input')) needsInput.push({ id: 'hostname', kind: 'other', message: 'a host name for the target', suggestions: [m.system.hostname] })
        if (m.system.domainName !== undefined) leaf(1, `domain-name ${m.system.domainName}`, 'system', 'domainName')
        if (servers.length) {
          open(1, 'ntp')
          for (const [address, server] of servers) {
            if (server.prefer === true) leaf(2, `server ${address} prefer`, 'system', 'ntp', 'servers', address, 'prefer')
            else if (Object.keys(server).length === 0) leaf(2, `server ${address}`, 'system', 'ntp', 'servers', address)
          }
          close(1)
        }
        close(0)
      }
      const interfaces = Object.entries(m.interfaces ?? {})
      if (interfaces.length) {
        open(0, 'interfaces')
        for (const [name, ifc] of interfaces) {
          open(1, name)
          if (ifc.description !== undefined) leaf(2, `description ${JSON.stringify(ifc.description)}`, 'interfaces', name, 'description')
          if (ifc.enabled === false) leaf(2, 'disable', 'interfaces', name, 'enabled')
          else if (ifc.enabled === true) dispositions[fieldPath('interfaces', name, 'enabled')] = { kind: 'not-applicable', reason: 'enabled is the default' }
          for (const [unit, sub] of Object.entries(ifc.subinterfaces ?? {})) {
            open(2, `unit ${unit}`)
            open(3, 'family inet')
            for (const [address, a] of Object.entries(sub.ipv4?.addresses ?? {})) leaf(4, `address ${address}/${a.prefixLength}`, 'interfaces', name, 'subinterfaces', unit, 'ipv4', 'addresses', address, 'prefixLength')
            close(3)
            close(2)
          }
          close(1)
        }
        close(0)
      }
      const routes = Object.entries(m.networkInstances?.default?.staticRoutes ?? {})
      if (routes.length) {
        open(0, 'routing-options')
        open(1, 'static')
        for (const [prefix, route] of routes)
          for (const [i, hop] of Object.entries(route.nextHops ?? {}))
            if (hop.address !== undefined) leaf(2, `route ${prefix} next-hop ${hop.address}`, ...nh, 'staticRoutes', prefix, 'nextHops', i, 'address')
        close(1)
        close(0)
      }
      const neighbors = Object.entries(m.networkInstances?.default?.bgp?.neighbors ?? {})
      if (neighbors.length) {
        open(0, 'protocols')
        open(1, 'bgp')
        for (const [addr, n] of neighbors) {
          open(2, `neighbor ${addr}`)
          if (n.peerAs !== undefined) leaf(3, `peer-as ${n.peerAs}`, ...neighbor(addr), 'peerAs')
          if (n.multihop?.ttl !== undefined && !skip(fieldPath(...neighbor(addr), 'multihop', 'ttl'))) {
            open(3, 'multihop')
            leaf(4, `ttl ${n.multihop.ttl}`, ...neighbor(addr), 'multihop', 'ttl')
            close(3)
          }
          close(2)
        }
        close(1)
        close(0)
      }
      return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }
    },
    // Two tools: echo gives its input back (config: STUB_CONFIG_TOOLS), with a warning for each line with a quote on
    // it; report's text is a report on the input, not config.
    tools: () => [
      {
        id: 'report',
        name: 'Report',
        run: (input: string) => {
          const quoted = input.split('\n').filter((line) => line.includes('"'))
          return { text: leaks.has('tool text') ? quoted.map((line) => `a quote in: ${line.trim()}\n`).join('') : `${quoted.length} line(s) with a quote\n`, diagnostics: [] }
        }
      },
      {
        id: 'echo',
        name: 'Echo',
        run: (input: string) => ({
          text: input,
          diagnostics: input
            .split('\n')
            .flatMap((line, i): Diagnostic[] => (line.includes('"') ? [{ severity: 'warning', code: 'stub.quote', message: leaks.has('tool diagnostic') ? `a quote in: ${line.trim()}` : 'a quote on this line', span: { startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: 1 } }] : []))
        })
      }
    ]
  }
}

/** The stub's tools whose text is config, for the secrets check (`configTools`). */
export const STUB_CONFIG_TOOLS: readonly string[] = ['echo']

export default stubPlugin()
