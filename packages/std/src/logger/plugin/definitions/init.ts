import type { EventEmitter } from 'std:event'
import { createDefinition, type PluginEvents } from 'std:plugin'
import { type BlobType, isArray, isBoolean, isFunction } from 'std:shared'

import { transportContext } from '../../create-transport'
import type { Options } from '../../type'
import { isTransport } from '../../utils'
import { loggerContext, loggerDependencies } from '../base'

const listeners = new WeakMap<EventEmitter<BlobType>, BlobType>()

export const init = createDefinition(({ use, event }) => {
  const ctx = use(loggerContext)

  if (!listeners.has(event)) {
    const listener = ({ plugin, dependency }: PluginEvents['use']) => {
      const transports = isArray(dependency)
        ? dependency
        : [
            dependency,
          ]

      for (const transport of transports) {
        if (!isTransport(transport)) {
          continue
        }

        transport.get(transportContext).logger = plugin
      }
    }

    event.on('use', listener)

    listeners.set(event, listener)
  }

  return (options?: Options) => {
    ctx.level = options?.level ?? ctx.level
    ctx.disabled = options?.disabled ?? ctx.disabled
    ctx.noConsole = options?.noConsole ?? ctx.noConsole

    ctx.scope = options?.scope ?? ctx.scope
    ctx.date = isBoolean(options?.date)
      ? options.date
        ? () => new Date().toISOString()
        : null
      : (options?.date ?? ctx.date)

    if (isBoolean(options?.date)) {
      ctx.getDate = options.date ? () => new Date().toISOString() : null
    } else if (isFunction(options?.date)) {
      ctx.getDate = options.date
    }

    if (ctx?.scope) {
      const colors = use(loggerDependencies).colors.api

      ctx.getScope = () => colors.style.bold(colors.text.gray(`[${colors.text.gray(ctx.scope)}]`))
    }
  }
})
