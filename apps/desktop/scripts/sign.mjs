// Tauri's signCommand (src-tauri/tauri.conf.json, bundle.windows.signCommand) runs this for every file it signs: the
// app's exe, then the installer, the file's path as the only argument. Signing is off until there is a certificate:
// with DIALECT_SIGN_COMMAND unset it says so and leaves the file unsigned. Set, it is a command line with %1 where the
// file's path goes (e.g. a signtool or a cloud signing tool's command), run as is.
import { execSync } from 'child_process'

const file = process.argv[2]
if (!file) {
  console.error('sign.mjs: no file to sign')
  process.exit(1)
}
const command = process.env.DIALECT_SIGN_COMMAND
if (!command) {
  console.log(`sign.mjs: not signed (DIALECT_SIGN_COMMAND is unset; no certificate yet): ${file}`)
  process.exit(0)
}
execSync(command.replaceAll('%1', `"${file}"`), { stdio: 'inherit' })
