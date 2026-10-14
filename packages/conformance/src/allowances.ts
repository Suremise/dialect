// Temporary allowances for the secrets check (secrets.ts): a plugin leak found when the check came in, let through by
// name so main stays green while the card that fixes it is done. Each names the card that removes it; a suite whose
// plugin no longer leaks fails until its allowance is gone (suite.ts), so none outlives its fix. Add none for a new
// leak: fix it.
import type { LeakSite } from './secrets'

export interface SecretAllowance {
  /** The plugin's id. */
  readonly plugin: string
  /** Where the leak is. */
  readonly site: LeakSite
  /** Only diagnostics with this code; any when left out. */
  readonly code?: string
  /** Only this tool's diagnostics or text (`site: 'tool diagnostic'` or `'tool text'`); any tool when left out. */
  readonly tool?: string
  /**
   * Only on the fixtures of these names (`Fixture.name`, also a test's own fixtures given to checkFixture()); any
   * fixture when left out. describeConformance() checks such an allowance is still needed only when it has one of them.
   */
  readonly fixtures?: readonly string[]
  /** What leaks, in words: the message and the secret it quotes. */
  readonly leak: string
  /** The follow-up card that fixes the leak and removes this allowance. */
  readonly card: number
}

export const SECRET_ALLOWANCES: readonly SecretAllowance[] = []
