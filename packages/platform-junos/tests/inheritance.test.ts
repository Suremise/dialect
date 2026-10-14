// Configuration groups and interface ranges, one documented rule per test, each with Juniper's page that states it.
// Where the documentation is silent, the behaviour is `unsupported` rather than a guess (the last tests).
//
// GROUPS = https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/configuration-groups-usage.html
// RANGES = https://www.juniper.net/documentation/us/en/software/junos/interfaces-fundamentals/topics/task/interfaces-interface-ranges-multi-task.html
import { describe, expect, it } from 'vitest'
import { MODEL_VERSION } from '@dialect/core'
import { parse } from '../src'

const context = { modelVersion: MODEL_VERSION }
const model = (text: string) => parse(text, context).model
const lines = (...l: string[]) => `${l.join('\n')}\n`

describe('configuration groups (GROUPS)', () => {
  // "How to Apply a Configuration Group": "The configuration data in the first group takes priority over the data in
  // subsequent groups."
  it('R1: the first group listed in apply-groups wins over later ones', () => {
    const text = lines('set groups A system domain-name a.example', 'set groups B system domain-name b.example', 'set groups B system host-name from-b', 'set apply-groups [ A B ]')
    expect(model(text).system).toEqual({ domainName: 'a.example', hostname: 'from-b' })
  })

  // "How to Apply a Configuration Group": "Groups listed in nested apply-groups statements take priority over groups in
  // outer statements."
  it('R2: a nested apply-groups wins over an outer one', () => {
    const text = lines('set groups OUTER interfaces ge-0/0/0 description outer', 'set groups INNER interfaces ge-0/0/0 description inner', 'set apply-groups OUTER', 'set interfaces ge-0/0/0 apply-groups INNER', 'set interfaces ge-0/0/0 unit 0')
    expect(model(text).interfaces!['ge-0/0/0'].description).toBe('inner')
  })

  // "How to Apply a Configuration Group": "Values specified at the specific hierarchy level override values inherited
  // from the configuration group."
  it('R3: what the configuration says itself wins over what it inherits', () => {
    const text = lines('set groups G interfaces <*> mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 mtu 1514')
    expect(model(text).interfaces!['ge-0/0/0'].mtu).toBe(1514)
  })

  // "Example: Use Wildcards with Configuration Groups": "In any matching within the configuration, whether it is done
  // with or without wildcards, the first item encountered in the configuration that matches is used." Its example
  // keeps one value from the first pattern, another from a later one and a third from the literal entry: every
  // matching entry contributes, and the first wins only where two set the same value.
  describe('R4: within a group, every matching entry applies; the first entry wins each value it sets', () => {
    it('a later wildcard still gives the values the first one does not set (repro A)', () => {
      const text = lines('set groups G interfaces <ge-*> mtu 1500', 'set groups G interfaces <*> description fallback', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0')
      expect(model(text).interfaces!['ge-0/0/0']).toMatchObject({ mtu: 1500, description: 'fallback' })
    })

    it('between two wildcards, the first one in the group wins, in either order', () => {
      const first = lines('set groups G interfaces <ge-*> mtu 1500', 'set groups G interfaces <*> mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0', 'set interfaces xe-0/0/0 unit 0')
      const second = lines('set groups G interfaces <*> mtu 9000', 'set groups G interfaces <ge-*> mtu 1500', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0', 'set interfaces xe-0/0/0 unit 0')
      expect([model(first).interfaces!['ge-0/0/0'].mtu, model(first).interfaces!['xe-0/0/0'].mtu]).toEqual([1500, 9000])
      expect([model(second).interfaces!['ge-0/0/0'].mtu, model(second).interfaces!['xe-0/0/0'].mtu]).toEqual([9000, 9000])
    })

    it('between a wildcard and a literal name, whichever comes first wins, in either order (repro B)', () => {
      const wildcardFirst = lines('set groups G interfaces <ge-*> mtu 1500', 'set groups G interfaces ge-0/0/0 mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0')
      const literalFirst = lines('set groups G interfaces ge-0/0/0 mtu 9000', 'set groups G interfaces <ge-*> mtu 1500', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0')
      expect(model(wildcardFirst).interfaces!['ge-0/0/0'].mtu).toBe(1500)
      expect(model(literalFirst).interfaces!['ge-0/0/0'].mtu).toBe(9000)
    })

    it('holds for nested unit and family values, in either form', () => {
      const set = lines(
        'set groups G interfaces <ge-*> unit <*> family inet mtu 1500',
        'set groups G interfaces <*> unit <*> family inet mtu 9000',
        'set groups G interfaces <*> unit <*> description fallback',
        'set apply-groups G',
        'set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24'
      )
      const hierarchical = [
        'groups {',
        '    G {',
        '        interfaces {',
        '            <ge-*> {',
        '                unit <*> {',
        '                    family inet {',
        '                        mtu 1500;',
        '                    }',
        '                }',
        '            }',
        '            <*> {',
        '                unit <*> {',
        '                    description fallback;',
        '                    family inet {',
        '                        mtu 9000;',
        '                    }',
        '                }',
        '            }',
        '        }',
        '    }',
        '}',
        'apply-groups G;',
        'interfaces {',
        '    ge-0/0/0 {',
        '        unit 0 {',
        '            family inet {',
        '                address 192.0.2.1/24;',
        '            }',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n')
      for (const text of [set, hierarchical]) {
        expect(model(text).interfaces!['ge-0/0/0'].subinterfaces!['0']).toEqual({ description: 'fallback', ipv4: { mtu: 1500, addresses: { '192.0.2.1': { prefixLength: 24 } } } })
      }
    })

    it('the superseded entry says which line won', () => {
      const p = parse(lines('set groups G interfaces <ge-*> mtu 1500', 'set groups G interfaces <*> mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0'), context)
      expect(p.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 1' })
    })
  })

  // "Example: Use Wildcards with Configuration Groups": "Wildcard expressions match (and provide configuration data for)
  // existing statements in the configuration that match their expression only."
  it('R5: a wildcard matches what the configuration has, and creates nothing', () => {
    const p = parse(lines('set groups G interfaces <xe-*> mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0'), context)
    expect(Object.keys(p.model.interfaces!)).toEqual(['ge-0/0/0'])
    expect(p.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'in a group, but matches nothing where the group is applied' })
  })

  // "Example: Configure Sets of Statements with Configuration Groups": "When sets of statements exist in configuration
  // groups, all values are inherited."
  it('R6: sets add up: every value of a group and of the configuration is kept', () => {
    const text = lines('set groups G system domain-search a.example', 'set groups G system name-server 192.0.2.1', 'set apply-groups G', 'set system domain-search b.example', 'set system name-server 192.0.2.2')
    const m = model(text)
    expect(m.system!.dns).toEqual({ search: ['a.example', 'b.example'], servers: { '192.0.2.1': {}, '192.0.2.2': {} } })
  })

  // "Example: Disable Inheritance of a Configuration Group": "You can disable inheritance of a configuration group at any
  // level except the top level of the hierarchy."
  it('R7: apply-groups-except stops a group below its level, and is unsupported at the top level', () => {
    const below = parse(lines('set groups G interfaces <*> mtu 9000', 'set apply-groups G', 'set interfaces ge-0/0/0 unit 0', 'set interfaces ge-0/0/1 apply-groups-except G', 'set interfaces ge-0/0/1 unit 0'), context)
    expect([below.model.interfaces!['ge-0/0/0'].mtu, below.model.interfaces!['ge-0/0/1'].mtu]).toEqual([9000, undefined])
    const top = parse(lines('set groups G interfaces <*> mtu 9000', 'set apply-groups G', 'set apply-groups-except G', 'set interfaces ge-0/0/0 unit 0'), context)
    expect(top.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'apply-groups-except at the top level, which Junos refuses' })
  })
})

describe('interface ranges (RANGES)', () => {
  // "Common Configuration Inheritance": an interface in several ranges "will inherit the common configuration from all
  // of those interface ranges"; "Configuration Inheritance Priority": "The first interface range configuration data
  // takes priority over subsequent interface ranges."
  it("R8: a member takes every range's settings, the first range's where they differ, in either form", () => {
    const set = lines('set interfaces interface-range A member ge-0/0/0', 'set interfaces interface-range A mtu 1500', 'set interfaces interface-range B member ge-0/0/0', 'set interfaces interface-range B mtu 9000', 'set interfaces interface-range B description from-B')
    const hierarchical = 'interfaces {\n    interface-range A {\n        member ge-0/0/0;\n        mtu 1500;\n    }\n    interface-range B {\n        member ge-0/0/0;\n        mtu 9000;\n        description from-B;\n    }\n}\n'
    for (const text of [set, hierarchical]) expect(model(text).interfaces!['ge-0/0/0']).toMatchObject({ mtu: 1500, description: 'from-B' })
  })

  // "Configuration Inheritance for Member Interfaces": "Foreground interface configuration takes priority over
  // configuration that the interface inherits".
  it("R9: an interface's own settings win over its range's", () => {
    const text = lines('set interfaces interface-range A member-range ge-0/0/0 to ge-0/0/1', 'set interfaces interface-range A mtu 1500', 'set interfaces ge-0/0/1 mtu 9000')
    const interfaces = model(text).interfaces!
    expect([interfaces['ge-0/0/0'].mtu, interfaces['ge-0/0/1'].mtu]).toEqual([1500, 9000])
  })

  // "Configuration Group Inheritance": "Interface range member interfaces inherit configurations from configuration
  // groups like any other foreground configuration", after the member expansion. "Configure Interface Ranges": a range
  // can have "just member or member-range statements and no common configuration statement".
  it("R10: members are interfaces groups apply to, a range with only members included, and the range's settings win over a group's", () => {
    const text = lines(
      'set interfaces interface-range BARE member ge-0/0/0',
      'set interfaces interface-range BARE member-range ge-0/0/1 to ge-0/0/2',
      'set interfaces interface-range SET member ge-0/0/3',
      'set interfaces interface-range SET mtu 1514',
      'set groups G interfaces <*> mtu 9000',
      'set apply-groups G'
    )
    expect(model(text).interfaces).toEqual({
      'ge-0/0/0': { type: 'ethernet', mtu: 9000 },
      'ge-0/0/1': { type: 'ethernet', mtu: 9000 },
      'ge-0/0/2': { type: 'ethernet', mtu: 9000 },
      'ge-0/0/3': { type: 'ethernet', mtu: 1514 }
    })
  })

  it('R10, with members a group defines and apply-groups-except on one of them', () => {
    const text = lines(
      'set groups RANGES interfaces interface-range R member ge-0/0/0',
      'set groups RANGES interfaces interface-range R member ge-0/0/1',
      'set groups G interfaces <*> mtu 9000',
      'set apply-groups [ RANGES G ]',
      'set interfaces ge-0/0/1 apply-groups-except G'
    )
    expect(model(text).interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', mtu: 9000 } })
  })
})

describe('what the documentation leaves open, or this converter does not do: unsupported, never guessed', () => {
  // RANGES documents member patterns ("*", "[low-high]", "[num1, num2]"); expanding them needs the device's port
  // count ("* includes interface numbers ranging from 0 through 47"), so they stay unsupported, visibly.
  it('member patterns are unsupported, and the rest of the range still converts', () => {
    const p = parse(lines('set interfaces interface-range R member [ "ge-0/0/[0,1]" ge-0/0/2 ]', 'set interfaces interface-range R mtu 1500'), context)
    expect(p.dispositions.L1.kind).toBe('unsupported')
    expect(p.model.interfaces).toEqual({ 'ge-0/0/2': { type: 'ethernet', mtu: 1500 } })
  })

  // GROUPS doesn't describe apply-groups inside a group's own statements.
  it('apply-groups inside a group is unsupported', () => {
    const p = parse(lines('set groups G interfaces ge-0/0/0 apply-groups H', 'set groups H interfaces ge-0/0/0 mtu 9000', 'set apply-groups G'), context)
    expect(p.dispositions.L1).toEqual({ kind: 'unsupported', reason: 'apply-groups inside a group' })
  })
})
