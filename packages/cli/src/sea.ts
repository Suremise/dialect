// The standalone dialect.exe's entry (scripts/build-exe.mjs): a Node single executable application runs one CommonJS
// script, which has no top-level await, so the exit code is set when the command ends.
import { main } from './main'

void main().then((code) => {
  process.exitCode = code
})
