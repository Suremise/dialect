// The dialect command, without the process: run() takes its arguments, input and output, and returns the exit code, so
// tests can call it directly. bin.ts is the entry the build turns into dist/dialect.mjs.
import { displaySet } from '@dialect/platform-junos'

/** 0: done (warnings allowed). 1: the input has a syntax error. 2: a usage error, or the input couldn't be read. */
export const EXIT = { ok: 0, parseError: 1, usage: 2 } as const

export interface Io {
  readFile: (path: string) => Promise<string>
  readStdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export const USAGE = `Usage: dialect <command> [arguments]

Commands:
  display-set <file|->   Print a hierarchical Junos config as display set commands.
                         Reads the file, or stdin for "-". Writes the set commands to
                         stdout, and warnings and errors to stderr.

Options:
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes: 0 done, 1 the config has a syntax error, 2 usage error or unreadable input.
`

function usageError(io: Io, message: string): number {
  io.stderr(`dialect: ${message}\nRun 'dialect --help' for usage.\n`)
  return EXIT.usage
}

/** Text as read: a UTF-8 byte order mark removed. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function displaySetCommand(args: string[], io: Io): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    io.stdout(USAGE)
    return EXIT.ok
  }
  const options = args.filter((a) => a.startsWith('-') && a !== '-')
  if (options.length > 0) return usageError(io, `display-set: unknown option '${options[0]}'`)
  if (args.length === 0) return usageError(io, 'display-set: give a file, or - for stdin')
  if (args.length > 1) return usageError(io, 'display-set: give one file')
  const [input] = args
  const name = input === '-' ? '<stdin>' : input
  let src: string
  try {
    src = withoutBom(input === '-' ? await io.readStdin() : await io.readFile(input))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a folder, not a file' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : (error as Error).message
    io.stderr(`dialect: can't read ${name}: ${reason}\n`)
    return EXIT.usage
  }
  const result = displaySet(src)
  if (!result.ok) {
    io.stderr(`${name}:${result.error.line}:${result.error.column}: error: ${result.error.message}\n`)
    return EXIT.parseError
  }
  if (result.lines.length > 0) io.stdout(result.lines.map((line) => line.text).join('\n') + '\n')
  for (const warning of result.warnings) io.stderr(`${name}:${warning.line}:${warning.column}: warning: ${warning.message}\n`)
  return EXIT.ok
}

export async function run(argv: string[], io: Io, version: string): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined) {
    io.stderr(USAGE)
    return EXIT.usage
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    io.stdout(USAGE)
    return EXIT.ok
  }
  if (command === '-v' || command === '--version') {
    io.stdout(`dialect ${version}\n`)
    return EXIT.ok
  }
  if (command === 'display-set') return displaySetCommand(rest, io)
  return usageError(io, `unknown command '${command}'`)
}
