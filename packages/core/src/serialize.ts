// The model as JSON: fixtures (`<case>.model.json`), and saved sessions if we add them. Every serialised model carries
// the `modelVersion` it was made with, so fixtures can be upgraded by script. A model can be read by a core of the same
// major version and the same or a later minor (minor versions only add, model.ts); a newer one is refused rather than
// read with fields this core would drop.
import parse from 'semver/functions/parse'
import { MODEL_VERSION, type Device } from './model'

/** A serialised model. */
export interface ModelDocument {
  readonly modelVersion: string
  readonly device: Device
}

/** `device` as a JSON document with this core's model version, indented, with a final newline. */
export function serializeModel(device: Device, modelVersion: string = MODEL_VERSION): string {
  const doc: ModelDocument = { modelVersion, device }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Why a document made with model `version` can't be read by a core at `current`, or null when it can. */
export function modelVersionProblem(version: unknown, current: string = MODEL_VERSION): string | null {
  const v = typeof version === 'string' ? parse(version) : null
  if (!v) return `The model document has no valid modelVersion (${JSON.stringify(version)}).`
  const c = parse(current)
  if (!c) return `This core's model version ${current} isn't valid.`
  if (v.major !== c.major) return `The model document was made with model ${version}, and this core's model is ${current}: a different major version.`
  if (v.compare(c) > 0) return `The model document was made with model ${version}, newer than this core's ${current}.`
  return null
}

/** The device in a JSON document (text or already parsed). Throws when it isn't one, or its version can't be read. */
export function deserializeModel(json: string | unknown, current: string = MODEL_VERSION): ModelDocument {
  const doc: unknown = typeof json === 'string' ? JSON.parse(json) : json
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new TypeError('A model document is a JSON object.')
  // Own properties only: a document's fields never come from Object.prototype.
  const own = (key: string): unknown => (Object.hasOwn(doc, key) ? (doc as Record<string, unknown>)[key] : undefined)
  const modelVersion = own('modelVersion')
  const device = own('device')
  const problem = modelVersionProblem(modelVersion, current)
  if (problem) throw new TypeError(problem)
  if (typeof device !== 'object' || device === null || Array.isArray(device)) throw new TypeError('A model document has a "device" object.')
  return { modelVersion: modelVersion as string, device: device as Device }
}
