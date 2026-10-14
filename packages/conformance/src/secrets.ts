// The secrets check: no diagnostic, needs-input item, ledger reason, tool diagnostic or tool report may contain a
// secret value from the config (AGENTS.md, No secrets in diagnostics). The rendered config, and the text of a tool the
// caller names as giving config (`configTools`), are the config itself and aren't checked; statement labels and field
// paths name the config's own structure and aren't either.
//
// A fixture's secrets are listed in `<case>.secrets.json` (fixtures.ts), or else found in its source by pattern
// (findSecrets). Leaks are looked for in the fixture as it is and in broken copies of it (cut just after a secret, an
// unterminated quote after one), since a syntax error is where a message most often quotes the line it's on.
import { MODEL_VERSION, type Context, type Diagnostic, type NeedsInput, type PlatformPlugin } from '@dialect/core'
import { SECRET_ALLOWANCES, type SecretAllowance } from './allowances'

/** Which output a leak is in. */
export type LeakSite = 'parse diagnostic' | 'parse needs-input' | 'statement reason' | 'render diagnostic' | 'render needs-input' | 'field reason' | 'tool diagnostic' | 'tool text' | 'thrown error'

/** The input a leak was found on: the fixture, or one of its broken copies. */
export type LeakInput = 'fixture' | 'cut after a secret' | 'unterminated quote after a secret'

/** A secret found in a message. */
export interface Leak {
  readonly site: LeakSite
  /** The diagnostic's code, when it has one. */
  readonly code?: string
  /** The tool's id, for a tool diagnostic or text. */
  readonly tool?: string
  readonly input: LeakInput
  readonly secret: string
  /** The message it is in. */
  readonly text: string
}

/** What checkSecrets found: leaks, and leaks an allowance lets through (with the allowance). */
export interface SecretsResult {
  readonly leaks: readonly Leak[]
  readonly allowed: readonly { readonly leak: Leak; readonly allowance: SecretAllowance }[]
}

/** The secrets check's settings, beside the model version: checkFixture() and describeConformance() pass them on. */
export interface SecretsOptions {
  /** Temporary allowances (allowances.ts); SECRET_ALLOWANCES when left out. */
  readonly allowances?: readonly SecretAllowance[]
  /**
   * The ids of the plugin's tools whose text is a config (display set: Junos `set` commands), which keeps the config's
   * values. Every other tool's text is a report, checked like a diagnostic. None when left out.
   */
  readonly configTools?: readonly string[]
}

/** Shorter values than this aren't taken as secrets by pattern: `RO`, a key number. */
const MIN_LENGTH = 4

// Secret values in Junos (hierarchical or set) and IOS-style configs, each pattern's last group the value. Best
// effort: a fixture whose secrets these miss, or that they over-match, lists its own in `<case>.secrets.json`.
const PATTERNS: readonly RegExp[] = [
  // crypt(3)-style hashes and Junos `$9$`: `$1$…`, `$5$…`, `$6$…`, Cisco type 8/9 `$8$…`, `$9$…`.
  /(\$(?:\d+|sha1|y|2[aby]?)\$[^\s"';]+)/g,
  // IOS `password|secret|key|key-string <type> <value>` at the end of its line, type 0, 5, 7, 8 or 9 (not
  // `authentication-key 1 …`, nor Junos's `key 0 secret …`).
  /(?<![\w-])(?:password|secret|key|key-string)[ \t]+\d[ \t]+(\S+)[ \t]*$/gim,
  // IOS without a type: `enable secret|password X`, `username U [privilege N] secret|password X`, a line's
  // `password [encrypted] X`.
  /\benable[ \t]+(?:secret|password)[ \t]+(?!\d\s)(?:level[ \t]+\d+[ \t]+)?(\S+)/gi,
  /\busername[ \t]+\S+(?:[ \t]+privilege[ \t]+\d+)?[ \t]+(?:secret|password)[ \t]+(?!\d\s)(\S+)/gi,
  /^[ \t]*password[ \t]+(?!\d\s)(?:encrypted[ \t]+)?(\S+)/gim,
  // SNMP communities: IOS, Junos set form, Junos hierarchical `community X {` (not a policy's `community X { members
  // … }`, nor `community X;` in a policy term).
  /\bsnmp-server[ \t]+community[ \t]+(\S+)/gi,
  /\bsnmp[ \t]+community[ \t]+("?)([^\s"]+)\1/gi,
  /(?<![\w-])community[ \t]+("?)([^\s";{]+)\1[ \t]*\{(?!\s*members\b)/gi,
  // TACACS+/RADIUS keys on IOS's one-line forms, and NTP authentication keys.
  /\b(?:tacacs-server|radius-server)\b[^\n]*?\bkey[ \t]+(?:\d[ \t]+)?(\S+)/gi,
  /\bntp[ \t]+authentication-key[ \t]+\d+[ \t]+(?!type\b)\S+[ \t]+(\S+)/gi,
  /(?<![\w-])authentication-key[ \t]+\d+[ \t]+type[ \t]+\S+[ \t]+value[ \t]+("?)([^\s";]+)\1/gi,
  // Junos secrets, quoted or not: `secret …`, `authentication-key …`, `encrypted-password …`, a pre-shared key's
  // `ascii-text …` or `hexadecimal …`, `simple-password …`; and a quoted `key "…"`.
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal)[ \t]+("?)([^\s";]+)\1/gi,
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal|key)[ \t]+"([^"]+)"/gi
]

/**
 * The secret values in `source`, by pattern, each once, in the order found. A secret stays one wherever else the source
 * has its value (a description, a comment, a VRF of the same name): a message quoting it there discloses it all the same.
 */
export function findSecrets(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of PATTERNS)
    for (const m of source.matchAll(pattern)) {
      const value = m[m.length - 1].replace(/^"|"$/g, '')
      if (value.length >= MIN_LENGTH) found.add(value)
    }
  return [...found]
}

/** The broken copies of `source` a leak is also looked for in: for each secret, cut just after it, and a quote opened after it. */
function brokenCopies(source: string, secrets: readonly string[]): { input: LeakInput; text: string }[] {
  const copies = new Map<string, LeakInput>()
  for (const secret of secrets) {
    const at = source.indexOf(secret)
    if (at < 0) continue
    const end = at + secret.length
    if (!copies.has(source.slice(0, end))) copies.set(source.slice(0, end), 'cut after a secret')
    copies.set(`${source.slice(0, end)} "${source.slice(end)}`, 'unterminated quote after a secret')
  }
  return [...copies].map(([text, input]) => ({ input, text }))
}

/** Whether `allowance` covers `leak`, found on the fixture named `fixture`. */
const covers = (plugin: string, fixture: string | undefined, allowance: SecretAllowance, leak: Leak) =>
  allowance.plugin === plugin &&
  allowance.site === leak.site &&
  (allowance.code === undefined || allowance.code === leak.code) &&
  (allowance.tool === undefined || allowance.tool === leak.tool) &&
  (allowance.fixtures === undefined || (fixture !== undefined && allowance.fixtures.includes(fixture)))

/**
 * Runs `plugin`'s parse, render (of the parse's model) and tools on `source` and its broken copies, and finds each of
 * `secrets` in what they say: diagnostics, needs-input items, dispositions' reasons, thrown errors and the text of a
 * tool that isn't one of `configTools`. Not in the render's text or a config tool's, the config itself. `fixture` is
 * the fixture's name, for allowances that name theirs.
 */
export function checkSecrets(plugin: PlatformPlugin, source: string, secrets: readonly string[], { modelVersion = MODEL_VERSION, allowances = SECRET_ALLOWANCES, configTools = [], fixture }: SecretsOptions & { modelVersion?: string; fixture?: string } = {}): SecretsResult {
  const context: Context = { modelVersion }
  const leaks: Leak[] = []
  const seen = new Set<string>()
  const scan = (input: LeakInput, site: LeakSite, text: string | undefined, extra: { code?: string; tool?: string } = {}) => {
    if (!text) return
    for (const secret of secrets) {
      if (!text.includes(secret)) continue
      const leak: Leak = { site, ...(extra.code !== undefined ? { code: extra.code } : {}), ...(extra.tool !== undefined ? { tool: extra.tool } : {}), input, secret, text }
      // A secret in the same kind of message (site, code, tool) is one leak, reported for the first input it's on.
      const key = JSON.stringify([site, extra.code, extra.tool, secret])
      if (!seen.has(key)) leaks.push(leak)
      seen.add(key)
    }
  }
  const diagnostics = (input: LeakInput, site: LeakSite, list: readonly Diagnostic[], tool?: string) => {
    for (const d of list) scan(input, site, d.message, { ...(d.code !== undefined ? { code: d.code } : {}), ...(tool !== undefined ? { tool } : {}) })
  }
  const needsInput = (input: LeakInput, site: LeakSite, list: readonly NeedsInput[] = []) => {
    for (const n of list) for (const text of [n.message, ...(n.suggestions ?? [])]) scan(input, site, text)
  }
  /** Runs `step`; a thrown error's message is scanned too. */
  const guarded = (input: LeakInput, step: () => void) => {
    try {
      step()
    } catch (e) {
      scan(input, 'thrown error', e instanceof Error ? e.message : String(e))
    }
  }

  for (const { input, text } of [{ input: 'fixture' as const, text: source }, ...brokenCopies(source, secrets)]) {
    guarded(input, () => {
      if (!plugin.parse) return
      const parsed = plugin.parse(text, context)
      diagnostics(input, 'parse diagnostic', parsed.diagnostics)
      needsInput(input, 'parse needs-input', parsed.needsInput)
      for (const d of Object.values(parsed.dispositions)) if (d.kind !== 'mapped') scan(input, 'statement reason', d.reason)
      if (!plugin.render) return
      const rendered = plugin.render(parsed.model, context)
      diagnostics(input, 'render diagnostic', rendered.diagnostics)
      needsInput(input, 'render needs-input', rendered.needsInput)
      for (const d of Object.values(rendered.dispositions)) if (d.kind !== 'rendered') scan(input, 'field reason', d.reason)
    })
    for (const tool of plugin.tools?.() ?? [])
      guarded(input, () => {
        const ran = tool.run(text)
        diagnostics(input, 'tool diagnostic', ran.diagnostics, tool.id)
        if (!configTools.includes(tool.id)) scan(input, 'tool text', ran.text, { tool: tool.id })
      })
  }

  const result: { leaks: Leak[]; allowed: { leak: Leak; allowance: SecretAllowance }[] } = { leaks: [], allowed: [] }
  for (const leak of leaks) {
    const allowance = allowances.find((a) => covers(plugin.id, fixture, a, leak))
    if (allowance) result.allowed.push({ leak, allowance })
    else result.leaks.push(leak)
  }
  return result
}

/** A leak in words, for reports and test failures. */
export function describeLeak(leak: Leak): string {
  const what = leak.site === 'tool diagnostic' ? `tool ${leak.tool} diagnostic` : leak.site === 'tool text' ? `tool ${leak.tool} text` : leak.site
  const on = leak.input === 'fixture' ? 'the fixture' : leak.input === 'cut after a secret' ? 'the fixture cut just after a secret' : 'the fixture with a quote opened after a secret'
  return `${what}${leak.code ? ` (${leak.code})` : ''} on ${on} contains the secret ${JSON.stringify(leak.secret)}: ${JSON.stringify(leak.text)}`
}
