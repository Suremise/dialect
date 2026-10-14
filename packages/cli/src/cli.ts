// The dialect command, without the process: run() takes its arguments, input and output, and returns the exit code, so
// tests can call it directly. bin.ts is the entry the build turns into dist/dialect.mjs.
import { convert, createRegistry, formatInterfaceMap, interfaceInputs, parseInterfaceMap, type ConversionIssue, type Diagnostic, type InterfaceMap, type PlatformPlugin, type Span, type Tool } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import junos from '@dialect/platform-junos'

// The built-in plugins. Commands find their tools and converters here, as the app does, rather than calling a plugin's
// code directly.
const registry = createRegistry([junos, iosxe])

function tool(pluginId: string, toolId: string): Tool {
  const found = registry.tools().find((t) => t.plugin.id === pluginId && t.tool.id === toolId)
  if (!found) throw new Error(`no ${pluginId} ${toolId} tool`)
  return found.tool
}

/** `name:line:column: severity: message`, the way compilers print them; without a span, `name: severity: message`. */
function formatDiagnostic(name: string, d: Diagnostic): string {
  const where = d.span ? `${name}:${d.span.startLine}:${d.span.startColumn}` : name
  return `${where}: ${d.severity}: ${d.message}\n`
}

/**
 * 0: done (warnings allowed). 1: the input has a syntax error. 2: a usage error, or a file couldn't be read. 3: convert
 * left needs-input items unanswered (interfaces with no name on the target), without --allow-incomplete.
 */
export const EXIT = { ok: 0, parseError: 1, usage: 2, incomplete: 3 } as const

export interface Io {
  readFile: (path: string) => Promise<string>
  readStdin: () => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const ids = (plugins: readonly PlatformPlugin[]) => plugins.map((p) => p.id).join(', ')

export const USAGE = `Usage: dialect <command> [arguments]

Commands:
  display-set <file|->   Print a hierarchical Junos config as display set commands.
                         Reads the file, or stdin for "-". Writes the set commands to
                         stdout, and warnings and errors to stderr.
  convert --from <platform> --to <platform> [--map <file>] [--write-map <file>]
          [--allow-incomplete] <file|->
                         Convert a config to another platform's. Writes the converted
                         config to stdout, and what didn't carry over to stderr.
                         Platforms: from ${ids(registry.sources())}; to ${ids(registry.targets())}.
    --map <file>         The interfaces' names on the target: "from,to" lines, or a
                         JSON object ({"ge-0/0/0": "GigabitEthernet0/0/0"}).
    --write-map <file>   Write every interface to a map file to fill in: the names
                         given, else the suggestion (marked "# suggested"), else none.
    --allow-incomplete   Write the config even when interfaces have no name on the
                         target (they keep their source names; their lines go to stderr).

Options:
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes: 0 done, 1 the config has a syntax error, 2 usage error or unreadable input,
3 convert: interfaces have no name on the target (see --map, --allow-incomplete).
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
  const src = await readInput(io, input)
  if (src === null) return EXIT.usage
  const result = tool('junos', 'display-set').run(src)
  // An error means the text may be incomplete (core's ToolResult): print none of it.
  const failed = result.diagnostics.some((d) => d.severity === 'error')
  if (!failed) io.stdout(result.text)
  for (const d of result.diagnostics) io.stderr(formatDiagnostic(name, d))
  return failed ? EXIT.parseError : EXIT.ok
}

/** Reads a file or stdin ("-") for a command, or says why it can't on stderr and returns null. */
async function readInput(io: Io, input: string): Promise<string | null> {
  try {
    return withoutBom(input === '-' ? await io.readStdin() : await io.readFile(input))
  } catch (error) {
    io.stderr(`dialect: can't read ${input === '-' ? '<stdin>' : input}: ${fileError(error)}\n`)
    return null
  }
}

/** Why a file couldn't be read or written, in words. */
function fileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a folder, not a file' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : (error as Error).message
}

/** `name:line:column: ` for a span, else `name: `. */
const at = (name: string, span: Span | undefined): string => (span ? `${name}:${span.startLine}:${span.startColumn}: ` : `${name}: `)

/** Where an issue is, and what became of it: the plugin's reason, never the statement's text (a value may be secret). */
function formatIssue(name: string, issue: ConversionIssue, source: PlatformPlugin, target: PlatformPlugin): string {
  const what =
    issue.kind === 'unmapped' ? `not converted: the ${source.name} plugin gave this statement no disposition` : issue.kind === 'unsupported' ? 'not converted' : `not written for ${target.name}`
  return `${at(name, issue.span)}warning: ${what}${issue.reason ? `: ${issue.reason}` : ''}\n`
}

const CONVERT_VALUE_OPTIONS = ['--from', '--to', '--map', '--write-map']

async function convertCommand(args: string[], io: Io): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    io.stdout(USAGE)
    return EXIT.ok
  }
  const values: Record<string, string> = {}
  const files: string[] = []
  let allowIncomplete = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    const option = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    if (CONVERT_VALUE_OPTIONS.includes(option)) {
      const value = option !== a ? a.slice(eq + 1) : args[++i]
      if (value === undefined || value === '') return usageError(io, `convert: ${option} needs a value`)
      if (Object.hasOwn(values, option)) return usageError(io, `convert: ${option} is given twice`)
      values[option] = value
    } else if (a === '--allow-incomplete') allowIncomplete = true
    else if (a.startsWith('-') && a !== '-') return usageError(io, `convert: unknown option '${a}'`)
    else files.push(a)
  }
  const plugin = (option: '--from' | '--to', can: readonly PlatformPlugin[]): PlatformPlugin | string => {
    const id = values[option]
    if (id === undefined) return `convert: give ${option} (${ids(can)})`
    return can.find((p) => p.id === id) ?? `convert: ${option} ${id}: not one of ${ids(can)}`
  }
  const source = plugin('--from', registry.sources())
  if (typeof source === 'string') return usageError(io, source)
  const target = plugin('--to', registry.targets())
  if (typeof target === 'string') return usageError(io, target)
  if (files.length === 0) return usageError(io, 'convert: give a file, or - for stdin')
  if (files.length > 1) return usageError(io, 'convert: give one file')

  let map: InterfaceMap = {}
  const mapFile = values['--map']
  if (mapFile !== undefined) {
    const text = await readInput(io, mapFile)
    if (text === null) return EXIT.usage
    const read = parseInterfaceMap(text)
    if (read.problems.length) {
      for (const p of read.problems) io.stderr(`dialect: ${mapFile}: ${p}\n`)
      return EXIT.usage
    }
    map = read.map
  }
  const [input] = files
  const name = input === '-' ? '<stdin>' : input
  const src = await readInput(io, input)
  if (src === null) return EXIT.usage

  const result = convert(source, target, src, { modelVersion: registry.modelVersion, inputs: interfaceInputs(map) })
  for (const d of result.ledger.diagnostics) io.stderr(formatDiagnostic(name, d))
  // A syntax error means the model may be incomplete: print none of it.
  if (!result.render) return EXIT.parseError
  for (const issue of result.issues) io.stderr(formatIssue(name, issue, source, target))
  // Counts, not names: what's in a map is a config's names, and one can be a secret's value reused (AGENTS.md).
  const known = new Set(result.interfaces.map((i) => i.source))
  const extra = Object.keys(map).filter((from) => !known.has(from)).length
  if (extra) io.stderr(`dialect: warning: ${mapFile}: ${extra === 1 ? '1 interface it names is' : `${extra} interfaces it names are`} not in the config\n`)

  const writeMap = values['--write-map']
  if (writeMap !== undefined) {
    try {
      await io.writeFile(writeMap, formatInterfaceMap(map, result.interfaces))
    } catch (error) {
      io.stderr(`dialect: can't write ${writeMap}: ${fileError(error)}\n`)
      return EXIT.usage
    }
  }

  // Each unnamed interface by where the config has it, not by name (a name can be a reused secret): --write-map gives
  // the names, with suggestions, in a file the user chose.
  const unanswered = result.unanswered
  if (unanswered.length) {
    const spans = new Map(result.ledger.source.statements.map((s) => [s.id, s.span]))
    const severity = allowIncomplete ? 'warning' : 'error'
    for (const item of unanswered) io.stderr(`${at(name, item.statement ? spans.get(item.statement) : undefined)}${severity}: ${item.kind === 'interface-name' ? `this interface has no name on ${target.name}` : 'needs input'}\n`)
    const count = unanswered.length === 1 ? '1 interface has' : `${unanswered.length} interfaces have`
    const them = unanswered.length === 1 ? 'it' : 'them'
    const how = writeMap !== undefined ? `fill in ${writeMap} and give it with --map` : `give ${them} with --map (--write-map <file> writes every interface, with suggestions, to fill in)`
    if (!allowIncomplete) {
      io.stderr(`dialect: ${count} no name on ${target.name}: ${how}, or write the config anyway with --allow-incomplete.\n`)
      return EXIT.incomplete
    }
    io.stderr(`dialect: warning: incomplete: ${count} no name on ${target.name}, and keep${unanswered.length === 1 ? 's its' : ' their'} ${source.name} name${unanswered.length === 1 ? '' : 's'}.\n`)
  }
  io.stdout(result.render.text)
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
  if (command === 'convert') return convertCommand(rest, io)
  return usageError(io, `unknown command '${command}'`)
}
