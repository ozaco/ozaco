import { err } from '../../../results'

import { lexerPluginBase } from './base'

export const utilsAction = lexerPluginBase.action('utils', rawCtx => {
  const ctx = rawCtx.$tag('no-matches', 'No matches found')

  const getTokenOnFirstMatch = ctx.$fn(
    'getTokenOnFirstMatch',
    ({ input, type, regex }: { input: string; type: string; regex: RegExp }) => {
      const matches = input.match(regex)

      if (matches) {
        return { type, value: matches[1] } as Std.Parser.Token
      }

      return err(ctx.tags.get('utils/no-matches'), 'No matches found')
    }
  )

  const getNextToken = ctx.$fn('getNextToken', (input: string) => {
    for (const eachLexer of ctx.options[0]) {
      for (const regex of eachLexer.regexes) {
        const token = getTokenOnFirstMatch({ input, type: eachLexer.type, regex })

        if (token.isOk()) {
          return {
            token: token.value,
            config: eachLexer,
          }
        }
      }
    }

    return err(ctx.tags.get('utils/no-matches'), 'No matches found')
  })

  return ctx.apply({
    getNextToken,
    getTokenOnFirstMatch,
  })
})
