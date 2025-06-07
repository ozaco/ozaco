import type * as ts from 'typescript/lib/tsserverlibrary'
import { renamePluginActions } from './utils/plugin-actions'
import { renamePluginInstance } from './utils/plugin-instance'

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

      const newDisplayParts = renamePluginInstance(renamePluginActions(prior.displayParts))

      return { ...prior, displayParts: newDisplayParts }
    }

    return proxy
  }

  return { create }
}

export = init
