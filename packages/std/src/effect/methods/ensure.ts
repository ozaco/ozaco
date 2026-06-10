import type { Operation } from '../types/operation'

import { isOperation } from './is'
import { resource } from './resource'

export const ensure = (fn: () => Operation<unknown, unknown> | void): Operation<void, unknown> =>
  resource(function* (provide) {
    try {
      yield* provide()
    } finally {
      const result = fn()
      if (isOperation(result)) {
        yield* result
      }
    }
  })
