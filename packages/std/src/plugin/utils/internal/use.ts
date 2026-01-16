import type { Helpers, Impl } from '../../types'

import { isContext } from '../context'
import { isDefinition } from '../definition'
import { isDependencyList } from '../dependency-list'
import { isExtendable } from '../extendable'

import { createApi } from './api'

export const createUse: Impl.CreateUse = ({ event, extendable, api, rebind, executedDefinitionMap }) => {
  const result: Helpers.DefinitionUse = target => {
    if (isDependencyList(target) || isContext(target)) {
      return target.getBinding(extendable)
    } else if (isDefinition(target)) {
      const check = executedDefinitionMap.has(target)

      if (check) {
        return executedDefinitionMap.get(target)
      }

      return target.getValue({
        event,
        use: result,
        rebind,
      })
    } else if (isExtendable(target)) {
      const tempExecutedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()

      // FIX: this may be an illegal optimization !!!
      if (extendable === target) {
        return api
      }

      return createApi({
        event,
        rebind,
        extendable: target,
        executedDefinitionMap: tempExecutedDefinitionMap,
      })
    }

    return target
  }

  return result
}
