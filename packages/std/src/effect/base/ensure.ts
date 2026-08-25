import type { Operation } from '../types/operation'

import { resource } from './resource'

/**
 * Run `fn` when the enclosing scope shuts down — the effect-native `finally`. `fn` may return an
 * operation, which is evaluated to completion during teardown.
 */
export function ensure(fn: () => Operation<unknown> | void): Operation<void> {
  return resource(function* (provide) {
    try {
      yield* provide()
    } finally {
      const result = fn()
      if (result && typeof result[Symbol.iterator] === 'function') {
        yield* result
      }
    }
  })
}
