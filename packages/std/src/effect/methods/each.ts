// oxlint-disable import/exports-last

import type { Helpers } from '../types/helpers'
import type { Operation, Stream } from '../types/operation'

import { createContext } from './context'
import { useScope } from './scope'
import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

const EachStack = createContext<Helpers.EachLoop<unknown>[]>('each')

export function each<T>(stream: Stream<T, unknown>): Operation<Iterable<T>> {
  return {
    *[Symbol.iterator]() {
      const scope = yield* useScope()
      if (!scope.hasOwn(EachStack)) {
        scope.set(EachStack, [])
      }

      const done = withResolvers<void>()
      const cxt = withResolvers<Helpers.EachLoop<T>>()

      yield* spawn(function* () {
        const subscription = yield* stream
        const current = yield* subscription.next()

        const stack = scope.expect(EachStack)

        const context: Helpers.EachLoop<T> = {
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
              const error = new Error(
                'for each loop did not use each.next() operation before continuing',
              )
              error.name = 'IterationError'
              throw error
            }
            context.stale = true
            return context.current
          },
          return() {
            context.finish()
            return { done: true as const, value: void 0 }
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
        const error = new Error('cannot call next() outside of an iteration')
        error.name = 'IterationError'
        throw error
      }
      const current = yield* context.subscription.next()
      delete context.stale
      context.current = current
      if (current.done) {
        context.finish()
      }
    },
  } as Operation<void>
}
