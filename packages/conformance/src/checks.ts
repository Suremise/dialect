// The conformance kit's five checks on one fixture, as plain functions (no Vitest), so the kit's own negative tests can
// assert what they report. suite.ts runs them as Vitest tests over a plugin's fixture folder.
//
// For a fixture `<case>.<ext>` (source) + `<case>.model.json` (expected model) + optionally `<case>.rendered.<ext>`
// (expected render):
// 1. parse → no error, a valid model (core's modelProblems(): references resolve, values in the model's forms), and the
//    model equals the expected model;
// 2. render → no error, and the text equals the expected render (when the fixture has one; skipped when it has none
//    and the render reported no error);
// 3. render → reparse → no error, a valid model, and the same model (round-trip stability), except a leaf the render
//    left to a secret needs-input item: a key the model flags but never carries, which the render asks the user for
//    rather than make up (the check lists each one it leaves out);
// 4. the coverage ledger is complete: every statement of the parse and every populated field of the render has a
//    disposition (core's ledger.ts, which doesn't trust the plugin's own count), and policy terms keep the per-term rule
//    (termProblems(): a term whole or not at all, and the whole policy when leaving a term out isn't safe);
// 5. no secret: none of the fixture's secret values is in a diagnostic, needs-input item, ledger reason, tool
//    diagnostic, tool report (a tool's text, unless it is a config tool's) or thrown error, on the fixture or on broken copies of it (secrets.ts). Skipped for a fixture with none.
// An error a step reports fails its check even when its output matches: a plugin that says it failed isn't conformant.
import { buildLedger, fieldPath, filterTermSkipSafe, ledgerProblems, MODEL_VERSION, modelProblems, pathSegments, populatedLeaves, termSkipSafe, type Context, type Device, type ParseResult, type PlatformPlugin, type RenderResult, type SyntaxNode } from '@dialect/core'
import type { SecretAllowance } from './allowances'
import { checkSecrets, describeLeak, findSecrets, type SecretsOptions } from './secrets'

/** One fixture, already read (fixtures.ts reads them from disk). */
export interface Fixture {
  /** `<area>/<case>`, for reports. */
  readonly name: string
  readonly source: string
  readonly expectedModel: Device
  /** The expected render, when the fixture has one. */
  readonly expectedRender?: string
  /** Its secret values (`<case>.secrets.json`); found in the source by pattern when left out (findSecrets). */
  readonly secrets?: readonly string[]
}

export type CheckName = 'parse' | 'render' | 'round-trip' | 'ledger' | 'secrets'

/** One check's outcome: passed, failed with what was wrong, or skipped with why. */
export interface CheckResult {
  readonly check: CheckName
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly problems: readonly string[]
  /** The secrets check: leaks a temporary allowance let through, each with it (allowances.ts). */
  readonly allowed?: readonly { readonly leak: string; readonly allowance: SecretAllowance }[]
  /** The round-trip check: the leaves it left out, each one the render left to a secret needs-input item, by path. */
  readonly deferred?: readonly string[]
}

const lf = (text: string) => text.replace(/\r\n?/g, '\n')

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A key's own value: a key such as `toString` or `__proto__` missing from `o` is undefined, not Object.prototype's. */
const own = (o: object, key: string): unknown => (Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined)

/**
 * Whether two models are the same data: the same own keys with the same values. Prototypes don't count, so a model a
 * plugin builds from null-prototype objects equals the same model read from JSON.
 */
function sameData(e: unknown, a: unknown): boolean {
  if (Array.isArray(e) || Array.isArray(a)) return Array.isArray(e) && Array.isArray(a) && e.length === a.length && e.every((v, i) => sameData(v, a[i]))
  if (isObject(e) && isObject(a)) {
    const keys = Object.keys(e)
    return keys.length === Object.keys(a).length && keys.every((k) => Object.hasOwn(a, k) && sameData(own(e, k), own(a, k)))
  }
  return Object.is(e, a)
}

/** Where two models differ, as paths: `a.b: expected 1, got 2`. At most `limit` lines. */
export function modelDifferences(expected: unknown, actual: unknown, limit = 20): string[] {
  const out: string[] = []
  const walk = (e: unknown, a: unknown, at: string) => {
    if (out.length >= limit || sameData(e, a)) return
    if (isObject(e) && isObject(a)) {
      for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) walk(own(e, k), own(a, k), at ? `${at}.${k}` : k)
      return
    }
    out.push(`${at || '(model)'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`)
  }
  walk(expected, actual, '')
  return out
}

/**
 * The leaves of `model` that `rendered` left to the user: each a populated leaf that a `secret` needs-input item (with
 * an id) names as its field, and that the render didn't write. A key the model flags (`authentication: true`) never
 * reaches the render's text, so a reparse can't have it back; asking for it is the render's honest answer, and a
 * placeholder key never is. A leaf dropped with no such item, or left to an item of another kind, isn't one.
 */
export function deferredSecrets(model: Device, rendered: RenderResult): string[] {
  const leaves = new Set(populatedLeaves(model).map((l) => l.path))
  const fields = (rendered.needsInput ?? []).filter((item) => item.kind === 'secret' && item.id !== '' && item.field !== undefined).map((item) => item.field!)
  const written = (path: string) => Object.hasOwn(rendered.dispositions, path) && rendered.dispositions[path].kind === 'rendered'
  return [...new Set(fields)].filter((path) => leaves.has(path) && !written(path))
}

/**
 * `model` without the leaves at `paths` (field paths), as a copy: null-prototype objects, own keys only. An object left
 * empty only by taking them out (a group whose one leaf was its key) goes too, its path added to `emptied`; one the
 * model has empty stays, as it is configured with nothing in it, a leaf of its own.
 */
function without(model: unknown, paths: ReadonlySet<string>, emptied: Set<string>, at: readonly string[] = []): unknown {
  if (!isObject(model) || !paths.size) return model
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(model)) {
    const segments = [...at, key]
    if (paths.has(fieldPath(...segments))) continue
    const value = own(model, key)
    const kept = without(value, paths, emptied, segments)
    if (isObject(value) && Object.keys(value).length && isObject(kept) && !Object.keys(kept).length) {
      emptied.add(fieldPath(...segments))
      continue
    }
    out[key] = kept
  }
  return out
}

/**
 * `model` (the reparse) without an empty object at one of the `emptied` paths: whether a render keeps the container of
 * a deferred key (`group G;`) or leaves it out, the round trip is the same. Nothing else is taken out.
 */
function withoutEmptied(model: unknown, emptied: ReadonlySet<string>, at: readonly string[] = []): unknown {
  if (!isObject(model) || !emptied.size) return model
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(model)) {
    const segments = [...at, key]
    const kept = withoutEmptied(own(model, key), emptied, segments)
    if (emptied.has(fieldPath(...segments)) && isObject(kept) && !Object.keys(kept).length) continue
    out[key] = kept
  }
  return out
}

/**
 * A term's identity, from a field path under it, as the JSON of its own path's segments: a policy's
 * (`routingPolicy.policies.P.terms.T…`, model 0.5.0) or a filter's (`filters.ipv4.F.terms.T…`, 0.5.1). Null for any
 * other path.
 */
function termOf(path: string): string | null {
  let s: ReturnType<typeof pathSegments>
  try {
    s = pathSegments(path)
  } catch {
    return null
  }
  const policy = s[0] === 'routingPolicy' && s[1] === 'policies'
  const filter = s[0] === 'filters' && (s[1] === 'ipv4' || s[1] === 'ipv6')
  return s.length >= 5 && (policy || filter) && s[3] === 'terms' ? JSON.stringify(s.slice(0, 5)) : null
}

/**
 * The per-term rule (model 0.5.0, filters since 0.5.1; docs/ARCHITECTURE.md): a policy's or filter's term is converted
 * whole or not at all, and one left out leaves the rest converted only when termSkipSafe() (filterTermSkipSafe())
 * says later terms still see the same routes (packets).
 * - Parse: the statements that make up a term (the smallest subtree holding every statement that maps into it, widened
 *   while its parent maps nothing outside that term) are mapped or ignored by design, none unsupported, when anything
 *   of the term reaches the model. A term the parse leaves out whole isn't in the model, so its safety is the parser's
 *   to judge (it knows the term's actions): it can't be checked here.
 * - Render: a term's leaves are all `unsupported` or none is; a term left out whose skip isn't safe leaves every leaf of
 *   its policy or filter `unsupported` (its `fallThrough` or `implicitAction` aside, which may be `not-applicable`).
 */
export function termProblems(parsed: ParseResult, rendered?: RenderResult, model: Device = parsed.model): string[] {
  const out: string[] = []
  const show = (term: string) => fieldPath(...(JSON.parse(term) as string[]))

  // ---- parse: statements, by the terms their mapped fields are in
  const parent = new Map<SyntaxNode, SyntaxNode | undefined>()
  /** Per node, the terms its own mapped fields are in, and whether it maps any field outside a term. */
  const mapping = new Map<SyntaxNode, { terms: Set<string>; other: boolean }>()
  const index = (nodes: readonly SyntaxNode[], up: SyntaxNode | undefined) => {
    for (const n of nodes) {
      parent.set(n, up)
      const d = Object.hasOwn(parsed.dispositions, n.id) ? parsed.dispositions[n.id] : undefined
      const terms = new Set<string>()
      let other = false
      for (const f of d?.kind === 'mapped' ? d.fields : []) {
        const t = termOf(f)
        if (t === null) other = true
        else terms.add(t)
      }
      mapping.set(n, { terms, other })
      index(n.children ?? [], n)
    }
  }
  index(parsed.tree, undefined)
  /** What a subtree maps: its terms, and whether anything outside them. */
  const subtree = new Map<SyntaxNode, { terms: Set<string>; other: boolean }>()
  const sum = (n: SyntaxNode): { terms: Set<string>; other: boolean } => {
    const o = mapping.get(n)!
    const s = { terms: new Set(o.terms), other: o.other }
    for (const c of n.children ?? []) {
      const cs = sum(c)
      for (const t of cs.terms) s.terms.add(t)
      s.other ||= cs.other
    }
    subtree.set(n, s)
    return s
  }
  for (const n of parsed.tree) sum(n)
  const ancestors = (n: SyntaxNode) => {
    const chain: SyntaxNode[] = []
    for (let a: SyntaxNode | undefined = n; a; a = parent.get(a)) chain.unshift(a)
    return chain
  }
  const unsupportedIn = (n: SyntaxNode): SyntaxNode[] => [...(Object.hasOwn(parsed.dispositions, n.id) && parsed.dispositions[n.id].kind === 'unsupported' ? [n] : []), ...(n.children ?? []).flatMap(unsupportedIn)]
  const byTerm = new Map<string, SyntaxNode[]>()
  for (const [n, o] of mapping) for (const t of o.terms) byTerm.set(t, [...(byTerm.get(t) ?? []), n])
  for (const [term, nodes] of byTerm) {
    // The deepest node every statement mapping into the term is under (or is).
    const chains = nodes.map(ancestors)
    let depth = 0
    while (chains.every((c) => depth < c.length && c[depth] === chains[0][depth])) depth++
    const roots: SyntaxNode[] = depth ? [chains[0][depth - 1]] : [...new Set(chains.map((c) => c[0]))]
    if (roots.length === 1) {
      // Widened while the parent maps nothing but this term: a term's container with its `from` and `then`.
      for (let up = parent.get(roots[0]); up; up = parent.get(up)) {
        const s = subtree.get(up)!
        if (s.other || [...s.terms].some((t) => t !== term)) break
        roots[0] = up
      }
    }
    for (const n of roots.flatMap(unsupportedIn)) out.push(`parse converted part of a term: ${n.id} is unsupported, but the term's other statements are mapped (${show(term)})`)
  }

  // ---- render: fields, term by term
  if (!rendered) return out
  const kind = (path: string) => (Object.hasOwn(rendered.dispositions, path) ? rendered.dispositions[path].kind : undefined)
  /** Every policy and filter, with what its terms decide, whether a term's skip is safe, and its platform default's leaf. */
  const ordered: { at: string[]; terms: Record<string, unknown> | undefined; whole: unknown; safe: (key: string) => boolean; byDefault: string; what: 'policy' | 'filter'; sees: string }[] = [
    ...Object.entries(model.routingPolicy?.policies ?? {}).map(([name, policy]) => ({ at: ['routingPolicy', 'policies', name], terms: policy?.terms, whole: policy, safe: (key: string) => termSkipSafe(policy, key), byDefault: 'fallThrough', what: 'policy' as const, sees: 'routes' })),
    ...(['ipv4', 'ipv6'] as const).flatMap((family) =>
      Object.entries(model.filters?.[family] ?? {}).map(([name, filter]) => ({ at: ['filters', family, name], terms: filter?.terms, whole: filter, safe: (key: string) => filterTermSkipSafe(filter, key), byDefault: 'implicitAction', what: 'filter' as const, sees: 'packets' }))
    )
  ]
  for (const { at, terms, whole, safe, byDefault, what, sees } of ordered) {
    if (!terms) continue
    const unsafe: string[] = []
    for (const key of Object.keys(terms)) {
      const kinds = populatedLeaves(terms[key], [...at, 'terms', key]).map((l) => kind(l.path))
      const term = fieldPath(...at, 'terms', key)
      if (!kinds.includes('unsupported')) continue
      if (kinds.some((k) => k !== 'unsupported')) out.push(`render converted part of a term: some of ${term}'s fields are unsupported and some aren't`)
      if (!safe(key)) unsafe.push(term)
    }
    if (!unsafe.length) continue
    const platformDefault = fieldPath(...at, byDefault)
    const converted = populatedLeaves(whole, at).filter((l) => kind(l.path) === 'rendered' || (kind(l.path) === 'not-applicable' && l.path !== platformDefault))
    if (converted.length) out.push(`render left out ${unsafe.join(', ')}, which later terms would see ${sees} differently without, but converted the rest of the ${what}: the whole ${what} is unsupported instead (${converted.map((l) => l.path).join(', ')})`)
  }
  return out
}

/** The secrets check on `fixture`: its own secrets, or those its source has by pattern. */
function secretsCheck(plugin: PlatformPlugin, fixture: Fixture, modelVersion: string, options: SecretsOptions): CheckResult {
  const secrets = fixture.secrets ?? findSecrets(fixture.source)
  const missing = secrets.filter((s) => !fixture.source.includes(s)).map((s) => `the secret ${JSON.stringify(s)} isn't in the fixture's source`)
  if (!secrets.length) return { check: 'secrets', status: 'skipped', problems: ['the fixture has no secrets'] }
  const { leaks, allowed } = checkSecrets(plugin, fixture.source, secrets, { ...options, modelVersion, fixture: fixture.name })
  const problems = [...missing, ...leaks.map(describeLeak)]
  return { check: 'secrets', status: problems.length ? 'failed' : 'passed', problems, ...(allowed.length ? { allowed: allowed.map((a) => ({ leak: describeLeak(a.leak), allowance: a.allowance })) } : {}) }
}

/**
 * Every statement and field left out says why (#109, #111): an `unsupported` or `ignored-by-design` disposition with no
 * reason is a problem, so the user never sees a bare "not converted". By line or field path, never the statement's text.
 */
function unexplained(ledger: ReturnType<typeof buildLedger>): string[] {
  const bare = (d: { readonly kind: string; readonly reason?: string } | null) => (d?.kind === 'unsupported' || d?.kind === 'ignored-by-design') && !d.reason?.trim()
  return [
    ...ledger.source.statements.filter((s) => bare(s.disposition)).map((s) => `${s.span ? `line ${s.span.startLine}` : `statement ${s.id}`}: ${s.disposition!.kind} with no reason`),
    ...(ledger.target?.fields ?? []).filter((f) => bare(f.disposition)).map((f) => `${f.path}: ${f.disposition!.kind} with no reason`)
  ]
}

/**
 * The five checks on `fixture` with `plugin`, against the core's model version (tests pass another), with the
 * secrets check's options: its temporary allowances (tests pass their own) and the plugin's config tools.
 */
export function checkFixture(plugin: PlatformPlugin, fixture: Fixture, { modelVersion = MODEL_VERSION, ...options }: SecretsOptions & { modelVersion?: string } = {}): CheckResult[] {
  const context: Context = { modelVersion }
  const result = (check: CheckName, problems: string[]): CheckResult => ({ check, status: problems.length ? 'failed' : 'passed', problems })
  const skipped = (check: CheckName, why: string): CheckResult => ({ check, status: 'skipped', problems: [why] })
  if (!plugin.parse || !plugin.render) {
    const missing = `the plugin has no ${!plugin.parse ? 'parse' : 'render'}()`
    return [...(['parse', 'render', 'round-trip', 'ledger'] as const).map((c) => result(c, [missing])), secretsCheck(plugin, fixture, modelVersion, options)]
  }

  // An error a step reports fails its check, whatever its output matches: warnings and info don't.
  const errors = (step: string, r: { diagnostics: readonly { severity: string; message: string }[] }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${step} error: ${d.message}`)

  // What core's modelProblems() finds in a model a step made: a VRF that isn't declared, a malformed route distinguisher.
  // A BGP policy name resolves to a policy only for a plugin that parses routing policy (model 0.5.0): one that doesn't
  // keeps the names alone, as phase 2 did.
  const policyReferences = (plugin.capabilities['routing-policy']?.parse ?? 'none') !== 'none'
  const invalid = (step: string, model: Device) => modelProblems(model, { policyReferences }).map((d) => `${step} made an invalid model: ${d.message} (${d.field})`)

  const parsed = plugin.parse(fixture.source, context)
  const checks: CheckResult[] = [result('parse', [...errors('parse', parsed), ...invalid('parse', parsed.model), ...modelDifferences(fixture.expectedModel, parsed.model)])]

  const rendered = plugin.render(parsed.model, context)
  const renderErrors = errors('render', rendered)
  checks.push(
    fixture.expectedRender === undefined && !renderErrors.length
      ? skipped('render', 'the fixture has no expected render')
      : result('render', [
          ...renderErrors,
          ...(fixture.expectedRender === undefined || lf(rendered.text) === lf(fixture.expectedRender) ? [] : [`rendered text differs from the expected render:\n--- expected\n${lf(fixture.expectedRender)}\n--- got\n${lf(rendered.text)}`])
        ])
  )

  const reparsed = plugin.parse(rendered.text, context)
  const deferred = deferredSecrets(parsed.model, rendered)
  const emptied = new Set<string>()
  // The parse without its deferred keys, and the objects only they filled: the reparse may have those or not.
  const expected = without(parsed.model, new Set(deferred), emptied)
  const roundTrip = result('round-trip', [...errors('reparse', reparsed), ...invalid('reparse', reparsed.model), ...modelDifferences(expected, withoutEmptied(reparsed.model, emptied)).map((d) => `render → reparse changed the model: ${d}`)])
  checks.push(deferred.length ? { ...roundTrip, deferred } : roundTrip)

  const ledger = buildLedger(parsed, rendered)
  checks.push(result('ledger', [...ledgerProblems(ledger), ...unexplained(ledger), ...termProblems(parsed, rendered)]))
  checks.push(secretsCheck(plugin, fixture, modelVersion, options))
  return checks
}
