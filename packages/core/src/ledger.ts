// The coverage ledger: no silent drops, checked by the core, not trusted to the plugin. Two completeness checks:
// - **source side, per statement:** every node of the parse's syntax tree needs a disposition from the mapper. A
//   container's disposition doesn't cover its children, so mapping `system` doesn't account for an unknown statement
//   inside it.
// - **model side, per populated leaf:** every populated leaf of the model (paths.ts) needs a disposition from the
//   renderer. A disposition for an object doesn't cover its leaves, so rendering a BGP neighbor doesn't account for its
//   `multihop.ttl`, and a field from a later minor model version the renderer has never heard of shows as unrendered.
// Plus the diagnostics and needs-input items both sides raised. It is accounting, not proof that the output behaves
// the same.
import type { Device } from './model'
import { populatedLeaves, type Leaf } from './paths'
import type { Diagnostic, FieldDisposition, NeedsInput, ParseResult, RenderResult, Span, StatementDisposition, SyntaxNode } from './results'

/** A statement the ledger reports, with where it is (display only). */
export interface StatementEntry {
  readonly id: string
  readonly label: string
  readonly span?: Span
  /** Null: the mapper gave it none, so it is unmapped. */
  readonly disposition: StatementDisposition | null
}

/** A populated leaf the ledger reports. */
export interface FieldEntry extends Leaf {
  /** Null: the renderer gave it none, so it is unrendered. */
  readonly disposition: FieldDisposition | null
}

/** The source side: every statement with its disposition. */
export interface StatementCoverage {
  readonly statements: readonly StatementEntry[]
  /** Statements with no disposition, in tree order. */
  readonly unmapped: readonly StatementEntry[]
  /** Dispositions for ids that aren't in the tree: the plugin is confused about its own tree. */
  readonly strayIds: readonly string[]
  /** Ids that appear more than once in the tree, so a disposition for them is ambiguous. */
  readonly duplicateIds: readonly string[]
}

/** The model side: every populated leaf with its disposition. */
export interface FieldCoverage {
  readonly fields: readonly FieldEntry[]
  /** Leaves with no disposition, in key order. */
  readonly unrendered: readonly FieldEntry[]
  /** Dispositions for paths that aren't a populated leaf (an object's path covers nothing). */
  readonly strayPaths: readonly string[]
}

/** Every statement of `tree` in tree order (depth first). */
export function statementsOf(tree: readonly SyntaxNode[]): SyntaxNode[] {
  const out: SyntaxNode[] = []
  const walk = (nodes: readonly SyntaxNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/** The source side's check: which statements of a parse got no disposition. */
export function checkStatements(tree: readonly SyntaxNode[], dispositions: Readonly<Record<string, StatementDisposition>>): StatementCoverage {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const statements = statementsOf(tree).map((n): StatementEntry => {
    if (seen.has(n.id)) duplicates.add(n.id)
    seen.add(n.id)
    return { id: n.id, label: n.label, ...(n.span ? { span: n.span } : {}), disposition: Object.hasOwn(dispositions, n.id) ? dispositions[n.id] : null }
  })
  return {
    statements,
    unmapped: statements.filter((s) => s.disposition === null),
    strayIds: Object.keys(dispositions).filter((id) => !seen.has(id)),
    duplicateIds: [...duplicates]
  }
}

/** The model side's check: which populated leaves of a model got no disposition from a render. */
export function checkFields(model: Device, dispositions: Readonly<Record<string, FieldDisposition>>): FieldCoverage {
  const fields = populatedLeaves(model).map((l): FieldEntry => ({ ...l, disposition: Object.hasOwn(dispositions, l.path) ? dispositions[l.path] : null }))
  const paths = new Set(fields.map((f) => f.path))
  return { fields, unrendered: fields.filter((f) => f.disposition === null), strayPaths: Object.keys(dispositions).filter((p) => !paths.has(p)) }
}

/** The whole ledger for a conversion: the parse's statements, the render's fields, and what both raised. */
export interface CoverageLedger {
  readonly source: StatementCoverage
  /** Absent for a parse that wasn't rendered. */
  readonly target?: FieldCoverage
  readonly diagnostics: readonly Diagnostic[]
  readonly needsInput: readonly NeedsInput[]
  /** True when no statement is unmapped and (if rendered) no field unrendered, and the tree's ids are unique. */
  readonly complete: boolean
}

/**
 * The ledger for a parse and, when there is one, the render of its model. `model` is what was rendered: the parse's
 * own model unless the caller changed it in between.
 */
export function buildLedger(parse: ParseResult, render?: RenderResult, model: Device = parse.model): CoverageLedger {
  const source = checkStatements(parse.tree, parse.dispositions)
  const target = render ? checkFields(model, render.dispositions) : undefined
  return {
    source,
    ...(target ? { target } : {}),
    diagnostics: [...parse.diagnostics, ...(render?.diagnostics ?? [])],
    needsInput: [...(parse.needsInput ?? []), ...(render?.needsInput ?? [])],
    complete: source.unmapped.length === 0 && source.duplicateIds.length === 0 && (target ? target.unrendered.length === 0 : true)
  }
}

/** The ledger's gaps in words, one line each, for reports and test failures; empty when it is complete. */
export function ledgerProblems(ledger: CoverageLedger): string[] {
  return [
    ...ledger.source.duplicateIds.map((id) => `statement id ${id} appears more than once in the tree`),
    ...ledger.source.unmapped.map((s) => `unmapped: ${s.label}${s.span ? ` (line ${s.span.startLine})` : ''}`),
    ...(ledger.target?.unrendered ?? []).map((f) => `unrendered: ${f.path}`)
  ]
}
