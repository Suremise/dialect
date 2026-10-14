// A statement's disposition while the mapper works: `mapped` keeps a mutable list of the fields it filled, so a later
// statement that supersedes one of them can take it away (parse.ts's `claim`).
import type { StatementDisposition } from '@dialect/core'

export type Mutable = { kind: 'mapped'; fields: string[] } | Exclude<StatementDisposition, { kind: 'mapped' }>

/** Mapped, with the fields it filled; a null is a setting a higher-ranked statement kept (`put`). */
export const mapped = (fields: readonly (string | null)[]): Mutable => ({ kind: 'mapped', fields: fields.filter((f): f is string => f !== null) })
export const ignored = (reason: string): Mutable => ({ kind: 'ignored-by-design', reason })
export const unsupported = (reason?: string): Mutable => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })
