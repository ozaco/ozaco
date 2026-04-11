import type { Context } from 'std:effect'
import { isContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { App } from '../types/plugin'

import { isNamespace, isPlugin } from './is'

export const createApp = (): App => {
  const store = new Map<Context<unknown>, unknown>()

  const install: App['install'] = (plugin, ...args) => {
    const value = plugin.setup(...args)
    store.set(plugin.context as Context<unknown>, value)
    return value as AnyType
  }

  const use: App['use'] = (target: unknown) => {
    if (isPlugin(target)) {
      if (!store.has(target.context as Context<unknown>)) {
        throw new Error(`Plugin "${target.name}" is not installed`)
      }
      return store.get(target.context as Context<unknown>)
    } else if (isNamespace(target)) {
      if (!store.has(target.context as Context<unknown>)) {
        throw new Error(`Namespace "${target.name}" has no installed implementation`)
      }
      return store.get(target.context as Context<unknown>)
    } else if (isContext(target)) {
      const key = target as Context<unknown>
      if (!store.has(key)) {
        throw new Error('Context is not set')
      }
      return store.get(key)
    }

    return fail(target, 'use(target: unexpected)')
  }

  return {
    install,
    use,
  }
}
