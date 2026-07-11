import type { Operation } from 'std:effect'
import { appendCauses, asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Hookable } from '../../types/hookable'

import { intercept } from './intercept'

// Collects the hook handlers registered for `key` across one hook list (around/before/after/error).
export const pickHooks = (list: Hookable.HookStore['around'], key: string): AnyType[] => {
  const out: AnyType[] = []
  for (const entry of list) {
    if (key in entry.handlers) {
      out.push(entry.handlers[key])
    }
  }
  return out
}

export function* runAround(
  call: Hookable.Call,
  inner: (...innerArgs: unknown[]) => Operation<unknown>,
): Operation<unknown> {
  const { arounds, args } = call

  if (arounds.length === 0) {
    return yield* intercept(inner(...args))
  }

  const makeNext =
    (i: number) =>
    (...nextArgs: unknown[]): AnyType => ({
      *[Symbol.iterator]() {
        if (i < arounds.length) {
          return yield* intercept(arounds[i](nextArgs, makeNext(i + 1)))
        }
        return yield* intercept(inner(...nextArgs))
      },
    })

  return yield* intercept(arounds[0](args, makeNext(1)))
}

// Runs `body`; on failure walks the `error` hooks. A throwing error hook masks the running failure
// (last one wins) while keeping the original in the cause chain.
export function* runWithErrorHooks(
  call: Hookable.Call,
  body: () => Operation<unknown>,
): Operation<unknown> {
  try {
    return yield* body()
  } catch (error) {
    let failure = asFailure(error)

    for (const hook of call.errors) {
      try {
        yield* intercept(hook(error, call.args), `${call.key}:error`)
      } catch (hookError) {
        failure = appendCauses(
          asFailure(hookError),
          `masked: ${failure.message || String(failure.error)}`,
          ...failure.causes,
        )
      }
    }

    yield* failure
  }
}
