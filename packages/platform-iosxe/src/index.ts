// @dialect/platform-iosxe: the IOS / IOS-XE plugin (B8). The indentation-tree parser (tree.ts), mapping into the shared
// model (parse.ts) and rendering from it (render.ts), for the phase 1 areas and phase 2's VLANs, OSPF and BGP, and
// detect(). Platform-neutral: strings in, strings and plain objects out.
import type { PlatformPlugin } from '@dialect/core'
import { detect } from './detect'
import { describeInterface, nameInterface } from './names'
import { parse } from './parse'
import { render } from './render'

export { detect } from './detect'
export { describeInterface, nameInterface } from './names'
export { parse } from './parse'
export { render } from './render'
export { parseTree, type IosNode, type IosTree, type NodeKind } from './tree'

const plugin: PlatformPlugin = {
  id: 'iosxe',
  name: 'Cisco IOS / IOS-XE',
  // 0.5.0: its parse fills VLANs, switch ports, a VLAN interface's routed VLAN, OSPF and BGP (0.4.0), BGP's default
  // for eBGP peers with no policy (0.4.1), and routing policy (0.5.0), which an older core doesn't know.
  modelApi: '>=0.5.0 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'full', render: 'full' },
    interfaces: { parse: 'partial', render: 'partial' },
    'static-routes': { parse: 'partial', render: 'partial' },
    ntp: { parse: 'partial', render: 'full' },
    syslog: { parse: 'partial', render: 'partial' },
    snmp: { parse: 'partial', render: 'partial' },
    vlans: { parse: 'partial', render: 'partial' },
    ospf: { parse: 'partial', render: 'partial' },
    bgp: { parse: 'partial', render: 'partial' },
    'routing-policy': { parse: 'partial', render: 'partial' }
  },
  detect,
  parse,
  render,
  describeInterface,
  nameInterface
}

export default plugin
