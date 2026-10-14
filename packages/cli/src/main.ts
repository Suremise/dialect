// The dialect command wired to Node: the file system, stdin, stdout and stderr. Both entries run it: bin.ts (the
// dist/dialect.mjs build, for Node 24) and sea.ts (the standalone dialect.exe, a Node single executable application).
import { readFile, writeFile } from 'fs/promises'
import { version } from '../package.json'
import { run } from './cli'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Runs the command on this process's arguments: its exit code. */
export function main(): Promise<number> {
  // A closed pipe (`dialect display-set x.conf | head`) isn't an error: stop writing, keep the exit code.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
  return run(
    process.argv.slice(2),
    {
      readFile: (path) => readFile(path, 'utf8'),
      readStdin,
      writeFile: (path, text) => writeFile(path, text, 'utf8'),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text)
    },
    version
  )
}
