// Route distinguishers and route targets as Junos writes them, and as the model holds them. Junos marks a 4-byte AS
// with `L` (`4200000000L:100`, `target:4200000000L:100`); the model writes it plain (`4200000000:100`), as the core's
// isRouteDistinguisher() takes it. A 2-byte AS and an IPv4 address read the same in both. A policy's communities
// (`community C members …`) are written the same way: a literal one in the model's form, a regular expression as is.
import { communityType, isRouteDistinguisher, type CommunityType } from '@dialect/core'

const FOUR_BYTE = /^(\d+)L:(\d+)$/

/** A Junos route distinguisher (or a route target without `target:`) in the model's form, or null if it isn't one. */
export function fromJunos(value: string): string | null {
  const m = FOUR_BYTE.exec(value)
  // `L` on a 2-byte AS is a form the model has no room for: it would read back as the 2-byte form.
  const plain = m ? (Number(m[1]) > 0xffff ? `${m[1]}:${m[2]}` : null) : value
  return plain !== null && isRouteDistinguisher(plain) ? plain : null
}

/** A model route distinguisher or route target as Junos writes it: a 4-byte AS with its `L`. */
export function toJunos(value: string): string {
  const colon = value.lastIndexOf(':')
  const admin = value.slice(0, colon)
  return /^\d+$/.test(admin) && Number(admin) > 0xffff ? `${admin}L${value.slice(colon)}` : value
}

/** A Junos route target (`target:65000:100`) in the model's form, or null. */
export function targetFromJunos(value: string): string | null {
  return value.startsWith('target:') ? fromJunos(value.slice('target:'.length)) : null
}

/** The well-known communities Junos names, in the model's names (the same). */
const WELL_KNOWN = new Set(['no-export', 'no-advertise', 'no-export-subconfed', 'llgr-stale', 'no-llgr'])

/**
 * A Junos community member that is a literal community, in the model's form (`65000:100`, `no-export`,
 * `target:4200000000:100` for Junos's `target:4200000000L:100`, `large:65000:1:2`), or null: a regular expression, or
 * not a community.
 */
export function communityFromJunos(value: string): string | null {
  if (WELL_KNOWN.has(value)) return value
  const m = /^(target|origin):(.+)$/.exec(value)
  const model = m ? (fromJunos(m[2]) !== null ? `${m[1]}:${fromJunos(m[2])}` : null) : value
  return model !== null && communityType(model) !== null ? model : null
}

/** A model community as a Junos member, or null when Junos has no way to write it (a well-known name it doesn't have). */
export function communityToJunos(value: string): string | null {
  const type = communityType(value)
  if (type === null || (type === 'standard' && /^[a-z]/.test(value) && !WELL_KNOWN.has(value))) return null
  const m = /^(target|origin):(.+)$/.exec(value)
  return m ? `${m[1]}:${toJunos(m[2])}` : value
}

/** Whether a Junos community member is a regular expression: it has a character Junos reads as one. */
export const isCommunityRegex = (value: string): boolean => /[\^$.*+?()[\]{}|\\]/.test(value)

/**
 * Which kind of community a Junos community regex matches, from how it starts (after a `^`): `target:` or `origin:`
 * extended, `large:` large, an AS number then `:` standard. Null when its start doesn't say, as then it could match
 * communities of any kind.
 */
export function regexCommunityType(regex: string): CommunityType | null {
  const s = regex.startsWith('^') ? regex.slice(1) : regex
  if (/^(target|origin):/.test(s)) return 'extended'
  if (s.startsWith('large:')) return 'large'
  return /^\d+:/.test(s) ? 'standard' : null
}
