// Builds the model as plain objects, by path, naming each field as the core does (fieldPath). Keys come from the
// configuration (interface, community, instance and server names), so every access is to own properties only: a key
// such as `__proto__` or `constructor` is an ordinary key, never Object.prototype's.
import { fieldPath } from '@dialect/core'

export type Obj = { [key: string]: unknown }
export type Segments = readonly string[]

export const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A key's own value: never one inherited from Object.prototype. */
export const ownValue = (o: Obj, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)
/**
 * Sets an own, enumerable property, as JSON.parse would: plain assignment of `__proto__` would set the object's
 * prototype instead (or, through an inherited object, write to Object.prototype itself).
 */
const putOwn = (o: Obj, key: string, value: unknown) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })

export class ModelBuilder {
  readonly root: Obj = {}

  /** The object at `segments`, created (with its parents) if missing. */
  object(segments: Segments): Obj {
    let at = this.root
    for (const s of segments) {
      let next = ownValue(at, s)
      if (!isObject(next)) putOwn(at, s, (next = {}))
      at = next as Obj
    }
    return at
  }

  get(segments: Segments): unknown {
    let at: unknown = this.root
    for (const s of segments) {
      if (!isObject(at)) return undefined
      at = ownValue(at, s)
    }
    return at
  }

  /** Sets a leaf; returns its field path. */
  set(segments: Segments, value: unknown): string {
    putOwn(this.object(segments.slice(0, -1)), segments[segments.length - 1], value)
    return fieldPath(...segments)
  }

  /** Makes sure the object at `segments` exists (configured, maybe with nothing in it); returns its field path. */
  ensure(segments: Segments): string {
    this.object(segments)
    return fieldPath(...segments)
  }

  remove(segments: Segments): void {
    const parent = this.get(segments.slice(0, -1))
    const key = segments[segments.length - 1]
    if (isObject(parent) && Object.hasOwn(parent, key)) delete parent[key]
  }

  /** Removes the object at `segments` when nothing is left in it. */
  removeIfEmpty(segments: Segments): void {
    const value = this.get(segments)
    if (isObject(value) && !Object.keys(value).length) this.remove(segments)
  }
}
