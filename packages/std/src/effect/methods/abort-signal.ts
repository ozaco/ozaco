import type { Operation } from '../types/operation'

import { resource } from './resource'

export const useAbortSignal = (): Operation<AbortSignal> =>
  resource(function* (provide) {
    const controller = new AbortController()
    try {
      yield* provide(controller.signal)
    } finally {
      controller.abort()
    }
  })
