import { createEvent } from 'std:event'
import { type BlobType, isFunction } from 'std:shared'

import { CONTEXT } from '../const'
import type { Context, Helpers, Impl } from '../types'

import { isExtendable } from './extendable'

export const createContext: Impl.CreateContext = (data, cloneAlgorithm) => {
  type Result = Context<BlobType>

  const clone = isFunction(data) ? data : () => (cloneAlgorithm ?? Object.assign.bind(null, {}))(data)
  const bindings: WeakMap<Helpers.AnyExtendable, unknown> = new WeakMap()

  const event = createEvent() as Result['event']

  const getBinding: Result['getBinding'] = extendable => {
    const check = bindings.has(extendable)

    if (check) {
      return bindings.get(extendable)
    }

    return null
  }

  const result: Result = {
    _t: CONTEXT,

    event,

    getBinding,
    bind: (extendable, override = false) => {
      const existing = getBinding(extendable)

      if (isExtendable(existing) && !override) {
        return existing
      }

      const data = clone()

      bindings.set(extendable, data)

      event.emit('extendable', extendable)

      return data
    },
  }

  return result
}

export const isContext = (value: unknown): value is Helpers.AnyContext => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === CONTEXT
}
