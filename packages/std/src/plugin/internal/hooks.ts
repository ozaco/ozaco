import type { Api, Operation } from 'std:effect'
import { appendCauses, asFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import type { Hooks } from '../types/hooks'

/**
 * Adapt a per-action handler map into ONE api middleware over `dispatch`: actions without a handler
 * pass straight through to `next`, decorated ones run through `wrap`.
 */
const layer = (handlers: Record<string, AnyType>, wrap: Hooks.Wrap) => ({
  dispatch: ([key, args]: [string, unknown[]], next: Hooks.Next): Operation<unknown> => ({
    *[Symbol.iterator]() {
      if (!Object.hasOwn(handlers, key)) {
        return yield* next(key, args)
      }
      return yield* wrap(handlers[key], [key, args], next)
    },
  }),
})

/**
 * The protocol hook surface, rebuilt on the api layer: every hook family is sugar over
 * `api.around` on the protocol's dispatch member — scope-scoped, inherited by children, reverted
 * when the scope closes.
 */
export const createHookInstallers = (api: Api<Hooks.Dispatch>) => ({
  around: (handlers: AnyType): Operation<void> =>
    api.around(
      layer(flatten(handlers), (fn, [key, args], next) =>
        fn(args, (...nextArgs: unknown[]) => next(key, nextArgs)),
      ),
    ),

  before: (handlers: AnyType): Operation<void> =>
    api.around(
      layer(flatten(handlers), (fn, [key, args], next) => ({
        *[Symbol.iterator]() {
          yield* fn(args)
          return yield* next(key, args)
        },
      })),
    ),

  after: (handlers: AnyType): Operation<void> =>
    api.around(
      layer(flatten(handlers), (fn, [key, args], next) => ({
        *[Symbol.iterator]() {
          let result = yield* next(key, args)
          const modified = yield* fn(result, args)
          if (modified !== undefined) {
            result = modified
          }
          return result
        },
      })),
    ),

  error: (handlers: AnyType): Operation<void> =>
    api.around(
      layer(flatten(handlers), (fn, [key, args], next) => ({
        *[Symbol.iterator]() {
          try {
            return yield* next(key, args)
          } catch (error) {
            let failure = asFailure(error)

            try {
              yield* fn(error, args)
            } catch (hookError) {
              // a throwing error hook masks the running failure while keeping it in the cause chain
              failure = appendCauses(
                asFailure(hookError),
                `masked: ${failure.message || String(failure.error)}`,
                ...failure.causes,
              )
            }

            yield* failure
          }
        },
      })),
    ),
})
