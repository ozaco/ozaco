import { succeed } from 'std:result'

import { CONTEXT } from '../const'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'

/** Get the scope of the currently running {@link Operation}. */
export function* useScope(): Operation<Scope> {
  return (yield {
    cause: 'useScope()',
    enter(resolve, { scope }) {
      resolve(succeed(scope))
      return exit => exit(succeed())
    },
  } as Helpers.Effect<Scope>) as Scope
}

/** Get the coroutine executing the current {@link Operation}. */
export function* useCoroutine(): Operation<Helpers.Coroutine> {
  return (yield {
    cause: 'useCoroutine()',
    enter: (resolve, routine) => {
      resolve(succeed(routine))
      return uninstalled => uninstalled(succeed())
    },
  } as Helpers.Effect<Helpers.Coroutine>) as Helpers.Coroutine
}

export const useContext = <T>(ctx: Context<T> | { context: Context<T> }): Operation<T> => {
  if ('context' in ctx && (ctx as { context: unknown }).context !== undefined) {
    const inner = (ctx as { context: Context<T> }).context
    if (inner && (inner as { _t?: unknown })._t === CONTEXT) {
      return inner.expect()
    }
  }
  return (ctx as Context<T>).expect()
}
