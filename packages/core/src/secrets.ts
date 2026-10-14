// The secret safety net (#115): no text leaving a plugin may hold a secret value from the config (AGENTS.md, No
// secrets in diagnostics). Plugins keep their own care, and the conformance kit checks it; this is the net under it.
// guardPlugin() wraps a plugin's parse, render and tools, and replaces every reason, diagnostic message and needs-input
// message that holds a secret candidate of the config, in any case, with a fixed withheld text. createRegistry() and
// convert() apply it, so every shell's plugin calls go through it.
//
// The rendered config, and a tool's text, are the config itself and keep their values: a tool doesn't say whether its
// text is config (display set) or a report, so only its diagnostics are guarded. Statement labels, field paths and
// interface names name the config's own structure and are left as they are.
import type { PortName } from './convert'
import type { Device } from './model'
import type { PlatformPlugin, Tool, ToolResult } from './plugin'
import type { Context, Diagnostic, FieldDisposition, NeedsInput, ParseResult, RenderResult, StatementDisposition } from './results'

/** Shorter values than this aren't taken as secrets by pattern: `RO`, a key number. */
export const MIN_SECRET_LENGTH = 4

// Secret values in Junos (hierarchical or set) and IOS-style configs, each pattern's last group the value. Best
// effort: a conformance fixture whose secrets these miss, or that they over-match, lists its own in
// `<case>.secrets.json`.
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
  // … }`, nor `community X;` in a policy term), or `community X` where a text cut short ends.
  /\bsnmp-server[ \t]+community[ \t]+(\S+)/gi,
  /\bsnmp[ \t]+community[ \t]+("?)([^\s"]+)\1/gi,
  /(?<![\w-])community[ \t]+("?)([^\s";{]+)\1(?:[ \t]*\{(?!\s*members\b)|\s*$)/gi,
  // TACACS+/RADIUS keys on IOS's one-line forms, and NTP authentication keys.
  /\b(?:tacacs-server|radius-server)\b[^\n]*?\bkey[ \t]+(?:\d[ \t]+)?(\S+)/gi,
  /\bntp[ \t]+authentication-key[ \t]+\d+[ \t]+(?!type\b)\S+[ \t]+(\S+)/gi,
  /(?<![\w-])authentication-key[ \t]+\d+[ \t]+type[ \t]+\S+[ \t]+value[ \t]+("?)([^\s";]+)\1/gi,
  // Junos secrets, quoted or not: `secret …`, `authentication-key …`, `encrypted-password …`, a pre-shared key's
  // `ascii-text …` or `hexadecimal …`, `simple-password …`; and a quoted `key "…"`, its quote closed or left open to the
  // end of its line (a text cut short, where a parser's "unterminated quoted string" would be about its words).
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal)[ \t]+("?)([^\s";]+)\1/gi,
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal|key)[ \t]+"([^"]+)"/gi,
  /(?<![\w-])(?:secret|authentication-key|encrypted-password|simple-password|ascii-text|hexadecimal|key)[ \t]+"([^"\r\n]+)$/gim
]

/**
 * The secret values in `source`, by pattern, unquoted, each once, in the order found. A secret stays one wherever else
 * the source has its value (a description, a comment, a VRF of the same name): a message quoting it there discloses it
 * all the same. The conformance kit takes a fixture's secrets from here when it doesn't list its own.
 */
export function findSecrets(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of PATTERNS)
    for (const m of source.matchAll(pattern)) {
      const value = m[m.length - 1].replace(/^"|"$/g, '')
      if (value.length >= MIN_SECRET_LENGTH) found.add(value)
    }
  return [...found]
}

/**
 * What the safety net looks for in `source`'s messages: each secret findSecrets() gives, as found and trimmed, those
 * of MIN_SECRET_LENGTH or more, lowercased (messages are matched in any case).
 */
export function secretCandidates(source: string): string[] {
  const out = new Set<string>()
  for (const secret of findSecrets(source))
    for (const form of [secret, secret.trim()]) if (form.length >= MIN_SECRET_LENGTH) out.add(form.toLowerCase())
  return [...out]
}

/** A reason that would repeat a secret: the same words as the Junos and IOS-XR plugins' own (#114). */
export const WITHHELD_REASON = 'a statement whose reason is withheld, as it would repeat a value of this configuration'
/** A diagnostic's or a needs-input item's message that would repeat a secret: where it is stays in its span and fields. */
export const WITHHELD_MESSAGE = 'This message is withheld, as it would repeat a value of this configuration.'
/**
 * The text of last resort, when a secret is in the withheld text too (an SNMP community named `this`): one character
 * long, which no candidate (MIN_SECRET_LENGTH or more) is.
 */
const LAST_RESORT = '—'

const holds = (text: string, secrets: readonly string[]) => {
  const lower = text.toLowerCase()
  return secrets.some((s) => lower.includes(s))
}

/** `text`, or `withheld` when it holds one of `secrets` (secretCandidates()), or LAST_RESORT when that does too. */
function guarded(text: string, secrets: readonly string[], withheld: string): string {
  if (!holds(text, secrets)) return text
  return holds(withheld, secrets) ? LAST_RESORT : withheld
}

/** `diagnostics` with each message that holds one of `secrets` withheld; the same array when none does. */
export function guardDiagnostics(diagnostics: readonly Diagnostic[], secrets: readonly string[]): readonly Diagnostic[] {
  if (!secrets.length || !diagnostics.some((d) => holds(d.message, secrets))) return diagnostics
  return diagnostics.map((d) => (holds(d.message, secrets) ? { ...d, message: guarded(d.message, secrets, WITHHELD_MESSAGE) } : d))
}

/** `items` with each message that holds one of `secrets` withheld, and each such suggestion dropped. */
export function guardNeedsInput(items: readonly NeedsInput[], secrets: readonly string[]): readonly NeedsInput[] {
  if (!secrets.length) return items
  return items.map((item) => {
    const leaks = holds(item.message, secrets) || (item.suggestions ?? []).some((s) => holds(s, secrets))
    if (!leaks) return item
    const { suggestions, ...rest } = item
    const kept = (suggestions ?? []).filter((s) => !holds(s, secrets))
    return { ...rest, message: guarded(item.message, secrets, WITHHELD_MESSAGE), ...(kept.length ? { suggestions: kept } : {}) }
  })
}

/** `dispositions` (statements' or fields') with each reason that holds one of `secrets` withheld. */
function guardReasons<D extends StatementDisposition | FieldDisposition>(dispositions: Readonly<Record<string, D>>, secrets: readonly string[]): Readonly<Record<string, D>> {
  if (!secrets.length) return dispositions
  const ids = Object.keys(dispositions).filter((id) => {
    const d = dispositions[id]
    return 'reason' in d && d.reason !== undefined && holds(d.reason, secrets)
  })
  if (!ids.length) return dispositions
  // A copy with the same keys and none from Object.prototype: statement ids and field paths are the config's names.
  const out = Object.assign(Object.create(null) as Record<string, D>, dispositions)
  for (const id of ids) {
    const d = dispositions[id] as D & { reason: string }
    out[id] = { ...d, reason: guarded(d.reason, secrets, WITHHELD_REASON) }
  }
  return out
}

/** `parse` with its reasons and messages guarded against `secrets` (secretCandidates() of its source). */
export function guardParse(parse: ParseResult, secrets: readonly string[]): ParseResult {
  if (!secrets.length) return parse
  return { ...parse, dispositions: guardReasons(parse.dispositions, secrets), diagnostics: guardDiagnostics(parse.diagnostics, secrets), ...(parse.needsInput ? { needsInput: guardNeedsInput(parse.needsInput, secrets) } : {}) }
}

/** `render` with its reasons and messages guarded against `secrets`. Its text, the config, is kept as it is. */
export function guardRender(render: RenderResult, secrets: readonly string[]): RenderResult {
  if (!secrets.length) return render
  return { ...render, dispositions: guardReasons(render.dispositions, secrets), diagnostics: guardDiagnostics(render.diagnostics, secrets), ...(render.needsInput ? { needsInput: guardNeedsInput(render.needsInput, secrets) } : {}) }
}

/**
 * Runs `step`; an error it throws whose message holds one of `secrets()` is thrown as a plain Error, withheld. For a
 * caller that knows a plugin call's source when the plugin can't (convert()'s render of the renamed model).
 */
export function guardThrown<T>(step: () => T, secrets: () => readonly string[]): T {
  try {
    return step()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // No `cause`: the original error's message is the secret this withholds.
    // oxlint-disable-next-line preserve-caught-error
    if (holds(message, secrets())) throw new Error(guarded(message, secrets(), WITHHELD_MESSAGE))
    throw e
  }
}

/** The plugins guardPlugin() made, so it never wraps one twice, and each plugin's, so it gives one the same each time. */
const GUARDED = new WeakSet<PlatformPlugin>()
const GUARDS = new WeakMap<PlatformPlugin, PlatformPlugin>()

/** The secret candidates of the source each guarded parse's model came from, for a render of that model. */
const MODEL_SECRETS = new WeakMap<Device, readonly string[]>()

/** `tool` with its diagnostics guarded against its input's secrets. Its text may be config and is kept as it is. */
function guardTool(tool: Tool): Tool {
  return {
    id: tool.id,
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    run(input, options) {
      const secrets = secretCandidates(input)
      const ran: ToolResult = guardThrown(() => tool.run(input, options), () => secrets)
      return { ...ran, diagnostics: guardDiagnostics(ran.diagnostics, secrets) }
    }
  }
}

/**
 * `plugin` with the safety net: a parse's reasons and messages never hold a secret of its source; a render's never
 * hold one of the source its model was parsed from (by this plugin or another guarded one) or of its own text; a
 * tool's diagnostics never hold one of its input; nor does an error any of them throws. The same plugin when it is
 * already guarded, and the same guarded plugin for a plugin each time. Everything else (id, detect, interface names)
 * is the plugin's own.
 */
export function guardPlugin(plugin: PlatformPlugin): PlatformPlugin {
  if (GUARDED.has(plugin)) return plugin
  const made = GUARDS.get(plugin)
  if (made) return made
  const { parse, render, tools } = plugin
  const guardedPlugin: PlatformPlugin = {
    id: plugin.id,
    name: plugin.name,
    modelApi: plugin.modelApi,
    capabilities: plugin.capabilities,
    ...(plugin.detect ? { detect: (text: string) => plugin.detect!(text) } : {}),
    ...(parse
      ? {
          parse(text: string, context: Context) {
            const secrets = secretCandidates(text)
            const result = guardParse(guardThrown(() => parse.call(plugin, text, context), () => secrets), secrets)
            if (secrets.length) MODEL_SECRETS.set(result.model, secrets)
            return result
          }
        }
      : {}),
    ...(render
      ? {
          render(model: Device, context: Context) {
            const known = MODEL_SECRETS.get(model) ?? []
            const result = guardThrown(() => render.call(plugin, model, context), () => known)
            return guardRender(result, [...new Set([...known, ...secretCandidates(result.text)])])
          }
        }
      : {}),
    ...(plugin.describeInterface ? { describeInterface: (name: string) => plugin.describeInterface!(name) } : {}),
    ...(plugin.nameInterface ? { nameInterface: (port: PortName) => plugin.nameInterface!(port) } : {}),
    ...(tools ? { tools: () => tools.call(plugin).map(guardTool) } : {})
  }
  GUARDED.add(guardedPlugin)
  GUARDS.set(plugin, guardedPlugin)
  return guardedPlugin
}
