import { fail } from 'std:result'

import { createApiInternal } from '../internal/api-internal'
import type { Helpers } from '../types/helpers'
import type { Api, Utils } from '../types/utils'

/**
 * Create an {@link Api} whose implementation can be decorated within a scope.
 *
 * The `core` implementation defines the API's default behavior. Use `Api.around` or `Scope.around`
 * to install middleware that changes that behavior for a scope and its descendants.
 *
 * Ported from Effection v4.1 experimental (context APIs for algebraic effects).
 */
export function createApi<T extends object>(name: string, core: T): Api<T> {
  return createApiInternal(name, core)
}

/**
 * Built-in APIs used by the effect runtime and host integrations. Advanced integrations can
 * decorate these to observe or modify runtime behavior within a scope.
 */
export const api: Utils.Apis = {
  scope: createApi<Utils.ScopeApi>('Scope', {
    create() {
      throw fail('no-scope-handler', 'no handler for Scope.create()')
    },
    destroy(scope) {
      return (scope as Helpers.ScopeInternal).destroy()
    },
    set(scope, context, value) {
      ;(scope as Helpers.ScopeInternal).contexts[context.name] = value
      return value
    },
    delete(scope, context) {
      return Reflect.deleteProperty((scope as Helpers.ScopeInternal).contexts, context.name)
    },
  }),
}
