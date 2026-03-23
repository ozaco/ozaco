import type { Helpers } from '../types/helpers'
import type { Operation, Stream } from '../types/operation'

import { createContext } from './context'
import { useScope } from './scope'
import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function each<T>(stream: Stream<T, unknown>): Operation<Iterable<T>> {
  return {
    *[Symbol.iterator]() {
      let scope = yield* useScope()
      if (!scope.hasOwn(EachStack)) {
        scope.set(EachStack, [])
      }

      let done = withResolvers<void>()
      let cxt = withResolvers<Helpers.EachLoop<T>>()

      yield* spawn(function* () {
        let subscription = yield* stream
        let current = yield* subscription.next()

        let stack = scope.expect(EachStack)

        let context: Helpers.EachLoop<T> = {
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

      let context = yield* cxt.operation

      return {
        [Symbol.iterator]: () => ({
          next() {
            if (context.stale) {
              let error = new Error(
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
      let stack = yield* EachStack.expect()
      let context = stack[stack.length - 1]
      if (!context) {
        let error = new Error('cannot call next() outside of an iteration')
        error.name = 'IterationError'
        throw error
      }
      let current = yield* context.subscription.next()
      delete context.stale
      context.current = current
      if (current.done) {
        context.finish()
      }
    },
  } as Operation<void>
}

const EachStack = createContext<Helpers.EachLoop<unknown>[]>('each')
