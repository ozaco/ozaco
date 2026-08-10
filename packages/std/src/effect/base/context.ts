import type { Result } from 'std:result'
import { succeed } from 'std:result'

import { CONTEXT, SNAPSHOT_FLAG } from '../const'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'

import { perform } from './perform'

// private effects for efficiency
const getContext = <T>(context: Context<T>) =>
  useScope(scope => scope.get(context), `get(${context.name})`)
const setContext = <T>(context: Context<T>, value: T) =>
  useScope(scope => scope.set(context, value), `set(${context.name}, ${value})`)
const expectContext = <T>(context: Context<T>) =>
  useScope(scope => scope.expect(context), `expect(${context.name})`)
const deleteContext = <T>(context: Context<T>) =>
  useScope(scope => scope.delete(context), `delete(${context.name})`)

function useScope<T>(fn: (scope: Scope) => T, cause: string): Helpers.Effect<T> {
  return {
    cause,
    enter: (resolve, { scope }) => {
      resolve(succeed(fn(scope)) as Result.Success<T>)
      return exit => {
        exit(succeed())
      }
    },
  }
}

export function createContext<T>(name: string, defaultValue?: T): Context<T> {
  const context: Context<T> = {
    _t: CONTEXT,
    name,
    defaultValue,
    get: () => perform(getContext(context)),
    set: value => perform(setContext(context, value)),
    expect: () => perform(expectContext(context)),
    delete: () => perform(deleteContext(context)),
    *with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R> {
      const scope = yield* perform(useScope(s => s, 'useScope()'))
      const original = scope.hasOwn(context) ? scope.get(context) : undefined
      try {
        return yield* operation(scope.set(context, value))
      } finally {
        if (original === undefined) {
          scope.delete(context)
        } else {
          scope.set(context, original)
        }
      }
    },
  }

  return context
}

export const markContextAsSnapshot = <T>(context: Context<T>): Context<T> => {
  ;(context as Context<T> & { [SNAPSHOT_FLAG]?: true })[SNAPSHOT_FLAG] = true
  return context
}
