import { resource } from '../base/resource'
import type { Operation } from '../types/operation'

/**
 * An `AbortSignal` bound to the current scope: it aborts automatically when the scope shuts down.
 * The bridge for passing cancellation into promise-based APIs like `fetch`.
 */
export const useAbortSignal = (): Operation<AbortSignal> =>
  resource(function* (provide) {
    const controller = new AbortController()
    try {
      yield* provide(controller.signal)
    } finally {
      controller.abort()
    }
  })
