// Types for build-installers.mjs, which the desktop tests import (their tsconfig doesn't read JavaScript).

/** How to run the Tauri CLI with `args`: its JS entry run by this Node, with no shell. `cli` is the entry, Tauri's own unless given. */
export function tauriInvocation(args: readonly string[], cli?: string): { file: string; args: string[] }
