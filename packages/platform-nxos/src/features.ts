// NX-OS `feature` lines: a feature turns on a part of the CLI, and its statements are refused until it is on. The parse
// and the render share this table: a feature some converted statement needs is `ignored-by-design` on parse (the render
// writes it back whenever it writes a statement that needs it); every other feature is a service of its own, and is
// `unsupported` until the model holds it.

/** The features the model's statements can need, and which interfaces need them (by name, as NX-OS decides). */
export const REQUIRED_FEATURES: readonly (readonly [feature: string, needs: RegExp, what: string])[] = [
  ['interface-vlan', /^vlan\d/i, 'Vlan interfaces'],
  ['tunnel', /^tunnel\d/i, 'Tunnel interfaces']
]

/**
 * The feature a VRF's route distinguisher and route targets need: they are BGP's (L3VPN), and NX-OS refuses `rd` and
 * `route-target` until it is on.
 */
export const VPN_FEATURE = 'bgp'

/** The features an interface needs, by its name. */
export const featuresFor = (name: string): string[] => REQUIRED_FEATURES.filter(([, needs]) => needs.test(name)).map(([feature]) => feature)
