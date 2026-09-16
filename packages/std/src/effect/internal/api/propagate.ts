import type { Helpers } from '../../types/helpers'
import type { Around, Middleware, Scope } from '../../types/operation'
import { ChildrenContext } from '../contexts'

import { append, decorate } from './decorate'

function propagate<A>(
  scope: Scope,
  api: Helpers.ApiInternal<A>,
  total: Helpers.Decorator<A>,
): void {
  let propagated = total

  if (scope.hasOwn(api.context)) {
    const state = scope.expect(api.context)

    state.total = total

    propagated = decorate(state.total, state.local)

    state.handle = createApiHandle(propagated, api.core)
  }

  for (const child of scope.expect(ChildrenContext)) {
    propagate(child, api, propagated)
  }
}

function createApiHandle<A>(decoration: Helpers.Decorator<A>, core: A): A {
  const around = decoration.max
    ? decoration.min
      ? append(decoration.max, decoration.min)
      : decoration.max
    : decoration.min

  if (!around) {
    return core
  }

  const handle = {} as A

  for (const key of Object.keys(core as object) as (keyof A)[]) {
    const middleware = around[key] as Middleware<unknown[], unknown> | undefined

    if (middleware) {
      if (typeof core[key] === 'function') {
        handle[key] = ((...args: unknown[]) =>
          middleware(args, core[key] as (...args: unknown[]) => unknown)) as A[keyof A]
      } else {
        Object.defineProperty(handle, key, {
          enumerable: true,
          get() {
            return middleware([], () => core[key])
          },
        })
      }
    } else {
      handle[key] = core[key]
    }
  }
  return handle
}

/**
 * Install `decorator` into `scope`: merge it into the scope's local decorations, rebuild the
 * scope's handle, and propagate the combined total down to every existing descendant scope.
 */
export function decorateApi<A>(
  scope: Scope,
  api: Helpers.ApiInternal<A>,
  ...[decorator, options]: [decorator: Partial<Around<A>>, options?: { at: 'min' | 'max' }]
): void {
  // this scope's own state, or a fresh one seeded from the nearest ancestor's: the ancestor's
  // local layers fold into the child's TOTAL (never its local), so a later ancestor decoration —
  // which re-propagates the ancestor's total ⊕ local — composes each layer exactly once
  const own = scope.hasOwn(api.context) ? scope.expect(api.context) : null
  const inherited = own ?? scope.get(api.context)
  const current: Helpers.ApiState<A> = own ?? {
    total: inherited ? decorate(inherited.total, inherited.local) : {},
    local: {},
    handle: api.core,
  }

  const local = decorate(current.local, {
    [options?.at ?? 'max']: decorator,
  })

  if (scope.hasOwn(api.context)) {
    current.local = local
  } else {
    scope.set(api.context, {
      local,
      total: current.total,
      handle: api.core,
    })
  }

  propagate(scope, api, current.total)
}
