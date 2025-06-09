// import { createLexer } from 'syntax-parser'

// export const lexer = createLexer([
//   {
//     type: 'misc',
//     regexes: [
//       /^(\(alias\))/,
//       /^(import)/,
//       /^(from)/,
//       /^(export)/,
//       /^(export default)/,
//       /^(default)/,
//     ],
//   },
//   {
//     type: 'whitespace',
//     regexes: [/^(\s+)/],
//   },
//   {
//     type: 'declaration',
//     regexes: [/^(const)/, /^(let)/, /^(var)/],
//   },
//   {
//     type: 'type-declaration',
//     regexes: [/^(type)/, /^(interface)/, /^(enum)/],
//   },
//   {
//     type: 'namespace',
//     regexes: [/^(([a-zA-Z0-9]+\.)+[a-zA-Z0-9]+)/],
//   },
//   {
//     type: 'word',
//     regexes: [/^([a-zA-Z0-9]+)/],
//   },
//   {
//     type: 'generic',
//     regexes: [/^([A-Z][a-zA-Z0-9]+)/],
//   },
//   {
//     type: 'punctuation',
//     regexes: [
//       /^(:)/,
//       /^(\{)/,
//       /^(\})/,
//       /^(\()/,
//       /^(\))/,
//       /^(;)/,
//       /^(,)/,
//       /^(<)/,
//       /^(>)/,
//       /^(\.)/,
//       /^(=)/,
//     ],
//   },
// ])
