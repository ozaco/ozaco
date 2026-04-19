import type { Result } from 'std:result'
import { succeed } from 'std:result'

import { CONTEXT } from '../const'
import { doOp } from '../internal/do'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'

const useScope = <T>(fn: (scope: Scope) => T, desc: string): Helpers.Effect<T> => [
  (rootResolve, { scope }) => {
    rootResolve(succeed(fn(scope)) as Result<T, never>)
    return resolve => {
      resolve(succeed())
    }
  },
  desc,
]

const getContext = <T>(context: Context<T>) =>
  useScope(scope => scope.get(context), `get(${context.name})`)

const setContext = <T>(context: Context<T>, value: T) =>
  useScope(scope => scope.set(context, value), `set(${context.name}, ${value})`)

const expectContext = <T>(context: Context<T>) =>
  useScope(scope => scope.expect(context), `expect(${context.name})`)

const deleteContext = <T>(context: Context<T>) =>
  useScope(scope => scope.delete(context), `delete(${context.name})`)

export const createContext = <T>(name: string, defaultValue?: T): Context<T> => {
  const context = {
    _t: CONTEXT,
    name,
    defaultValue,
    get: () => doOp(getContext(context)),
    set: (value: T) => doOp(setContext(context, value)),
    expect: () => doOp(expectContext(context)),
    delete: () => doOp(deleteContext(context)),
    *with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R> {
      const scope = yield* doOp(useScope(target => target, 'useScope()'))
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
  } as Context<T>

  return context
}

export const useContext = <T>(ctx: Context<T>): Operation<T> => ctx.expect()
