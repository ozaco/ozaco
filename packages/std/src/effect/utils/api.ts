import { fail } from 'std:result'

import { EffectErrors } from '../errors'
import { createApiInternal } from '../internal/api/create'
import type { Helpers } from '../types/helpers'
import type { Api } from '../types/operation'

export function createApi<T extends object>(name: string, core: T): Api<T> {
  return createApiInternal(name, core)
}

export const api: Helpers.Apis = {
  scope: createApi<Helpers.ScopeApi>('Scope', {
    create() {
      throw fail(EffectErrors.NoScopeHandler, 'no handler for Scope.create()')
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
