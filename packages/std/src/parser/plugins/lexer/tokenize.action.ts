import { err } from '../../../results'

import { lexerPluginBase } from './base'

import { utilsAction } from './utils.action'

export const tokenizeAction = lexerPluginBase.action('tokenize', rawCtx => {
  const ctx = rawCtx.$tag('regex-parse-error')

  const tokenize = ctx.$safe('tokenize', function* (rawInput: string) {
    const utils = ctx.$peek(utilsAction)

    const tokens: Std.Parser.Token[] = []

    let input = rawInput
    let token: Std.Parser.Token
    let lastPosition = 0

    // Keep processing the string until it is empty
    while (input.length > 0) {
      // Get the next token and the token type
      const result = yield* utils.getNextToken(input)
      token = result.token

      if (!token.value) {
        return err(
          ctx.tags.get('tokenize/regex-parse-error'),
          'Regex parse error, please check your lexer config.'
        ).appendData(input)
      }

      token.position = [lastPosition, lastPosition + token.value.length - 1]
      lastPosition += token.value.length

      // Advance the string
      input = input.substring(token.value.length)

      if (!result.config.ignore) {
        tokens.push(token)
      }
    }
    return tokens
  })

  return ctx.apply({
    tokenize,
  })
})
