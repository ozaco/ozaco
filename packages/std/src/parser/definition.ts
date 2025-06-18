import type { parserTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/parser': typeof parserTags
    }

    namespace Parser {
      type Options = Std.Parser.LexerConfig[]

      interface Token {
        type: string
        value: string
        position: [number, number] | null
      }

      interface LexerConfig {
        type: string
        regexes: RegExp[]
        /**
         * Will match, by not add to token list.
         */
        ignore?: boolean
      }
    }
  }
}
