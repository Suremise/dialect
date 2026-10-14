// The tabs kept for the next start, in localStorage: each tab's job and file name, or its Docs page, and which one was
// shown. Never a config's contents, the interface names or the output: configs can hold secrets, and browser storage
// keeps them in plain text in the user's profile (docs/SPEC.md §7). A reopened tab offers to load its file again.
import type { DocId } from './help/docs'
import type { Job, Tab } from './store'

const KEY = 'dialect.session'

export type SessionTab = { kind: 'conversion'; job: Job; name: string | null } | { kind: 'docs'; page: DocId }

export interface Session {
  tabs: SessionTab[]
  /** The index of the tab shown. */
  active: number
}

const DOC_IDS: readonly string[] = ['guide', 'changelog', 'license', 'notices']

/** One stored tab, if it is well formed; anything else (an older or hand-edited value) is left out. */
function tabOf(value: unknown): SessionTab | null {
  if (typeof value !== 'object' || value === null) return null
  const t = value as Record<string, unknown>
  if (t.kind === 'docs') return typeof t.page === 'string' && DOC_IDS.includes(t.page) ? { kind: 'docs', page: t.page as DocId } : null
  if (t.kind !== 'conversion' || (t.name !== null && typeof t.name !== 'string')) return null
  const job = t.job as Record<string, unknown> | null
  if (job?.kind === 'tool' && typeof job.tool === 'string') return { kind: 'conversion', job: { kind: 'tool', tool: job.tool }, name: t.name }
  if (job?.kind === 'convert' && typeof job.target === 'string') return { kind: 'conversion', job: { kind: 'convert', target: job.target }, name: t.name }
  return null
}

/** The last session, or null when there is none (a first start, or storage that isn't there). */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { tabs?: unknown; active?: unknown }
    if (!Array.isArray(value.tabs)) return null
    const tabs = value.tabs.map(tabOf).filter((t): t is SessionTab => t !== null)
    return { tabs, active: typeof value.active === 'number' ? value.active : 0 }
  } catch {
    return null
  }
}

/** What a tab leaves for the next start: its job and file name only. */
export function sessionOf(tabs: readonly Tab[], activeId: string | null): Session {
  return {
    tabs: tabs.map((t): SessionTab => (t.kind === 'docs' ? { kind: 'docs', page: t.page } : { kind: 'conversion', job: t.job, name: t.sourceName })),
    active: Math.max(
      tabs.findIndex((t) => t.id === activeId),
      0
    )
  }
}

export function saveSession(tabs: readonly Tab[], activeId: string | null): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessionOf(tabs, activeId)))
  } catch {
    // No storage (a locked-down browser, or a test without a DOM): the tabs last until the page is closed.
  }
}
