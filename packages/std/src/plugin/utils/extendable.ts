import { createEvent } from 'std:event'
import type { BlobType, EmptyType } from 'std:shared'

import { EXTENDABLE } from '../const'
import type { Extendable, Helpers, Impl } from '../types'

import { isContext } from './context'
import { isDefinition } from './definition'
import { isDependencyList } from './dependency-list'

export const createExtendable: Impl.CreateExtendable = meta => {
  type Result = Extendable<typeof meta, EmptyType>

  const event = createEvent() as Result['event']
  const definitionList: Helpers.AnyDefinition[] = []

  const result: Result = {
    _t: EXTENDABLE,
    _m: Object.assign({}, meta),

    event,

    getDefinitions: () => definitionList,

    define: (...args: BlobType[]) => {
      for (const arg of args) {
        if (isContext(arg)) {
          arg.bind(result)

          event.emit('context', arg)
        } else if (isDependencyList(arg)) {
          arg.bind(result)

          event.emit('dependency-list', arg)
        } else if (isDefinition(arg)) {
          if (!definitionList.includes(arg)) {
            definitionList.push(arg)
          }

          arg.event.emit('extendable', result)
          event.emit('definition', arg)
        }
      }

      return result
    },
  }

  return result
}

export const isExtendable = (value: unknown): value is Helpers.AnyExtendable => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === EXTENDABLE
}
