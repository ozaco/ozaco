import { succeed, type Result } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'

import { Do } from '../internal/do'

export const createContext = <T>(name: string, defaultValue?: T): Context<T> => {
  let context = {
    name,
    defaultValue,
    get: () => Do(Get(context)),
    set: (value: T) => Do(Set(context, value)),
    expect: () => Do(Expect(context)),
    delete: () => Do(Delete(context)),
    *with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R> {
      let scope = yield* Do(UseScope(target => target, 'useScope()'))
      let original = scope.hasOwn(context) ? scope.get(context) : undefined
      try {
        return yield* operation(scope.set(context, value))
      } finally {
        if (typeof original === 'undefined') {
          scope.delete(context)
        } else {
          scope.set(context, original)
        }
      }
    },
  } as Context<T>

  return context
}

const Get = <T>(context: Context<T>) =>
  UseScope(scope => scope.get(context), `get(${context.name})`)

const Set = <T>(context: Context<T>, value: T) =>
  UseScope(scope => scope.set(context, value), `set(${context.name}, ${value})`)

const Expect = <T>(context: Context<T>) =>
  UseScope(scope => scope.expect(context), `expect(${context.name})`)

const Delete = <T>(context: Context<T>) =>
  UseScope(scope => scope.delete(context), `delete(${context.name})`)

const UseScope = <T>(fn: (scope: Scope) => T, description: string): Helpers.Effect<T> => ({
  description,
  enter: (rootResolve, { scope }) => {
    rootResolve(succeed(fn(scope)) as Result<T, never>)
    return resolve => {
      resolve(succeed())
    }
  },
})
