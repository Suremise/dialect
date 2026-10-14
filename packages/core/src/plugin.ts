// The platform plugin interface: what each platform package (`@dialect/platform-*`) exports as its default export.
// Plugins take and return strings and plain objects, with no file system, DOM or Node APIs, so the same plugin runs in
// the CLI, the desktop app's webview and the browser. File access lives in the shells.
import type { PortName } from './convert'
import type { Device } from './model'
import type { Context, Diagnostic, ParseResult, RenderResult } from './results'

/**
 * The model's feature areas, as capabilities name them. Minor model versions add areas (0.2.0: `dns`; 0.4.0: `vlans`,
 * with switch ports and IRB/SVI interfaces, `ospf` and `bgp`; 0.5.0: `routing-policy`, prefix lists, community and
 * AS-path sets and policies). A plugin that parses `routing-policy` has every BGP policy name resolve to a policy of
 * its model (the conformance kit checks).
 */
export type FeatureArea = 'system' | 'interfaces' | 'static-routes' | 'dns' | 'ntp' | 'syslog' | 'snmp' | 'vlans' | 'ospf' | 'bgp' | 'routing-policy'

/** How much of an area a plugin handles. */
export type Support = 'full' | 'partial' | 'none'

/**
 * Per feature area, how far the plugin parses and renders it: the UI warns before converting ("NX-OS renderer: BGP
 * partial") and the docs' feature matrix comes from it. An area left out is `none`.
 */
export type Capabilities = Readonly<Partial<Record<FeatureArea, { readonly parse: Support; readonly render: Support }>>>

/**
 * A platform-only action that doesn't go through the shared model, such as Junos display set (hierarchical → `set`
 * commands). The UI shows each as its own mode.
 */
export interface Tool {
  /** Unique within its plugin: `display-set`. */
  readonly id: string
  /** For menus: `Display set`. */
  readonly name: string
  readonly description?: string
  run(input: string, options?: Readonly<Record<string, unknown>>): ToolResult
}

export interface ToolResult {
  readonly text: string
  /** Errors (with where, as a span) and warnings; an error means `text` may be incomplete. */
  readonly diagnostics: readonly Diagnostic[]
  /**
   * The 1-based source line each line of `text` comes from, in order, for linking the output to its source (the UI marks
   * a set line's statement). Left out when the tool doesn't track it. A line break is `\n`, `\r\n` or `\r`, as the
   * editors count them, and a final line break starts no line.
   */
  readonly sourceLines?: readonly number[]
}

export interface PlatformPlugin {
  /** Unique: `junos`, `iosxe`, `nxos`, `iosxr`. */
  readonly id: string
  /** For people: `Cisco IOS / IOS-XE`. */
  readonly name: string
  /** The model versions it supports, as a semver range: `>=0.1.0 <1.0.0` (model.ts says why not `^0.1.0`). */
  readonly modelApi: string
  readonly capabilities: Capabilities
  /** How likely `text` is this platform's config, from 0 to 1, for auto-detect. Without it, never detected. */
  detect?(text: string): number
  /** Source text → syntax tree, model and a disposition per statement. Without it, the plugin can't convert from. */
  parse?(text: string, context: Context): ParseResult
  /** Model → text and a disposition per populated field. Without it, the plugin can't convert to. */
  render?(model: Device, context: Context): RenderResult
  /** What one of its interface names says (type, speed, numbers), so a target can suggest a name for it (convert.ts). */
  describeInterface?(name: string): PortName | undefined
  /** Its own name for a port another plugin described, as a suggestion only; undefined when it has none. */
  nameInterface?(port: PortName): string | undefined
  /** Its platform-only tools; none when left out. */
  tools?(): readonly Tool[]
}
