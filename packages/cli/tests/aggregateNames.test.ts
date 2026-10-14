// Aggregated interfaces through convert, every source and target (#74): the target suggests its own name, marked as a
// suggestion, and the render keeps the source's name until the user takes it. Junos's `aeN` is Cisco's N+1
// (`Port-channel`, `port-channel`, `Bundle-Ether`); between Cisco platforms the number is kept.
import { describe, expect, it } from 'vitest'
import { convert, interfaceInputs, MODEL_VERSION, type PlatformPlugin } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import iosxr from '@dialect/platform-iosxr'
import junos from '@dialect/platform-junos'
import nxos from '@dialect/platform-nxos'

/** A config with one aggregate holding an address, and that aggregate's name. */
const sources: Readonly<Record<string, { plugin: PlatformPlugin; name: string; text: string }>> = {
  junos: { plugin: junos, name: 'ae4', text: 'set interfaces ae4 unit 0 family inet address 10.0.0.1/24\n' },
  iosxe: { plugin: iosxe, name: 'Port-channel5', text: 'interface Port-channel5\n ip address 10.0.0.1 255.255.255.0\n' },
  nxos: { plugin: nxos, name: 'port-channel5', text: 'interface port-channel5\n  no switchport\n  ip address 10.0.0.1/24\n' },
  iosxr: { plugin: iosxr, name: 'Bundle-Ether5', text: 'interface Bundle-Ether5\n ipv4 address 10.0.0.1 255.255.255.0\n' }
}
const targets: Readonly<Record<string, PlatformPlugin>> = { junos, iosxe, nxos, iosxr }

/** Each source's aggregate as the target names it. */
const expected: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  junos: { junos: 'ae4', iosxe: 'Port-channel5', nxos: 'port-channel5', iosxr: 'Bundle-Ether5' },
  iosxe: { junos: 'ae4', iosxe: 'Port-channel5', nxos: 'port-channel5', iosxr: 'Bundle-Ether5' },
  nxos: { junos: 'ae4', iosxe: 'Port-channel5', nxos: 'port-channel5', iosxr: 'Bundle-Ether5' },
  iosxr: { junos: 'ae4', iosxe: 'Port-channel5', nxos: 'port-channel5', iosxr: 'Bundle-Ether5' }
}

const pairs = Object.keys(sources).flatMap((from) => Object.keys(targets).map((to) => [from, to] as const))

describe('aggregated interface names suggested in convert', () => {
  it.each(pairs)('%s → %s: suggested, and applied only once the user takes it', (from, to) => {
    const { plugin, name, text } = sources[from]
    const suggestion = expected[from][to]
    const before = convert(plugin, targets[to], text, { modelVersion: MODEL_VERSION })
    expect(before.parse.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(before.interfaces.find((i) => i.source === name)).toMatchObject({ source: name, suggestion })
    expect(before.interfaces.find((i) => i.source === name)?.target).toBeUndefined()
    expect(before.unanswered.find((n) => n.id === `interface:${name}`)?.suggestions).toEqual([suggestion])
    // Not taken silently: the source's name stays in the model, so the render can't use the suggestion yet.
    expect(Object.keys(before.model.interfaces ?? {})).toEqual([name])

    const after = convert(plugin, targets[to], text, { modelVersion: MODEL_VERSION, inputs: interfaceInputs({ [name]: suggestion }) })
    expect(Object.keys(after.model.interfaces ?? {})).toEqual([suggestion])
    expect(after.unanswered.find((n) => n.id === `interface:${name}`)).toBeUndefined()
    expect(after.render?.text).toContain(suggestion)
  })

  it('suggests nothing for Cisco aggregate 0, which Junos has no ae-1 for', () => {
    const r = convert(iosxe, junos, 'interface Port-channel0\n ip address 10.0.0.1 255.255.255.0\n', { modelVersion: MODEL_VERSION })
    expect(r.interfaces.find((i) => i.source === 'Port-channel0')?.suggestion).toBeUndefined()
  })
})
