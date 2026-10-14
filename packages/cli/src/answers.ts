// The answers file: the user's answers to convert's needs-input items other than interface names (keys, passwords, a
// route policy, a VRF's route distinguisher), by item id. Answers are often secrets, so they come from a file or stdin,
// never the command line (argv is visible to every process and kept in shell history), and nothing here ever puts an
// answer, or an id (which names neighbors and interfaces), in a message: problems say the line.
import type { NeedsInput } from '@dialect/core'

export type Answers = Readonly<Record<string, string>>

/** A quoted string at the start of a line: the item's id, if JSON reads it (idOf()). */
const QUOTED = /^"(?:[^"\\]|\\.)*"/

/** A quoted id as its string, or undefined when it isn't one JSON reads. */
function idOf(quoted: string): string | undefined {
  try {
    return JSON.parse(quoted) as string
  } catch {
    return undefined
  }
}

/**
 * Reads an answers file: `"id" = answer` lines (`#` starts a comment line; the answer is the rest of the line, spaces at
 * either end dropped; an empty answer is no answer), or JSON (an object of answers by id). Interface names are refused:
 * they go in the map (--map).
 */
export function parseAnswers(text: string): { answers: Answers; problems: string[] } {
  const answers = Object.create(null) as Record<string, string>
  const problems: string[] = []
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const isInterface = (id: string) => id.startsWith('interface:')
  if (/^[[{]/.test(body.trimStart())) {
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      return { answers, problems: ['not valid JSON'] }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return { answers, problems: ['the JSON is not an object of answers'] }
    const entries = Object.entries(json)
    const notText = entries.filter(([, v]) => typeof v !== 'string').length
    if (notText) problems.push(`${notText === 1 ? 'an answer is' : `${notText} answers are`} not a string`)
    const broken = entries.filter(([, v]) => typeof v === 'string' && /[\r\n]/.test(v.trim())).length
    if (broken) problems.push(`${broken === 1 ? 'an answer has' : `${broken} answers have`} a line break`)
    const interfaces = entries.filter(([id]) => isInterface(id)).length
    if (interfaces) problems.push(`${interfaces === 1 ? 'an id is' : `${interfaces} ids are`} an interface's: give interface names with --map`)
    for (const [id, v] of entries) if (typeof v === 'string' && v.trim() && !/[\r\n]/.test(v.trim()) && !isInterface(id)) answers[id] = v.trim()
    return { answers, problems }
  }
  const firstLine = new Map<string, number>()
  body.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const quoted = QUOTED.exec(line)
    const rest = quoted ? line.slice(quoted[0].length).trimStart() : ''
    const id = quoted && rest.startsWith('=') ? idOf(quoted[0]) : undefined
    // Neither the line nor the parser's message is repeated: an id may hold a config's names.
    if (id === undefined) return problems.push(`line ${i + 1}: expected "id" = answer, the id a JSON string`)
    if (isInterface(id)) return problems.push(`line ${i + 1}: an interface's name: give it with --map`)
    if (firstLine.has(id)) return problems.push(`line ${i + 1}: answered twice (first on line ${firstLine.get(id)})`)
    firstLine.set(id, i + 1)
    const answer = rest.slice(1).trim()
    if (answer) answers[id] = answer
  })
  return { answers, problems }
}

/** A question to answer: one per needs-input id, with the lines of every place the plugin asked it for. */
export type Question = NeedsInput & { readonly lines: readonly number[] }

/**
 * The questions the items ask, one per id in the order first asked: a plugin asks once per place an answer goes (a BGP
 * group shared by VRFs is asked for in each), and one answer serves them all.
 */
export function questions(items: readonly NeedsInput[], lineOf: (item: NeedsInput) => number | undefined): Question[] {
  const byId = new Map<string, NeedsInput & { lines: number[] }>()
  for (const item of items) {
    const question = byId.get(item.id) ?? { ...item, lines: [] }
    byId.set(item.id, question)
    const line = lineOf(item)
    if (line !== undefined && !question.lines.includes(line)) question.lines.push(line)
  }
  return [...byId.values()]
}

/**
 * An answers file to fill in: every question (interfaces aside), each after a comment saying where and what, with the
 * answer given so far, if any.
 */
export function formatAnswers(items: readonly Question[], answers: Answers): string {
  const head = [
    '# Answers for dialect convert --answers: one "id" = answer line per item. Leave an answer empty to leave it',
    '# unanswered. The answer is the rest of the line, as typed (spaces at either end are dropped). Keys and',
    '# passwords are secrets: keep this file safe, and delete it when the config is done.'
  ]
  const where = (lines: readonly number[]) => (lines.length === 0 ? '' : `Line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}: `)
  const lines = items.flatMap((item) => ['', `# ${where(item.lines)}${item.kind === 'secret' ? 'secret. ' : ''}${item.message}`, `${JSON.stringify(item.id)} = ${Object.hasOwn(answers, item.id) ? answers[item.id] : ''}`.trimEnd()])
  return [...head, ...lines, ''].join('\n')
}
