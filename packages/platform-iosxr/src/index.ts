// @dialect/platform-iosxr: the IOS-XR plugin (B13). The indentation-tree parser with route policies and sets kept whole
// (tree.ts), mapping into the shared model (parse.ts) and rendering from it (render.ts), for the phase 1 areas, and
// detect(). Platform-neutral: strings in, strings and plain objects out.
import type { PlatformPlugin } from '@dialect/core'
import { detect } from './detect'
import { parse } from './parse'
import { render } from './render'

export { detect } from './detect'
export { parse } from './parse'
export { render } from './render'
export { parseTree, type NodeKind, type XrNode, type XrTree } from './tree'

const plugin: PlatformPlugin = {
  id: 'iosxr',
  name: 'Cisco IOS-XR',
  // 0.3.0: its parse fills a subinterface's networkInstance and a VRF's route targets, which a 0.2 core doesn't know.
  modelApi: '>=0.3.0 <1.0.0',
  capabilities: {
    system: { parse: 'full', render: 'full' },
    dns: { parse: 'partial', render: 'full' },
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
