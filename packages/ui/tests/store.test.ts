// The UI store's logic without a browser: the output and problems it derives from the source, and the save name.
import { beforeEach, describe, expect, it } from 'vitest'
import { outputName, useStore } from '../src/store'

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

describe('outputName', () => {
  it("is the source's name with .set, or display-set.set", () => {
    expect(outputName('edge-1.conf')).toBe('edge-1.set')
    expect(outputName('edge.1.txt')).toBe('edge.1.set')
    expect(outputName('router')).toBe('router.set')
    expect(outputName('.hidden')).toBe('.hidden.set')
    expect(outputName(null)).toBe('display-set.set')
  })
})
