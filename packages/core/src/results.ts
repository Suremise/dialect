// What a plugin hands back: the syntax tree, the dispositions the coverage ledger checks, diagnostics and needs-input
// items. Plain data, JSON-friendly, so results can be saved, compared in tests and sent between threads.
import type { Device } from './model'

/**
 * Where something is in a text, for display only (highlighting, jump-to-line). Lines and columns count from 1;
 * `endColumn` is exclusive. The ledger never uses spans for accounting: one line can hold several statements.
 */
export interface Span {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * A statement of the source's syntax tree: a leaf statement, a list value, a container. Every statement has an id
 * unique in its tree, and the mapper must give each one a disposition: a container's doesn't cover its children.
 * Plugins may extend it with their own fields.
 */
export interface SyntaxNode {
  readonly id: string
  /** What the statement says, for reports: its full path as the platform writes it (`system services ssh`). */
  readonly label: string
  readonly span?: Span
  readonly children?: readonly SyntaxNode[]
}

/** What the mapper did with a source statement. */
export type StatementDisposition =
  /** Put into the model: the field paths (paths.ts) it filled, none for a container that only groups its children. */
  | { readonly kind: 'mapped'; readonly fields: readonly string[] }
  /** Deliberately left out, with why (a `version` line, a comment the model has no place for). */
  | { readonly kind: 'ignored-by-design'; readonly reason: string }
  /** Recognised but not converted (yet), shown to the user as such. */
  | { readonly kind: 'unsupported'; readonly reason?: string }

/** What the renderer did with a populated leaf of the model. */
export type FieldDisposition =
  /** Written to the output, with where (display only). */
  | { readonly kind: 'rendered'; readonly span?: Span }
  /** The target platform can't say it, or the renderer can't yet. */
  | { readonly kind: 'unsupported'; readonly reason?: string }
  /** Meaningless on the target, with why (a setting the target always has). */
  | { readonly kind: 'not-applicable'; readonly reason: string }

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

/**
 * Something to tell the user about a parse, a render or a tool's run. `semantic`: converted, but it may behave
 * differently on the target (an implicit deny made explicit, a default that differs).
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly category?: 'syntax' | 'semantic' | 'other'
  /** A short stable code for tests and filters (`junos.unknown-tag`). */
  readonly code?: string
  readonly message: string
  readonly span?: Span
  /** The statement it is about. */
  readonly statement?: string
  /** The model field it is about. */
  readonly field?: string
  /**
   * Where in a render's output it is. Set by convert() only (#112): it moves a render diagnostic's `span`, a place in the
   * output, here, so that in a conversion `span` is always a place in the source. A plugin gives its render's `span`.
   */
  readonly outputSpan?: Span
}

/**
 * Something the tool can't know and the user has to supply: the name an interface gets on the target, a secret that
 * won't carry over. Answered through Context.inputs, by id.
 */
export interface NeedsInput {
  readonly id: string
  readonly kind: 'interface-name' | 'secret' | 'other'
  readonly message: string
  readonly statement?: string
  readonly field?: string
  /** Suggested answers, best first. */
  readonly suggestions?: readonly string[]
}

/** A plugin's parse of a source text. */
export interface ParseResult {
  /** The statements at the top of the source, each with its children. */
  readonly tree: readonly SyntaxNode[]
  readonly model: Device
  /** By statement id: a disposition for every statement of the tree. */
  readonly dispositions: Readonly<Record<string, StatementDisposition>>
  readonly diagnostics: readonly Diagnostic[]
  readonly needsInput?: readonly NeedsInput[]
}

/** A plugin's render of a model into its platform's text. */
export interface RenderResult {
  readonly text: string
  /** By field path: a disposition for every populated leaf of the model. */
  readonly dispositions: Readonly<Record<string, FieldDisposition>>
  readonly diagnostics: readonly Diagnostic[]
  readonly needsInput?: readonly NeedsInput[]
}

/** What a parse or a render is given besides its input. */
export interface Context {
  /** The core's MODEL_VERSION. */
  readonly modelVersion: string
  /** The user's answers to needs-input items, by id (an interface map is one answer per interface). */
  readonly inputs?: Readonly<Record<string, string>>
}
