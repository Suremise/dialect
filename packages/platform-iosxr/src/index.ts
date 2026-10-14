// @dialect/platform-iosxr: the IOS-XR plugin (B13). The indentation-tree parser with route policies and sets kept whole
// (tree.ts), mapping into the shared model (parse.ts) and rendering from it (render.ts), for the phase 1 areas and OSPF
// and BGP, and detect(). Platform-neutral: strings in, strings and plain objects out.
import type { PlatformPlugin } from '@dialect/core'
import { detect } from './detect'
import { describeInterface, nameInterface } from './names'
import { parse } from './parse'
import { render } from './render'

export { detect } from './detect'
export { describeInterface, nameInterface } from './names'
export { parse } from './parse'
export { render } from './render'
export { parseTree, type NodeKind, type XrNode, type XrTree } from './tree'

const plugin: PlatformPlugin = {
  id: 'iosxr',
  name: 'Cisco IOS-XR',
  // 0.4.1: its parse fills OSPF and BGP, with BGP's default policy for eBGP (RFC 8212), which a 0.4.0 core doesn't know.
  modelApi: '>=0.4.1 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'partial', render: 'full' },
    interfaces: { parse: 'partial', render: 'partial' },
    'static-routes': { parse: 'partial', render: 'partial' },
    ntp: { parse: 'partial', render: 'full' },
    syslog: { parse: 'partial', render: 'partial' },
    snmp: { parse: 'partial', render: 'partial' },
    ospf: { parse: 'partial', render: 'partial' },
    bgp: { parse: 'partial', render: 'partial' }
  },
  detect,
  parse,
  render,
  describeInterface,
  nameInterface
}

export default plugin
