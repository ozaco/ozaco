import { fail } from 'std:result'

import { call } from '../base/call'
import { resource } from '../base/resource'
import type { Operation } from '../types/operation'

/**
 * Adopt a JS disposable (`Symbol.dispose` / `Symbol.asyncDispose`) as a scope-bound resource: it is
 * disposed automatically when the current scope shuts down.
 */
export function* using<T extends Disposable | AsyncDisposable>(value: T): Operation<T> {
  const dispose =
    Symbol.asyncDispose in value
      ? value[Symbol.asyncDispose]
      : Symbol.dispose in value
        ? value[Symbol.dispose]
        : undefined

  if (!dispose) {
    throw fail('using', 'using() value must implement Symbol.dispose or Symbol.asyncDispose')
  }

  return yield* resource<T>(function* (provide) {
    try {
      yield* provide(value)
    } finally {
      yield* call(() => dispose.call(value))
    }
  })
}
