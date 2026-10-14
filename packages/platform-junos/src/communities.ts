// Route distinguishers and route targets as Junos writes them, and as the model holds them. Junos marks a 4-byte AS
// with `L` (`4200000000L:100`, `target:4200000000L:100`); the model writes it plain (`4200000000:100`), as the core's
// isRouteDistinguisher() takes it. A 2-byte AS and an IPv4 address read the same in both.
import { isRouteDistinguisher } from '@dialect/core'

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
