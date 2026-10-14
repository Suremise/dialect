// @dialect/platform-junos: the Junos plugin. Its default export is the plugin for the core's registry, whose tools()
// has display set; the parser and the flattener are exported too. The mapping to and from the shared model comes in B4.
import { junos } from './plugin'

export const PACKAGE_NAME = '@dialect/platform-junos'

export default junos
export { displaySetTool, junos, type JunosTool } from './plugin'
export { JunosParseError, tokenize, type Token, type TokenKind } from './tokenizer'
export { parseConfig, type ConfigNode, type ParsedConfig, type ParseWarning, type WarningCode } from './tree'
export { annotationWarnings, displaySet, flatten, type DisplaySetError, type DisplaySetResult, type SetLine } from './displaySet'
