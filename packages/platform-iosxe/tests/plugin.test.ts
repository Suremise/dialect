// The plugin beyond its fixtures: nothing dropped silently (unknown statements, banners and certificate chains are
// unsupported, with their text kept), the registry, detect(), and rendering a model that came from another platform.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFixture } from '@dialect/conformance'
import { buildLedger, createRegistry, ledgerProblems, MODEL_VERSION, populatedLeaves, statementsOf, type Device } from '@dialect/core'
import plugin from '../src'
import { isIpv6, lengthMask, maskLength } from '../src/addresses'
import type { IosNode } from '../src/tree'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)

describe('nothing is dropped silently', () => {
  it('unknown statements, and everything inside them, are unsupported with their text kept', () => {
    const text = ['hostname r1', 'router ospf 1', ' network 192.0.2.0 0.0.0.255 area 0', 'interface Gi1', ' speed 1000', ' service-policy input P', '  nested thing', 'frobnicate now'].join('\n')
    const result = parse(text)
    const byText = new Map(statementsOf(result.tree).map((n) => [(n as IosNode).text, result.dispositions[n.id]]))
    for (const t of ['router ospf 1', 'network 192.0.2.0 0.0.0.255 area 0', 'speed 1000', 'service-policy input P', 'nested thing', 'frobnicate now']) {
      expect(byText.get(t), t).toMatchObject({ kind: 'unsupported' })
    }
    expect(buildLedger(result).complete).toBe(true)
  })

  it('a banner and a certificate chain each come through as one atomic unsupported statement', () => {
    const banner = ['banner login ^C', 'Line 1', 'interface Gi1', ' ip address 192.0.2.1 255.255.255.0', '^C']
    const chain = ['crypto pki certificate chain TP-1', ' certificate self-signed 01', '  30820330', '  \tquit']
    const result = parse([...banner, ...chain, 'hostname r1'].join('\n'))
    const nodes = result.tree as readonly IosNode[]
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toMatchObject({ kind: 'banner', text: banner.join('\n'), children: [] })
    expect(result.dispositions[nodes[0].id]).toEqual({ kind: 'unsupported', reason: 'a login banner, 5 lines, kept verbatim' })
    expect(nodes[1]).toMatchObject({ kind: 'certificate-chain', text: chain.join('\n'), children: [] })
    expect(result.dispositions[nodes[1].id]).toEqual({ kind: 'unsupported', reason: 'certificate chain TP-1, 4 lines, kept verbatim' })
    // The interface inside the banner is banner text, not configuration.
    expect(result.model).toEqual({ system: { hostname: 'r1' } })
  })

  it('a statement with an option the model can\'t hold is unsupported as a whole, not half-converted', () => {
    const result = parse('ntp server 192.0.2.1 key 1\nip name-server 192.0.2.53 2.3.4.5 use-vrf management')
    expect(result.model).toEqual({})
    expect(Object.values(result.dispositions)).toEqual([{ kind: 'unsupported', reason: '"key" isn\'t converted yet' }, { kind: 'unsupported', reason: '"use-vrf" isn\'t converted yet' }])
  })

  it('a later setting supersedes an earlier one, as on the device', () => {
    const result = parse('hostname a\nhostname b\ninterface Gi1\n ip address 192.0.2.1 255.255.255.0\n ip address 192.0.2.9 255.255.255.0')
    expect(result.model.system?.hostname).toBe('b')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 2' })
    expect(Object.keys(result.model.interfaces?.Gi1.subinterfaces?.['0'].ipv4?.addresses ?? {})).toEqual(['192.0.2.9'])
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 5' })
  })
})

describe('DNS', () => {
  it('a server already named in another VRF is unsupported: the model keys servers by address alone', () => {
    const result = parse('ip name-server vrf A 192.0.2.53\nip name-server 192.0.2.53 192.0.2.54')
    expect(result.model.system?.dns).toEqual({ servers: { '192.0.2.53': { networkInstance: 'A' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: '192.0.2.53 is already a name server in another VRF' })
  })

  it('a statement with a malformed IPv6 server is unsupported as a whole, with no server added', () => {
    for (const bad of ['2001:db8:::53', '2001:db8:1:2:3:4:5:6:']) {
      const result = parse(`ip name-server 192.0.2.53 ${bad}`)
      expect(result.model, bad).toEqual({})
      expect(result.dispositions.L1).toEqual({ kind: 'unsupported', reason: `"${bad}" isn't converted yet` })
    }
  })

  it('"vrf default" is the global table: same model as no VRF, round-trips, and is no conflict with it', () => {
    for (const text of ['ip name-server vrf default 192.0.2.53', 'ip name-server vrf default 192.0.2.53\nip name-server 192.0.2.53', 'ip name-server 192.0.2.53\nip name-server vrf default 192.0.2.53']) {
      const result = parse(text)
      expect(result.model, text).toEqual({ system: { dns: { servers: { '192.0.2.53': {} } } } })
      expect(Object.values(result.dispositions).every((d) => d.kind === 'mapped'), text).toBe(true)
      const fixture = { name: text, source: text, expectedModel: result.model }
      expect(checkFixture(plugin, fixture).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
    }
  })

  it('"vrf default" on NTP and logging servers round-trips too', () => {
    const text = 'ntp server vrf default 192.0.2.123\nlogging host 192.0.2.50 vrf default'
    const result = parse(text)
    expect(result.model.system).toEqual({ ntp: { servers: { '192.0.2.123': {} } }, logging: { remoteServers: { '192.0.2.50': {} } } })
    expect(checkFixture(plugin, { name: 'vrf default', source: text, expectedModel: result.model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
  })

  it('a search domain listed twice is listed once', () => {
    const result = parse('ip domain list example.net\nip domain-list example.net')
    expect(result.model.system?.dns?.search).toEqual(['example.net'])
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'already in the search list' })
  })

  it('renders servers and search domains from another platform\'s model, every field accounted for', () => {
    const model: Device = { system: { dns: { search: ['a.example', 'b.example'], servers: { '192.0.2.1': { networkInstance: 'default' }, '2001:db8::1': {}, '192.0.2.2': { networkInstance: 'MGMT' } } } } }
    const result = plugin.render!(model, context)
    expect(result.text.split('\n').filter((l) => l.startsWith('ip '))).toEqual(['ip domain list a.example', 'ip domain list b.example', 'ip name-server 192.0.2.1', 'ip name-server 2001:db8::1', 'ip name-server vrf MGMT 192.0.2.2'])
    expect(ledgerProblems(buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result))).toEqual([])
  })
})

describe('IPv4 addresses', () => {
  const addresses = (result: ReturnType<typeof parse>) => result.model.interfaces?.Gi1?.subinterfaces?.['0']?.ipv4?.addresses

  it('"no ip address" removes the primary and secondaries before it', () => {
    const result = parse(['interface Gi1', ' ip address 192.0.2.1 255.255.255.0', ' ip address 198.51.100.1 255.255.255.0 secondary', ' no ip address', ' description d'].join('\n'))
    expect(result.model.interfaces).toEqual({ Gi1: { type: 'ethernet', description: 'd' } })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by "no ip address" on line 4' })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by "no ip address" on line 4' })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removes the IPv4 addresses before it (lines 2, 3): nothing to convert' })
    expect(plugin.render!(result.model, context).text).not.toContain('ip address')
    expect(buildLedger(result).complete).toBe(true)
  })

  it('an address after "no ip address" is the interface\'s address', () => {
    const result = parse(['interface Gi1', ' ip address 192.0.2.1 255.255.255.0', ' ip address 198.51.100.1 255.255.255.0 secondary', ' no ip address', ' ip address 203.0.113.1 255.255.255.0'].join('\n'))
    expect(addresses(result)).toEqual({ '203.0.113.1': { prefixLength: 24 } })
    expect(result.dispositions.L5).toMatchObject({ kind: 'mapped' })
  })

  it('a secondary address with no primary is unsupported, not turned into a primary', () => {
    for (const secondaries of [['192.0.2.1'], ['192.0.2.1', '198.51.100.1']]) {
      const lines = ['interface Gi1', ...secondaries.map((a) => ` ip address ${a} 255.255.255.0 secondary`)]
      const result = parse(lines.join('\n'))
      expect(result.model.interfaces, secondaries.join()).toEqual({ Gi1: { type: 'ethernet' } })
      for (let i = 2; i <= lines.length; i++) expect(result.dispositions[`L${i}`]).toEqual({ kind: 'unsupported', reason: 'a secondary address with no primary address: the model can\'t say an address is secondary' })
      expect(plugin.render!(result.model, context).text).not.toContain('ip address')
    }
  })
})

describe('configuration names that are Object.prototype\'s own (__proto__, constructor, toString)', () => {
  const KEYS = ['__proto__', 'constructor', 'toString']

  it('stay own keys of the model, round-trip, and never touch Object.prototype', () => {
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort()
    // Twice: a polluted prototype would show on the second parse.
    for (let run = 0; run < 2; run++) {
      for (const key of KEYS) {
        const text = [`snmp-server community ${key} RW`, `ip route vrf ${key} 0.0.0.0 0.0.0.0 192.0.2.1`, `ip route 192.0.2.0 255.255.255.0 192.0.2.9 name ${key}`, 'ntp server constructor', 'logging host toString'].join('\n')
        const result = parse(text)
        const communities = result.model.system?.snmp?.communities ?? {}
        expect(Object.hasOwn(communities, key), key).toBe(true)
        expect(Object.getPrototypeOf(communities)).toBe(Object.prototype)
        expect(communities[key]).toEqual({ access: 'read-write' })
        expect(Object.hasOwn(result.model.networkInstances ?? {}, key)).toBe(true)
        expect(Object.keys(result.model.system?.ntp?.servers ?? {})).toEqual(['constructor'])
        expect(Object.keys(result.model.system?.logging?.remoteServers ?? {})).toEqual(['toString'])
        // Through the kit's four checks, against the same model as JSON would carry it.
        const fixture = { name: key, source: text, expectedModel: JSON.parse(JSON.stringify(result.model)) as Device }
        expect(checkFixture(plugin, fixture).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
        expect(plugin.render!(result.model, context).text).toContain(`snmp-server community ${key} RW`)
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeNames)
    expect(({} as Record<string, unknown>).access).toBeUndefined()
  })

  it('in a logging level are not a severity', () => {
    expect(parse('logging host 192.0.2.1\nlogging trap constructor').dispositions.L2).toEqual({ kind: 'unsupported' })
  })
})

describe('the plugin', () => {
  it('loads in the registry as a source and a target', () => {
    const registry = createRegistry([plugin])
    expect(registry.sources().map((p) => p.id)).toEqual(['iosxe'])
    expect(registry.targets().map((p) => p.id)).toEqual(['iosxe'])
  })

  it('knows an IPv6 address from a malformed one', () => {
    const valid = ['2001:db8::53', '2001:db8:0:0:0:0:0:53', '2001:DB8:1:2:3:4:5:6', '::', '::1', 'fe80::', '::ffff:192.0.2.1', '64:ff9b::192.0.2.1', '2001:db8:1:2:3:4:192.0.2.1']
    const malformed = ['2001:db8:::53', '2001:db8:1:2:3:4:5:6:', ':2001:db8::1', '1::2::3', '2001:db8:1:2:3:4:5', '2001:db8:1:2:3:4:5:6:7', '2001:db8::12345', '192.0.2.1', '1.2.3.4::', '::192.0.2', 'g::1', '']
    for (const a of valid) expect(isIpv6(a), a).toBe(true)
    for (const a of malformed) expect(isIpv6(a), a).toBe(false)
  })

  it('converts dotted masks and prefix lengths both ways', () => {
    for (let len = 0; len <= 32; len++) expect(maskLength(lengthMask(len))).toBe(len)
    expect(lengthMask(25)).toBe('255.255.255.128')
    expect(maskLength('255.0.255.0')).toBeNull()
    expect(maskLength('0.0.0.255')).toBeNull()
  })
})

describe('detect', () => {
  const root = fileURLToPath(new URL('../../../fixtures/public/', import.meta.url))
  const whole = (platform: string) => readdirSync(join(root, platform, 'whole')).map((f) => [f, readFileSync(join(root, platform, 'whole', f), 'utf8')] as const)

  it('is sure of whole IOS / IOS-XE configs', () => {
    for (const [name, text] of whole('iosxe')) expect(plugin.detect!(text), name).toBeGreaterThanOrEqual(0.7)
  })

  const every = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? every(join(dir, e.name)) : [join(dir, e.name)]))

  it('scores every Junos file low', () => {
    const files = every(join(root, 'junos'))
    expect(files.length).toBeGreaterThan(200)
    for (const file of files) expect(plugin.detect!(readFileSync(file, 'utf8')), file).toBeLessThan(0.4)
  })

  it('scores whole NX-OS and IOS-XR configs low', () => {
    for (const platform of ['nxos', 'iosxr']) {
      for (const [name, text] of whole(platform)) expect(plugin.detect!(text), `${platform}/${name}`).toBeLessThan(0.4)
    }
  })

  it('scores text that isn\'t a config 0', () => {
    expect(plugin.detect!('')).toBe(0)
    expect(plugin.detect!('Dear team, the meeting is at noon.')).toBe(0)
  })
})

describe('rendering a model from another platform', () => {
  // Junos-shaped: unit 0 with its own description, two addresses and no primary, a reject route, an SNMP client list.
  const model: Device = {
    system: { hostname: 'mx1', snmp: { communities: { PLACEHOLDER: { access: 'read-only', clients: ['192.0.2.0/24'] }, 'PLACEHOLDER-RW': { access: 'read-write', clients: ['198.51.100.0/24'] }, OPEN: {} } }, logging: { remoteServers: { '192.0.2.50': { severity: 'error' }, '192.0.2.51': { severity: 'notice' } } } },
    interfaces: {
      'ge-0/0/0': {
        type: 'ethernet',
        description: 'uplink',
        vlanTagging: true,
        subinterfaces: {
          '0': { description: 'unit 0', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 }, '198.51.100.1': { prefixLength: 24 } } } },
          '10': { vlanId: 10, ipv6: { addresses: { '2001:db8::1': { prefixLength: 64, primary: true } } } }
        }
      }
    },
    networkInstances: { default: { type: 'default', staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { drop: 'reject' } } }, '192.0.2.128/25': { nextHops: { '0': { address: '192.0.2.2', metric: 5 } } } } } }
  }
  const result = plugin.render!(model, context)

  it('accounts for every populated field', () => {
    const ledger = buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result)
    expect(ledgerProblems(ledger)).toEqual([])
    expect(ledger.target?.strayPaths).toEqual([])
  })

  it('says what IOS can\'t write, and warns where it chose', () => {
    const notRendered = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([path]) => path)
    expect(notRendered.sort()).toEqual([
      'interfaces["ge-0/0/0"].subinterfaces["0"].description',
      'networkInstances.default.staticRoutes["0.0.0.0/0"].nextHops["0"].drop',
      'networkInstances.default.staticRoutes["192.0.2.128/25"].nextHops["0"].metric',
      'system.logging.remoteServers["192.0.2.50"].severity',
      'system.logging.remoteServers["192.0.2.51"].severity',
      'system.snmp.communities.PLACEHOLDER.access',
      'system.snmp.communities.PLACEHOLDER.clients',
      'system.snmp.communities["PLACEHOLDER-RW"].access',
      'system.snmp.communities["PLACEHOLDER-RW"].clients'
    ])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['iosxe.primary-chosen', 'iosxe.snmp-community-restricted', 'iosxe.snmp-community-restricted'])
    expect(result.text).toContain(' ip address 192.0.2.1 255.255.255.0\n ip address 198.51.100.1 255.255.255.0 secondary\n')
    expect(result.text).toContain('interface ge-0/0/0.10\n encapsulation dot1Q 10\n ipv6 address 2001:db8::1/64\n')
  })

  it('leaves out a community limited to some clients, RO or RW, rather than open it to every client', () => {
    const communities = result.text.split('\n').filter((l) => l.startsWith('snmp-server community'))
    expect(communities).toEqual(['snmp-server community OPEN'])
  })

  it('doesn\'t echo a left-out community\'s name, a secret, in its warning', () => {
    const warnings = result.diagnostics.filter((d) => d.code === 'iosxe.snmp-community-restricted')
    expect(warnings).toHaveLength(2)
    for (const w of warnings) for (const name of ['PLACEHOLDER', 'PLACEHOLDER-RW']) expect(w.message).not.toContain(name)
  })

  it('leaves a field of a later model version unrendered, for the ledger to report', () => {
    const later = { ...model, system: { ...model.system, timezone: 'UTC' } } as Device
    const ledger = buildLedger({ tree: [], model: later, dispositions: {}, diagnostics: [] }, plugin.render!(later, context))
    expect(ledgerProblems(ledger)).toEqual(['unrendered: system.timezone'])
  })

  it('writes every leaf of a fully populated IOS model back', () => {
    const text = readFileSync(fileURLToPath(new URL('./fixtures/interfaces/addresses.cfg', import.meta.url)), 'utf8')
    const parsed = parse(text)
    const rendered = plugin.render!(parsed.model, context)
    const leaves = populatedLeaves(parsed.model).map((l) => l.path)
    const notRendered = leaves.filter((p) => rendered.dispositions[p]?.kind !== 'rendered')
    expect(notRendered).toEqual(['interfaces["GigabitEthernet0/0/0"].type', 'interfaces["GigabitEthernet0/0/1"].type', 'interfaces["GigabitEthernet0/0/1"].vlanTagging', 'interfaces.Loopback0.type', 'interfaces["Port-channel1"].type', 'interfaces["GigabitEthernet0/0/2"].type'])
  })
})

describe('names for ports from another platform (convert mode suggestions)', () => {
  it('names Ethernet by speed and numbers, a channel with a colon', () => {
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 1000, numbers: [0, 0, 0] })).toBe('GigabitEthernet0/0/0')
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 10000, numbers: [1, 2, 3, 4] })).toBe('TenGigabitEthernet1/2/3:4')
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 100000, numbers: [0, 0] })).toBe('HundredGigE0/0')
    expect(plugin.nameInterface?.({ type: 'ethernet', numbers: [0, 0, 0] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 1234, numbers: [0] })).toBeUndefined()
  })

  it('names loopbacks, port-channels, tunnels, VLANs and management port 0 by number', () => {
    expect(plugin.nameInterface?.({ type: 'loopback', numbers: [0] })).toBe('Loopback0')
    expect(plugin.nameInterface?.({ type: 'aggregate', numbers: [2] })).toBe('Port-channel2')
    expect(plugin.nameInterface?.({ type: 'aggregate', numbers: [0] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'tunnel', numbers: [5] })).toBe('Tunnel5')
    expect(plugin.nameInterface?.({ type: 'vlan', numbers: [100] })).toBe('Vlan100')
    expect(plugin.nameInterface?.({ type: 'management', numbers: [0] })).toBe('GigabitEthernet0')
    expect(plugin.nameInterface?.({ type: 'management', numbers: [1] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'other', numbers: [1] })).toBeUndefined()
  })

  it('writes a reference to subinterface 0 as the main interface', () => {
    const route = { nextHops: { '0': { address: '192.0.2.2', interface: 'Gi0/0/0.0' } } }
    const model: Device = { system: { ntp: { sourceInterface: 'Gi0/0/1.0' }, logging: { sourceInterface: 'Gi0/0/1.20' } }, networkInstances: { default: { staticRoutes: { '0.0.0.0/0': route } } } }
    const { text } = plugin.render!(model, { modelVersion: MODEL_VERSION })
    expect(text).toContain('ip route 0.0.0.0 0.0.0.0 Gi0/0/0 192.0.2.2\n')
    expect(text).toContain('ntp source Gi0/0/1\n')
    expect(text).toContain('logging source-interface Gi0/0/1.20\n')
  })
})
