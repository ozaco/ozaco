import '@ozaco/std/effects'

import type * as ts from 'typescript/lib/tsserverlibrary'
// import { lexer } from './lexer'

function init(_modules: any) {
  function create(info: ts.server.PluginCreateInfo) {
    const proxy: ts.LanguageService = Object.create(null)

    for (const k in info.languageService) {
      ;(proxy as any)[k] = (info.languageService as any)[k]
    }

    proxy.getQuickInfoAtPosition = (filename, position) => {
      const prior = info.languageService.getQuickInfoAtPosition?.(filename, position)
      if (!prior) {
        return undefined
      }

      if (!(filename.endsWith('.ts') && prior.displayParts)) {
        return prior
      }

      const content = prior.displayParts.map(part => part.text).join('')
      // const lexed = lexer(content)

      const newDisplayParts = prior.displayParts

      newDisplayParts.push({
        text: 'test2',
        kind: 'text',
      })

      return { ...prior, displayParts: newDisplayParts }
    }

    return proxy
  }

  return { create }
}

// @ts-expect-error
export = init
