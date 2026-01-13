import type { Helpers, Impl } from '../../types'

import { isContext } from '../context'
import { isDefinition } from '../definition'
import { isDependencyList } from '../dependency-list'
import { isExtendable } from '../extendable'

import { createApi } from './api'

export const createUse: Impl.CreateUse = ({ event, extendable, api, rebindings, executedDefinitionMap }) => {
  return target => {
    if (isDependencyList(target) || isContext(target)) {
      return target.getBinding(extendable)
    } else if (isDefinition(target)) {
      const check = executedDefinitionMap.has(target)

      if (check) {
        return executedDefinitionMap.get(target)
      }

      // TODO: better implementation instead of returning null

      return null
    } else if (isExtendable(target)) {
      const tempExecutedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()

      // FIX: this may be an illegal optimization !!!
      if (extendable === target) {
        return api
      }

      return createApi({
        event,
        rebindings,
        extendable: target,
        executedDefinitionMap: tempExecutedDefinitionMap,
      })
    }

    return target
  }
}
