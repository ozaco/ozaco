import { fail, isFailure } from 'std:result'

import { useScope } from '../base/hooks'
import { spawn } from '../base/spawn'
import { withResolvers } from '../base/with-resolvers'
import { EachStack } from '../internal/contexts'
import type { Operation, Flow } from '../types/operation'
import type { Utils } from '../types/utils'

// oxlint-disable-next-line import/exports-last
export function each<T>(flow: Flow<T, unknown>): Operation<Iterable<T>> {
  return {
    *[Symbol.iterator]() {
      const scope = yield* useScope()
      if (!scope.hasOwn(EachStack)) {
        scope.set(EachStack, [])
      }

      const done = withResolvers<void>()
      const cxt = withResolvers<Utils.EachLoop<T>>()

      yield* spawn(function* () {
        const subscription = yield* flow
        const current = yield* subscription.next()

        const stack = scope.expect(EachStack)

        const context: Utils.EachLoop<T> = {
          subscription,
          current,
          finish() {
            context.finish = () => {}
            stack.pop()
            done.resolve()
          },
        }

        stack.push(context)

        cxt.resolve(context)

        yield* done.operation
      })

      const context = yield* cxt.operation

      return {
        [Symbol.iterator]: () => ({
          next() {
            if (context.stale) {
              throw fail(
                'iteration-error',
                `for each loop did not use each.next() operation before continuing`,
              )
            } else {
              context.stale = true
              const current = context.current
              // honor the flow's return value: a Failure close means the source was truncated,
              // and ending the loop as if it completed cleanly would swallow that
              if (current.done && isFailure(current.value)) {
                context.finish()
                throw current.value
              }
              return current
            }
          },
          return() {
            context.finish()
            return { done: true, value: void 0 }
          },
        }),
      }
    },
  }
}

each.next = function next(): Operation<void> {
  return {
    name: 'each.next()',
    *[Symbol.iterator]() {
      const stack = yield* EachStack.expect()
      const context = stack[stack.length - 1]
      if (!context) {
        throw fail('IterationError', `cannot call next() outside of an iteration`)
      }
      const current = yield* context.subscription.next()
      delete context.stale
      context.current = current
      if (current.done) {
        context.finish()
        // same contract as the loop head: a Failure close raises instead of ending cleanly
        if (isFailure(current.value)) {
          return yield* current.value
        }
      }
    },
  } as Operation<void>
}
