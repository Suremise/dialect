// @dialect/platform-junos: the Junos plugin. Its default export is the plugin for the core's registry: parse into the
// shared model and render from it for the phase 1 areas, detect(), and display set in tools(). The tree parser, the
// flattener and the mapping's steps are exported too. Platform-neutral: strings in, strings and plain objects out.
import { junos } from './plugin'

export const PACKAGE_NAME = '@dialect/platform-junos'

export default junos
export { displaySetTool, junos, type JunosTool } from './plugin'
export { JunosParseError, tokenize, type Token, type TokenKind } from './tokenizer'
export { parseConfig, type ConfigNode, type ParsedConfig, type ParseWarning, type WarningCode } from './tree'
export { annotationWarnings, displaySet, flatten, type DisplaySetError, type DisplaySetResult, type SetLine } from './displaySet'
export { detect } from './detect'
export { parse } from './parse'
export { bgpKeyInputId, ospfKeyInputId, render, routeDistinguisherInputId, routeTargetInputId } from './render'
export { fromJunos, targetFromJunos, toJunos } from './communities'
export { isSetForm, readConfig, type ReadConfig, type Statement } from './statements'
export { expand, memberRange, type Expanded, type Expansion } from './expand'
