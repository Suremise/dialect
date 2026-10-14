// The dialect command's entry: dist/dialect.mjs, built by vite.config.ts and run by Node 24.
import { readFile, writeFile } from 'fs/promises'
import { version } from '../package.json'
import { run } from './cli'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// A closed pipe (`dialect display-set x.conf | head`) isn't an error: stop writing, keep the exit code.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

process.exitCode = await run(
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
