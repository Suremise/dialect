// The UI store's logic without a browser: the output, source lines and problems it derives from the source (through
// the registry's display set tool, or convert's), the interface map, the save name, the tabs and what the session keeps.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionOf } from '../src/session'
import { activeConversion, convertJob, countCommands, DISPLAY_SET, isUnsaved, outputName, sameJob, SOURCES, tabTitle, targetsFor, toolJobs, useStore } from '../src/store'

/** The tab the store's actions act on. */
const doc = () => activeConversion(useStore.getState())!

beforeEach(() => {
  useStore.getState().setSource('', null)
})

describe('the store', () => {
  it('derives the output, one set line per line, without a trailing newline', () => {
    useStore.getState().setSource('system {\n    host-name r1;\n    inactive: services { ssh; }\n}\n', 'r1.conf')
    const { output, problems, sourceName } = doc()
    expect(output).toBe('set system host-name r1\nset system services ssh\ndeactivate system services')
    expect(problems).toEqual([])
    expect(sourceName).toBe('r1.conf')
  })

  it("gives each output line its statement's source line, from the tool's result", () => {
    useStore.getState().setSource('system {\n    host-name r1;\n    inactive: services { ssh; }\n}\n')
    expect(doc().sourceLines).toEqual([2, 3, 3])
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(doc().sourceLines).toEqual([])
  })

  it('keeps the name while the source is edited, and drops it for pasted text', () => {
    useStore.getState().setSource('version 1;', 'a.conf')
    useStore.getState().setSource('version 2;')
    expect(doc().sourceName).toBe('a.conf')
    useStore.getState().setSource('version 3;', null)
    expect(doc().sourceName).toBeNull()
  })

  it('gives a syntax error as the only problem, with no output', () => {
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(doc().output).toBe('')
    expect(doc().problems).toEqual([{ severity: 'error', message: "missing ';' after the statement at line 2, column 5", line: 3, column: 1 }])
  })

  it('lists warnings as problems', () => {
    useStore.getState().setSource('/* x */\nversion 1;\n')
    expect(doc().problems).toEqual([{ severity: 'warning', message: "annotation on this statement isn't shown in display set", line: 2, column: 1 }])
  })

  it('counts each reveal and notice, so the same place asked twice moves twice', () => {
    useStore.getState().revealAt('source', 3)
    const first = useStore.getState().reveal!
    useStore.getState().revealAt('source', 3)
    expect(useStore.getState().reveal).toEqual({ ...first, seq: first.seq + 1 })
  })
})

describe('countCommands', () => {
  it('counts a command per line, and a quoted line break as part of its command', () => {
    expect(countCommands('')).toBe(0)
    expect(countCommands('set system host-name r1')).toBe(1)
    expect(countCommands('set system host-name r1\nset system services ssh\ndeactivate system services')).toBe(3)
    expect(countCommands('set system login message "one\ntwo\nthree"\nset system host-name r1')).toBe(2)
    // An escaped quote doesn't end the string; a backslash outside quotes is an ordinary character.
    expect(countCommands('set system login message "a \\"b\nc\\" d"\nset x \\\nset y')).toBe(3)
    expect(countCommands('set system login message "ends in a backslash \\\\"\nset y')).toBe(2)
  })

  it("matches the display set's own commands for a banner, its lines linked to one statement", () => {
    useStore.getState().setSource('system {\n    login {\n        message "one\ntwo\nthree";\n    }\n    host-name r1;\n}\n')
    const { output, sourceLines } = doc()
    expect(output.split('\n')).toHaveLength(4)
    expect(countCommands(output)).toBe(2)
    expect(sourceLines).toEqual([3, 3, 3, 7])
  })

  it('counts deactivate and protect lines as commands of their own', () => {
    useStore.getState().setSource('system {\n    protect: host-name r1;\n    inactive: login {\n        message "one\ntwo";\n    }\n}\n')
    const { output } = doc()
    expect(output).toBe('set system host-name r1\nprotect system host-name r1\nset system login message "one\ntwo"\ndeactivate system login')
    expect(countCommands(output)).toBe(4)
  })
})

describe('the store in convert mode', () => {
  const PHASE1 = readFileSync(join(__dirname, '../../cli/tests/fixtures/convert/phase1.conf'), 'utf8')
  const EXPECTED = readFileSync(join(__dirname, '../../cli/tests/fixtures/convert/phase1.iosxe'), 'utf8')
  const SUGGESTED = { 'ge-0/0/0': 'GigabitEthernet0/0/0', 'ge-0/0/1': 'GigabitEthernet0/0/1', 'xe-0/1/0': 'TenGigabitEthernet0/1/0', lo0: 'Loopback0' }

  beforeEach(() => {
    useStore.getState().setJob({ kind: 'convert', target: 'iosxe' })
    useStore.getState().setSource(PHASE1, 'phase1.conf')
  })
  afterEach(() => {
    useStore.getState().setJob(DISPLAY_SET)
  })

  it('lists the interfaces unnamed, with suggestions and their lines, and keeps their source names in the output', () => {
    const { interfaces, output, interfaceMap } = doc()
    expect(interfaces).toEqual([
      { source: 'ge-0/0/0', suggestion: 'GigabitEthernet0/0/0', line: 21 },
      { source: 'ge-0/0/1', suggestion: 'GigabitEthernet0/0/1', line: 29 },
      { source: 'xe-0/1/0', suggestion: 'TenGigabitEthernet0/1/0', line: 39 },
      { source: 'lo0', suggestion: 'Loopback0', line: 43 }
    ])
    expect(interfaceMap).toEqual({})
    expect(output).toContain('interface ge-0/0/0\n')
  })

  it('gives the fixture\'s IOS-XE once the suggestions are taken, and other names by hand', () => {
    useStore.getState().takeSuggestions()
    expect(doc().interfaceMap).toEqual(SUGGESTED)
    expect(doc().output + '\n').toBe(EXPECTED)
    expect(doc().interfaces.every((i) => i.target === i.suggestion)).toBe(true)
    useStore.getState().setInterfaceName('ge-0/0/0', ' Gi9 ')
    expect(doc().output).toContain('interface Gi9\n')
    // An empty name clears it.
    useStore.getState().setInterfaceName('ge-0/0/0', '')
    expect(doc().output).toContain('interface ge-0/0/0\n')
    expect(doc().interfaces[0]).toEqual({ source: 'ge-0/0/0', suggestion: 'GigabitEthernet0/0/0', line: 21 })
  })

  it('merges a loaded map, keeps the names while the source is edited, and drops them for another file', () => {
    useStore.getState().mergeInterfaceMap({ lo0: 'Loopback9', 'ge-9/9/9': 'Gi9' })
    expect(doc().output).toContain('interface Loopback9\n')
    useStore.getState().setSource(PHASE1.replace('edge-1', 'edge-2'))
    expect(doc().output).toContain('interface Loopback9\n')
    useStore.getState().setSource(PHASE1, 'other.conf')
    expect(doc().interfaceMap).toEqual({})
  })

  it('lists what did not carry over as warnings, by line, and the plugin errors', () => {
    expect(doc().problems).toEqual([
      { severity: 'warning', message: 'Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards', line: 66, column: 9 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 74, column: 1 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 75, column: 5 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 76, column: 9 }
    ])
    useStore.getState().mergeInterfaceMap({ 'ge-0/0/0': 'Gi1', 'ge-0/0/1': 'Gi1' })
    expect(doc().problems[0]).toEqual({ severity: 'error', message: '2 interfaces would have one name on Cisco IOS / IOS-XE (lines 21, 29): give each its own.', line: 21, column: 5 })
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(doc().output).toBe('')
    expect(doc().problems.map((p) => p.severity)).toEqual(['error'])
  })

  it('links source statements to the output lines they gave', () => {
    useStore.getState().takeSuggestions()
    const { links, output, source } = doc()
    const out = output.split('\n')
    const src = source.split('\n')
    const pairs = links.map(([from, to]) => [src[from - 1].trim(), out[to - 1]])
    expect(pairs).toContainEqual(['host-name edge-1;', 'hostname edge-1'])
    expect(pairs).toContainEqual(['address 192.0.2.1/30;', ' ip address 192.0.2.1 255.255.255.252'])
    expect(pairs).toContainEqual(['interface ge-0/0/0.0;', 'ip route 198.51.100.64 255.255.255.192 GigabitEthernet0/0/0 192.0.2.2'])
  })
})

describe('the store converting IRB units (#80)', () => {
  const IRB = ['interfaces {', '    irb {', ...[100, 200, 300].flatMap((n) => [`        unit ${n} {`, `            family inet address 10.${n / 100}.0.1/24;`, '        }']), '    }', '}', 'vlans {', ...[100, 200, 300].flatMap((n) => [`    v${n} {`, `        vlan-id ${n};`, `        l3-interface irb.${n};`, '    }']), '}'].join('\n')

  beforeEach(() => {
    useStore.getState().setJob({ kind: 'convert', target: 'nxos' })
    useStore.getState().setSource(IRB, 'irb.conf')
  })
  afterEach(() => {
    useStore.getState().setJob(DISPLAY_SET)
  })

  it('lists each unit as its own row with its Vlan suggested, and converts each to its SVI once the suggestions are taken', () => {
    expect(doc().interfaces).toEqual([
      { source: 'irb.100', suggestion: 'Vlan100', line: 3 },
      { source: 'irb.200', suggestion: 'Vlan200', line: 6 },
      { source: 'irb.300', suggestion: 'Vlan300', line: 9 }
    ])
    useStore.getState().takeSuggestions()
    expect(doc().interfaceMap).toEqual({ 'irb.100': 'Vlan100', 'irb.200': 'Vlan200', 'irb.300': 'Vlan300' })
    for (const n of [100, 200, 300]) expect(doc().output).toContain(`interface Vlan${n}\n`)
    expect(doc().interfaces.every((i) => i.target === i.suggestion)).toBe(true)
  })

  it('keeps a unit with no name a row to name, while the named units convert', () => {
    useStore.getState().mergeInterfaceMap({ 'irb.100': 'Vlan100', 'irb.300': 'Vlan300' })
    expect(doc().interfaces.filter((i) => i.target === undefined).map((i) => i.source)).toEqual(['irb.200'])
    expect(doc().output).toContain('interface Vlan100\n')
    expect(doc().output).toContain('interface Vlan300\n')
  })
})

describe('outputName', () => {
  it("is the source's name with .set, or display-set.set", () => {
    expect(outputName('edge-1.conf')).toBe('edge-1.set')
    expect(outputName('edge.1.txt')).toBe('edge.1.set')
    expect(outputName('router')).toBe('router.set')
    expect(outputName('.hidden')).toBe('.hidden.set')
    expect(outputName(null)).toBe('display-set.set')
  })

  it("is the source's name with the target's id in convert, or converted.<id>", () => {
    expect(outputName('edge-1.conf', { kind: 'convert', target: 'iosxe' })).toBe('edge-1.iosxe')
    expect(outputName(null, { kind: 'convert', target: 'iosxe' })).toBe('converted.iosxe')
  })
})

describe('the tabs', () => {
  const CONVERT = { kind: 'convert', target: 'iosxe' } as const
  const titles = (): string[] => useStore.getState().tabs.map((t) => tabTitle(t, (page) => page))

  beforeEach(() => {
    useStore.setState({ tabs: [], activeId: null, closing: null, exiting: false })
    useStore.getState().newTab(DISPLAY_SET)
  })

  it('keeps each tab its own job, source and output, and acts on the active one', () => {
    const first = useStore.getState().activeId!
    useStore.getState().setSource('system { host-name r1; }', 'r1.conf')
    const second = useStore.getState().newTab(CONVERT)
    useStore.getState().setSource('system { host-name r2; }', 'r2.conf')
    expect(titles()).toEqual(['r1.conf → Display set', 'r2.conf → IOS-XE'])
    expect(doc().output).toBe('hostname r2\n!\nend')
    useStore.getState().activate(first)
    expect(doc().output).toBe('set system host-name r1')
    useStore.getState().cycle(1)
    expect(useStore.getState().activeId).toBe(second)
    useStore.getState().cycle(1)
    expect(useStore.getState().activeId).toBe(first)
    useStore.getState().cycle(-1)
    expect(useStore.getState().activeId).toBe(second)
  })

  it('asks before closing a tab with unsaved output, and not once it is saved', () => {
    const id = useStore.getState().activeId!
    useStore.getState().setSource('system { host-name r1; }', 'r1.conf')
    expect(isUnsaved(doc())).toBe(true)
    useStore.getState().closeTab(id)
    expect(useStore.getState().closing).toBe(id)
    expect(useStore.getState().tabs).toHaveLength(1)
    useStore.getState().cancelClose()
    useStore.getState().markSaved(id, doc().output, null)
    expect(isUnsaved(doc())).toBe(false)
    useStore.getState().setSource('system { host-name r1; }\n')
    expect(isUnsaved(doc())).toBe(false)
    useStore.getState().closeTab(id)
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().activeId).toBeNull()
  })

  it('closes a tab with nothing to save at once, and shows its right-hand neighbour', () => {
    const [a, b, c] = [useStore.getState().activeId!, useStore.getState().newTab(CONVERT), useStore.getState().newTab(DISPLAY_SET)]
    useStore.getState().activate(b)
    useStore.getState().closeTab(b)
    expect(useStore.getState().tabs.map((t) => t.id)).toEqual([a, c])
    expect(useStore.getState().activeId).toBe(c)
    useStore.getState().closeTab(c)
    expect(useStore.getState().activeId).toBe(a)
  })

  it('opens one Docs tab per page, and shows it again rather than opening another', () => {
    useStore.getState().openDocs('guide')
    const guide = useStore.getState().activeId
    useStore.getState().openDocs('license')
    useStore.getState().openDocs('guide')
    expect(useStore.getState().activeId).toBe(guide)
    expect(titles()).toEqual(['Untitled → Display set', 'guide', 'license'])
    // Opening a file with a Docs tab shown opens it in a new display set tab.
    useStore.getState().setSource('system { host-name r1; }', 'r1.conf')
    expect(titles()).toEqual(['Untitled → Display set', 'guide', 'license', 'r1.conf → Display set'])
  })

  it('keeps the jobs, file names and Docs pages for the next start, never the contents', () => {
    useStore.getState().setSource('system { host-name secret-host; }', 'r1.conf')
    useStore.getState().newTab(CONVERT)
    useStore.getState().setSource('system { host-name other; }\ninterfaces { ge-0/0/0 { unit 0; } }', 'r2.conf')
    useStore.getState().setInterfaceName('ge-0/0/0', 'Gi1')
    useStore.getState().openDocs('notices')
    const session = sessionOf(useStore.getState().tabs, useStore.getState().activeId)
    expect(session).toEqual({
      tabs: [
        { kind: 'conversion', job: DISPLAY_SET, name: 'r1.conf' },
        { kind: 'conversion', job: CONVERT, name: 'r2.conf' },
        { kind: 'docs', page: 'notices' }
      ],
      active: 2
    })
    expect(JSON.stringify(session)).not.toMatch(/secret-host|host-name|Gi1|ge-0/)
  })
})

describe('the jobs a new tab offers', () => {
  it('come from the registry: each tool, and convert between the four platforms', () => {
    expect(toolJobs().map((j) => [j.job, j.label])).toEqual([[DISPLAY_SET, 'Display set (Junos)']])
    expect(SOURCES.map((p) => p.id)).toEqual(['junos', 'iosxe', 'nxos', 'iosxr'])
    expect(targetsFor(SOURCES[2]).map((p) => p.id)).toEqual(['junos', 'iosxe', 'iosxr'])
    expect(convertJob('junos', 'iosxe')).toEqual({ job: { kind: 'convert', source: 'junos', target: 'iosxe' }, label: 'Convert: Junos → Cisco IOS / IOS-XE' })
    expect(convertJob('nxos', 'iosxr').label).toBe('Convert: Cisco NX-OS → Cisco IOS-XR')
    // A target that is the source itself gives way to the source's first target.
    expect(convertJob('iosxr', 'iosxr').job).toEqual({ kind: 'convert', source: 'iosxr', target: 'junos' })
  })
})

describe('convert from another source', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeId: null })
    useStore.getState().newTab({ kind: 'convert', source: 'nxos', target: 'iosxr' })
  })

  it('reads the source platform and writes the target, its title naming the target', () => {
    useStore.getState().setSource('hostname n1\n', 'n1.cfg')
    expect(doc().output).toContain('hostname n1')
    expect(tabTitle(doc(), (p) => p)).toBe('n1.cfg → IOS-XR')
    expect(outputName('n1.cfg', doc().job)).toBe('n1.iosxr')
  })

  it('changes source and target, keeping the other, and a target the new source is gives way', () => {
    useStore.getState().setConvertSource('junos')
    expect(doc().job).toEqual({ kind: 'convert', source: 'junos', target: 'iosxr' })
    useStore.getState().setTarget('nxos')
    expect(doc().job).toEqual({ kind: 'convert', source: 'junos', target: 'nxos' })
    useStore.getState().setConvertSource('nxos')
    expect(doc().job).toEqual({ kind: 'convert', source: 'nxos', target: 'junos' })
  })

  it('keeps its source for the next start, and a job saved before sources were chosen reads as Junos', () => {
    expect(sessionOf(useStore.getState().tabs, useStore.getState().activeId).tabs).toEqual([{ kind: 'conversion', job: { kind: 'convert', source: 'nxos', target: 'iosxr' }, name: null }])
    expect(sameJob({ kind: 'convert', target: 'iosxe' }, { kind: 'convert', source: 'junos', target: 'iosxe' })).toBe(true)
  })
})
