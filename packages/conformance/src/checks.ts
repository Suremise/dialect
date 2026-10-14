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
//    disposition (core's ledger.ts, which doesn't trust the plugin's own count);
// 5. no secret: none of the fixture's secret values is in a diagnostic, needs-input item, ledger reason, tool
//    diagnostic, tool report (a tool's text, unless it is a config tool's) or thrown error, on the fixture or on broken copies of it (secrets.ts). Skipped for a fixture with none.
// An error a step reports fails its check even when its output matches: a plugin that says it failed isn't conformant.
import { buildLedger, fieldPath, ledgerProblems, MODEL_VERSION, modelProblems, populatedLeaves, type Context, type Device, type PlatformPlugin, type RenderResult } from '@dialect/core'
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

/** `model` without the leaves at `paths` (field paths), as a copy: null-prototype objects, own keys only. */
function without(model: unknown, paths: ReadonlySet<string>, at: readonly string[] = []): unknown {
  if (!isObject(model) || !paths.size) return model
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(model)) {
    const segments = [...at, key]
    if (!paths.has(fieldPath(...segments))) out[key] = without(own(model, key), paths, segments)
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
  const invalid = (step: string, model: Device) => modelProblems(model).map((d) => `${step} made an invalid model: ${d.message} (${d.field})`)

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
  const roundTrip = result('round-trip', [...errors('reparse', reparsed), ...invalid('reparse', reparsed.model), ...modelDifferences(without(parsed.model, new Set(deferred)), reparsed.model).map((d) => `render → reparse changed the model: ${d}`)])
  checks.push(deferred.length ? { ...roundTrip, deferred } : roundTrip)

  checks.push(result('ledger', ledgerProblems(buildLedger(parsed, rendered))))
  checks.push(secretsCheck(plugin, fixture, modelVersion, options))
  return checks
}
