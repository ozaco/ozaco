import { lexerPlugin } from '@ozaco/std/parser'

export const lexer = lexerPlugin(
  {
    regexes: [/^(const)/, /^(let)/, /^(var)/, /^(type)/, /^(interface)/, /^(enum)/, /^(as)/, /^(function)/, /^(class)/, /^(extends)/],
    type: 'declaration',
  },
  {
    regexes: [
      /^(import)/,
      /^(from)/,
      /^(export)/,
      /^(export default)/,
      /^(default)/,
      /^(return)/,
      /^(if)/,
      /^(else if)/,
      /^(else)/,
      /^(for)/,
      /^(for await)/,
      /^(while)/,
      /^(async)/,
      /^(await)/,
      /^(break)/,
      /^(continue)/,
      /^(switch)/,
      /^(case)/,
      /^(throw)/,
      /^(try)/,
      /^(catch)/,
      /^(finally)/,
      /^(new)/,
      /^(delete)/,
      /^(typeof)/,
      /^(instanceof)/,
      /^(in)/,
      /^(of)/,
      /^(void)/,
      /^(with)/,
      /^(debugger)/,
    ],
    type: 'keyword',
  },
  {
    regexes: [/^(\s+)/],
    type: 'whitespace',
  },
  {
    regexes: [
      /^(\(alias\))/,
      /^(\.\.\.)/, // Spread syntax,
      /^([0-9]+(\.[0-9]+)*)/, // version
    ],
    type: 'misc',
  },
  {
    regexes: [/^([a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+)/],
    type: 'namespace',
  },
  {
    regexes: [/^([a-zA-Z_$][a-zA-Z0-9_$]*)/],
    type: 'identifier',
  },
  {
    regexes: [/^[0-9]+(\.[0-9]+)?/],
    type: 'number',
  },
  {
    regexes: [
      /^(\()/, // Parantheses
      /^(\))/,
      /^(\{)/, // Braces
      /^(\})/,
      /^(\[)/, // Brackets
      /^(\])/,
      /^(<)/, // Generics
      /^(>)/,
      /^(\.)/, // Dot
      /^(:)/, // Colon (for types)
      /^(\?)/, // Question mark (optional properties/params)
      /^(!)/, // Non-null assertion
      /^(=)/, // Assignment
      /^(\+\+)/, // Increment
      /^(--)/, // Decrement
      /^(\+)/, // Addition
      /^(-)/, // Subtraction
      /^(\*)/, // Multiplication
      /^(\/)/, // Division
      /^(>)/, // Greater than
      /^(<)/, // Less than
      /^(>=)/, // Greater than or equal
      /^(<=)/, // Less than or equal
      /^(==)/, // Equal
      /^(===)/, // Strict equal
      /^(!=)/, // Not equal
      /^(!==)/, // Strict not equal
      /^(=>)/, // Arrow function
      /^(\|)/, // Union type
      /^(&)/, // Intersection Type
      /^(;)/, // Semicolon
      /^(,)/, // Comma
      /^(\\)/, // Backslash
      /^(\/\*)/, // Block comment
      /^(\*\/)/, // Block comment
      /^(\/)/, // Line comment
      /^(")/, // String
      /^(')/, // String
      /^(`)/, // Template string
      /^(#)/, // Hash (for comments)
      /^(@)/,
    ],
    type: 'symbol',
  },
)
