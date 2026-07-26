import type { Operation } from 'std:effect'
import { mapError, validate } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CoreErrors } from '../const'
import type { Action } from '../types/action'
import { ActionContext } from '../utils/context'

import { bodyChannel } from './wire'

const evaluateWith = function* <T>(result: unknown, op: Operation<T>) {
  return yield* ActionContext.with(result as Action, function* () {
    return yield* op
  })
}

const asValidation =
  (scope: 'input' | 'output') =>
  (failure: Result.Failure<unknown>): Result.Failure<unknown> =>
    fail(CoreErrors.Validation, failure.message, scope) as Result.Failure<unknown>

/**
 * Validate only what a schema can speak for — the `normal` channel, and nothing else.
 *
 * Handing a live stream to `validate()` was always nonsense: it either rejected a healthy feed or
 * passed vacuously. Now the wire states plainly which channel holds a value, so the question does
 * not arise, and a byte channel (no schema) is skipped for the same reason.
 */
export const withValidation = (handler: AnyType, wire: Action.Wire) => {
  const inbound = bodyChannel(wire.input)?.schema
  const outbound = bodyChannel(wire.output)?.schema

  const result = function* (...callArgs: AnyType[]) {
    let args = callArgs

    if (inbound) {
      const parsed = yield* evaluateWith(
        result,
        mapError(validate(inbound, callArgs[0]), asValidation('input')),
      )

      args = [parsed, ...callArgs.slice(1)]
    }

    const handlerResult = yield* evaluateWith(result, handler(...args))

    if (outbound) {
      return yield* evaluateWith(
        result,
        mapError(validate(outbound, handlerResult), asValidation('output')),
      )
    }

    return handlerResult
  }

  return result
}
