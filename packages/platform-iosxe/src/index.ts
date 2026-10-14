// @dialect/platform-iosxe: the IOS / IOS-XE plugin (B8). The indentation-tree parser (tree.ts), mapping into the shared
// model (parse.ts) and rendering from it (render.ts), for the phase 1 areas, and detect(). Platform-neutral: strings in,
// strings and plain objects out.
import type { PlatformPlugin } from '@dialect/core'
import { detect } from './detect'
import { parse } from './parse'
import { render } from './render'

export { detect } from './detect'
export { parse } from './parse'
export { render } from './render'
export { parseTree, type IosNode, type IosTree, type NodeKind } from './tree'

const plugin: PlatformPlugin = {
  id: 'iosxe',
  name: 'Cisco IOS / IOS-XE',
  // 0.2.0: its parse fills system.dns, which a 0.1 core doesn't know.
  modelApi: '>=0.2.0 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'full', render: 'full' },
    interfaces: { parse: 'partial', render: 'partial' },
    'static-routes': { parse: 'partial', render: 'partial' },
    ntp: { parse: 'partial', render: 'full' },
    syslog: { parse: 'partial', render: 'partial' },
    snmp: { parse: 'partial', render: 'partial' }
  },
  detect,
  parse,
  render
}

export default plugin
