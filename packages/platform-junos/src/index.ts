// @dialect/platform-junos: the Junos plugin. B3 brings the tree parser and the display set tool; the mapping to and
// from the shared model comes in B4.
export const PACKAGE_NAME = '@dialect/platform-junos'

export { JunosParseError, tokenize, type Token, type TokenKind } from './tokenizer'
export { parseConfig, type ConfigNode, type ParsedConfig, type ParseWarning, type WarningCode } from './tree'
export { annotationWarnings, displaySet, flatten, type DisplaySetError, type DisplaySetResult, type SetLine } from './displaySet'
