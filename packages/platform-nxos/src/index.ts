// @dialect/platform-nxos: the NX-OS plugin (B12). The indentation-tree parser (tree.ts), mapping into the shared model
// (parse.ts) and rendering from it (render.ts), for the phase 1 and phase 2 areas and phase 3's routing policy
// (policy.ts, renderPolicy.ts) and access lists (acl.ts, renderAcl.ts), and detect(). Platform-neutral: strings in, strings and plain objects out.
import type { PlatformPlugin } from '@dialect/core'
import { detect } from './detect'
import { describeInterface, nameInterface } from './names'
import { parse } from './parse'
import { render } from './render'

export { detect } from './detect'
export { describeInterface, nameInterface } from './names'
export { parse } from './parse'
export { render } from './render'
export { parseTree, type NxNode, type NxTree, type NodeKind } from './tree'

const plugin: PlatformPlugin = {
  id: 'nxos',
  name: 'Cisco NX-OS',
  // 0.5.4: its parse fills VLANs, switch ports, SVIs, OSPF and BGP, with BGP's default policy for eBGP (0.4.1), routing
  // policy (0.5.0), access lists (0.5.1), their entries' remarks (0.5.3) and LAGs (0.5.4), which an older core doesn't know.
  modelApi: '>=0.5.4 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'partial', render: 'full' },
    interfaces: { parse: 'partial', render: 'partial' },
    'static-routes': { parse: 'partial', render: 'partial' },
    ntp: { parse: 'partial', render: 'partial' },
    syslog: { parse: 'partial', render: 'full' },
    snmp: { parse: 'partial', render: 'partial' },
    vlans: { parse: 'partial', render: 'partial' },
    ospf: { parse: 'partial', render: 'partial' },
    bgp: { parse: 'partial', render: 'partial' },
    'routing-policy': { parse: 'partial', render: 'partial' },
    filters: { parse: 'partial', render: 'partial' }
  },
  detect,
  parse,
  render,
  describeInterface,
  nameInterface
}

export default plugin
