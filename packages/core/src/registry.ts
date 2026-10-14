// The plugin registry. Plugins are built in at first: each shell imports the platform packages and hands the list to
// createRegistry(). The registry refuses a plugin whose `modelApi` range doesn't include the core's MODEL_VERSION, with a
// message naming both, so a plugin built for another model never runs against this one.
import satisfies from 'semver/functions/satisfies'
import validRange from 'semver/ranges/valid'
import { MODEL_VERSION } from './model'
import type { PlatformPlugin, Tool } from './plugin'

/** Why a plugin was refused. */
export class PluginRejectedError extends Error {
  readonly pluginId: string
  constructor(pluginId: string, message: string) {
    super(message)
    this.name = 'PluginRejectedError'
    this.pluginId = pluginId
  }
}

/** Why `plugin` can't load against the model `modelVersion`, or null when it can. */
export function pluginProblem(plugin: PlatformPlugin, modelVersion: string = MODEL_VERSION): string | null {
  const name = `Plugin "${plugin.id}"`
  if (!plugin.id) return 'A plugin has no id.'
  if (typeof plugin.modelApi !== 'string' || !validRange(plugin.modelApi)) return `${name} gives no valid model version range (modelApi "${String(plugin.modelApi)}"); this core's model is ${modelVersion}.`
  if (!satisfies(modelVersion, plugin.modelApi)) return `${name} supports model versions ${plugin.modelApi}, but this core's model is ${modelVersion}.`
  const toolIds = (plugin.tools?.() ?? []).map((t) => t.id)
  const twice = toolIds.find((id, i) => toolIds.indexOf(id) !== i)
  if (twice) return `${name} has two tools with the id "${twice}".`
  return null
}

export interface Registry {
  /** The core's model version the plugins were checked against. */
  readonly modelVersion: string
  /** Every plugin, in the order given. */
  list(): readonly PlatformPlugin[]
  get(id: string): PlatformPlugin | undefined
  /** The plugins that can parse (sources) or render (targets). */
  sources(): readonly PlatformPlugin[]
  targets(): readonly PlatformPlugin[]
  /** Every plugin's tools, with the plugin each belongs to. */
  tools(): readonly { readonly plugin: PlatformPlugin; readonly tool: Tool }[]
  /** The plugins that detect `text`, most likely first, with their scores (above 0 only). */
  detect(text: string): readonly { readonly plugin: PlatformPlugin; readonly score: number }[]
}

/**
 * A registry of `plugins`, checked against the model version (the core's MODEL_VERSION; tests pass another). Throws
 * PluginRejectedError for the first plugin that can't load or whose id is taken.
 */
export function createRegistry(plugins: readonly PlatformPlugin[], { modelVersion = MODEL_VERSION }: { modelVersion?: string } = {}): Registry {
  const byId = new Map<string, PlatformPlugin>()
  for (const plugin of plugins) {
    const problem = pluginProblem(plugin, modelVersion)
    if (problem) throw new PluginRejectedError(plugin.id, problem)
    if (byId.has(plugin.id)) throw new PluginRejectedError(plugin.id, `Two plugins have the id "${plugin.id}".`)
    byId.set(plugin.id, plugin)
  }
  const all = [...byId.values()]
  return {
    modelVersion,
    list: () => all,
    get: (id) => byId.get(id),
    sources: () => all.filter((p) => p.parse),
    targets: () => all.filter((p) => p.render),
    tools: () => all.flatMap((plugin) => (plugin.tools?.() ?? []).map((tool) => ({ plugin, tool }))),
    detect: (text) =>
      all
        .map((plugin) => ({ plugin, score: plugin.detect ? Math.min(1, Math.max(0, plugin.detect(text))) : 0 }))
        .filter((d) => d.score > 0)
        .sort((a, b) => b.score - a.score)
  }
}
