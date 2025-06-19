import '@ozaco/std/effects'

import type * as ts from 'typescript/lib/tsserverlibrary'

import { logger } from './consts'
import { lexer } from './lexer'

function init(_modules: any) {
  function create(info: ts.server.PluginCreateInfo) {
    const proxy: ts.LanguageService = Object.create(null)

    for (const k in info.languageService) {
      if (Object.hasOwn(proxy, k)) {
        ;(proxy as any)[k] = (info.languageService as any)[k]
      }
    }

    proxy.getQuickInfoAtPosition = (filename, position) => {
      const prior = info.languageService.getQuickInfoAtPosition?.(filename, position)
      if (!prior) {
        return
      }

      if (!(filename.endsWith('.ts') && prior.displayParts)) {
        return prior
      }

      const content = prior.displayParts.map(part => part.text).join('')
      const tokensResult = lexer.tokenize.tokenize(content)

      if (tokensResult.isErr()) {
        logger.err('tokens', { ...tokensResult })

        prior.displayParts.push({
          kind: 'text',
          text: '(ozaco/language-service failed)',
        })

        return prior
      }

      logger.log('tokens', tokensResult.value)

      const newDisplayParts = prior.displayParts

      return { ...prior, displayParts: newDisplayParts }
    }

    return proxy
  }

  return { create }
}

// @ts-expect-error
export = init
