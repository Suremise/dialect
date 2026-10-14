// Tests' temp folders, by their long, real paths (from Hive's tests/tempDir.ts). GitHub's runner has its temp folder at
// C:\Users\RUNNER~1\…, the 8.3 short form, while Node, git and npm often give back real paths: a test comparing a folder
// it made under os.tmpdir() with one they gave back passes on every machine but CI's. Tests make their folders here
// instead; tests/tempDir.test.ts fails on any other use of os.tmpdir() in the tests.
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let root: string | undefined

/** The temp folder by its real, long path. */
export function tempRoot(): string {
  return (root ??= realpathSync.native(tmpdir()))
}

/** A new, empty folder in the temp folder, named `prefix` and six random characters, by its real, long path. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tempRoot(), prefix))
}
