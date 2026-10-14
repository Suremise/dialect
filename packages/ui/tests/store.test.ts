// The UI store's logic without a browser: the output, source lines and problems it derives from the source (through
// the registry's display set tool, or convert's), the interface map, and the save name.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countCommands, outputName, useStore } from '../src/store'

beforeEach(() => {
  useStore.getState().setSource('', null)
})

describe('the store', () => {
  it('derives the output, one set line per line, without a trailing newline', () => {
    useStore.getState().setSource('system {\n    host-name r1;\n    inactive: services { ssh; }\n}\n', 'r1.conf')
    const { output, problems, sourceName } = useStore.getState()
    expect(output).toBe('set system host-name r1\nset system services ssh\ndeactivate system services')
    expect(problems).toEqual([])
    expect(sourceName).toBe('r1.conf')
  })

  it("gives each output line its statement's source line, from the tool's result", () => {
    useStore.getState().setSource('system {\n    host-name r1;\n    inactive: services { ssh; }\n}\n')
    expect(useStore.getState().sourceLines).toEqual([2, 3, 3])
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(useStore.getState().sourceLines).toEqual([])
  })

  it('keeps the name while the source is edited, and drops it for pasted text', () => {
    useStore.getState().setSource('version 1;', 'a.conf')
    useStore.getState().setSource('version 2;')
    expect(useStore.getState().sourceName).toBe('a.conf')
    useStore.getState().setSource('version 3;', null)
    expect(useStore.getState().sourceName).toBeNull()
  })

  it('gives a syntax error as the only problem, with no output', () => {
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(useStore.getState().output).toBe('')
    expect(useStore.getState().problems).toEqual([{ severity: 'error', message: "missing ';' after the statement at line 2, column 5", line: 3, column: 1 }])
  })

  it('lists warnings as problems', () => {
    useStore.getState().setSource('/* x */\nversion 1;\n')
    expect(useStore.getState().problems).toEqual([{ severity: 'warning', message: "annotation on this statement isn't shown in display set", line: 2, column: 1 }])
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
    const { output, sourceLines } = useStore.getState()
    expect(output.split('\n')).toHaveLength(4)
    expect(countCommands(output)).toBe(2)
    expect(sourceLines).toEqual([3, 3, 3, 7])
  })

  it('counts deactivate and protect lines as commands of their own', () => {
    useStore.getState().setSource('system {\n    protect: host-name r1;\n    inactive: login {\n        message "one\ntwo";\n    }\n}\n')
    const { output } = useStore.getState()
    expect(output).toBe('set system host-name r1\nprotect system host-name r1\nset system login message "one\ntwo"\ndeactivate system login')
    expect(countCommands(output)).toBe(4)
  })
})

describe('the store in convert mode', () => {
  const PHASE1 = readFileSync(join(__dirname, '../../cli/tests/fixtures/convert/phase1.conf'), 'utf8')
  const EXPECTED = readFileSync(join(__dirname, '../../cli/tests/fixtures/convert/phase1.iosxe'), 'utf8')
  const SUGGESTED = { 'ge-0/0/0': 'GigabitEthernet0/0/0', 'ge-0/0/1': 'GigabitEthernet0/0/1', 'xe-0/1/0': 'TenGigabitEthernet0/1/0', lo0: 'Loopback0' }

  beforeEach(() => {
    useStore.getState().setMode('convert')
    useStore.getState().setSource(PHASE1, 'phase1.conf')
  })
  afterEach(() => {
    useStore.getState().setMode('display-set')
  })

  it('lists the interfaces unnamed, with suggestions and their lines, and keeps their source names in the output', () => {
    const { interfaces, output, interfaceMap } = useStore.getState()
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
    expect(useStore.getState().interfaceMap).toEqual(SUGGESTED)
    expect(useStore.getState().output + '\n').toBe(EXPECTED)
    expect(useStore.getState().interfaces.every((i) => i.target === i.suggestion)).toBe(true)
    useStore.getState().setInterfaceName('ge-0/0/0', ' Gi9 ')
    expect(useStore.getState().output).toContain('interface Gi9\n')
    // An empty name clears it.
    useStore.getState().setInterfaceName('ge-0/0/0', '')
    expect(useStore.getState().output).toContain('interface ge-0/0/0\n')
    expect(useStore.getState().interfaces[0]).toEqual({ source: 'ge-0/0/0', suggestion: 'GigabitEthernet0/0/0', line: 21 })
  })

  it('merges a loaded map, keeps the names while the source is edited, and drops them for another file', () => {
    useStore.getState().mergeInterfaceMap({ lo0: 'Loopback9', 'ge-9/9/9': 'Gi9' })
    expect(useStore.getState().output).toContain('interface Loopback9\n')
    useStore.getState().setSource(PHASE1.replace('edge-1', 'edge-2'))
    expect(useStore.getState().output).toContain('interface Loopback9\n')
    useStore.getState().setSource(PHASE1, 'other.conf')
    expect(useStore.getState().interfaceMap).toEqual({})
  })

  it('lists what did not carry over as warnings, by line, and the plugin errors', () => {
    expect(useStore.getState().problems).toEqual([
      { severity: 'warning', message: 'Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards', line: 66, column: 9 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 74, column: 1 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 75, column: 5 },
      { severity: 'warning', message: 'Not converted: routing protocols come later', line: 76, column: 9 }
    ])
    useStore.getState().mergeInterfaceMap({ 'ge-0/0/0': 'Gi1', 'ge-0/0/1': 'Gi1' })
    expect(useStore.getState().problems[0]).toEqual({ severity: 'error', message: '2 interfaces would have one name on Cisco IOS / IOS-XE (lines 21, 29): give each its own.', line: 21, column: 5 })
    useStore.getState().setSource('system {\n    host-name r1\n}\n')
    expect(useStore.getState().output).toBe('')
    expect(useStore.getState().problems.map((p) => p.severity)).toEqual(['error'])
  })

  it('links source statements to the output lines they gave', () => {
    useStore.getState().takeSuggestions()
    const { links, output, source } = useStore.getState()
    const out = output.split('\n')
    const src = source.split('\n')
    const pairs = links.map(([from, to]) => [src[from - 1].trim(), out[to - 1]])
    expect(pairs).toContainEqual(['host-name edge-1;', 'hostname edge-1'])
    expect(pairs).toContainEqual(['address 192.0.2.1/30;', ' ip address 192.0.2.1 255.255.255.252'])
    expect(pairs).toContainEqual(['interface ge-0/0/0.0;', 'ip route 198.51.100.64 255.255.255.192 GigabitEthernet0/0/0 192.0.2.2'])
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

  it("is the source's name with the target's id in convert mode, or converted.<id>", () => {
    expect(outputName('edge-1.conf', 'convert', 'iosxe')).toBe('edge-1.iosxe')
    expect(outputName(null, 'convert', 'iosxe')).toBe('converted.iosxe')
  })
})
