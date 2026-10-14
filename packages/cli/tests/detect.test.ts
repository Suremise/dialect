// Auto-detect over the corpus with every plugin registered (#58): each file of fixtures/public/<platform> detects as its
// own platform, but for the misses listed here, each with why. Whole configurations never miss. A listed file that
// starts detecting right fails too, so the list stays true.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRegistry } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import iosxr from '@dialect/platform-iosxr'
import junos from '@dialect/platform-junos'
import nxos from '@dialect/platform-nxos'

const corpus = fileURLToPath(new URL('../../../fixtures/public/', import.meta.url))
const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))

/** Batfish's unit tests put several platforms' syntax in one file, to exercise its parsers: no platform is right for them. */
const MIXED = 'Batfish\'s unit test mixes IOS, NX-OS, IOS-XR and ASA syntax in one file'

/** The files that don't detect as their own platform, by path under fixtures/public, and why. */
const MISSES: Readonly<Record<string, string>> = {
  'junos/pairs/jcc__config_13.conf': 'a fragment (event-options alone) with none of the stanzas Junos detect counts',
  'junos/pairs/jcc__config_13_set.set': 'the same fragment in set form',
  'junos/pairs/jcc__config_21.conf': 'a fragment of replace: stanzas, a load file rather than a configuration',
  'iosxe/filters/batfish__unit-tests_cisco_acl.cfg': MIXED,
  'iosxe/filters/batfish__unit-tests_cisco_ipv6_access_list.cfg': MIXED,
  'iosxe/isis/batfish__unit-tests_cisco_isis.cfg': MIXED,
  'iosxe/mgmt/batfish__unit-tests_cisco_logging.cfg': MIXED,
  'iosxe/mgmt/batfish__unit-tests_cisco_snmp.cfg': MIXED,
  'iosxe/system/batfish__unit-tests_cisco_domain.cfg': MIXED,
  'iosxe/system/batfish__ios-unicode.cfg': 'UTF-16 text, which detect reads as characters with spaces between them',
  'nxos/filters/aerleon__CiscoNXTest.testStandardTermHostV6.cfg': 'one IPv6 access list with unnumbered entries, written the same way on IOS, NX-OS and IOS-XR'
}

describe('auto-detect over the corpus, every plugin registered', () => {
  const registry = createRegistry([junos, iosxe, nxos, iosxr])
  for (const platform of ['junos', 'iosxe', 'nxos', 'iosxr']) {
    describe(platform, () => {
      for (const file of files(join(corpus, platform))) {
        const path = relative(corpus, file).split(sep).join('/')
        const miss = Object.hasOwn(MISSES, path) ? MISSES[path] : undefined
        it(miss ? `${path} misses: ${miss}` : path, () => {
          const top = registry.detect(readFileSync(file, 'utf8'))[0]?.plugin.id
          if (miss) expect(top, 'detects right now: take it off the list').not.toBe(platform)
          else expect(top).toBe(platform)
        })
      }
    })
  }

  it('lists no file the corpus doesn\'t have, and no whole configuration', () => {
    for (const path of Object.keys(MISSES)) {
      expect(statSync(join(corpus, path)).isFile(), path).toBe(true)
      expect(path, 'a whole configuration detects as its platform').not.toMatch(/\/whole\//)
    }
  })
})
