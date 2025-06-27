import { err } from '../../../results'

import { lexerPluginBase } from './base'

export const utilsAction = lexerPluginBase.action('utils', rawCtx => {
  const ctx = rawCtx.tag('no-matches')

  const getTokenOnFirstMatch = ctx.$fn(
    'get-token-on-first-match',
    ({ input, type, regex }: { input: string; type: string; regex: RegExp }) => {
      const matches = input.match(regex)

      if (matches) {
        return { type, value: matches[1] } as Std.Parser.Token
      }

      return err(ctx.tags.get('utils/no-matches'), 'No matches found')
    },
  )

  const getNextToken = ctx.$fn('get-next-token', (input: string) => {
    for (const eachLexer of ctx.meta.options) {
      for (const regex of eachLexer.regexes) {
        const token = getTokenOnFirstMatch({ input, regex, type: eachLexer.type })

        if (token.isOk()) {
          return {
            config: eachLexer,
            token: token.value,
          }
        }
      }
    }

    return err(ctx.tags.get('utils/no-matches'), 'No matches found').appendData(input)
  })

  return ctx.apply({
    getNextToken,
    getTokenOnFirstMatch,
  })
})
