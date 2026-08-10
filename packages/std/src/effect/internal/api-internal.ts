import { succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { createContext } from '../base/context'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope } from '../types/operation'
import type { Api, Around, Middleware, Utils } from '../types/utils'

import { ChildrenContext } from './contexts'

const getScope: Helpers.Effect<Scope> = {
  cause: 'Fast, non-typesafe lookup of co-routine scope',
  enter: (resolve, routine) => {
    resolve(succeed(routine.scope))
    return didExit => didExit(succeed())
  },
}

function decorate<A>(base: Utils.Decorator<A>, next: Utils.Decorator<A>): Utils.Decorator<A> {
  return {
    max: base.max ? (next.max ? append(base.max, next.max) : base.max) : next.max,
    min: next.min ? (base.min ? append(next.min, base.min) : next.min) : base.min,
  }
}

function append<A>(outer: Partial<Around<A>>, inner: Partial<Around<A>>): Partial<Around<A>> {
  const result: Partial<Around<A>> = { ...outer }
  for (const key of Object.keys(inner) as (keyof A)[]) {
    const current = outer[key]
    const decoration = inner[key]
    if (current) {
      const pair = [current, decoration] as Middleware<unknown[], unknown>[]
      result[key] = combine(pair) as Around<A>[keyof A]
    } else {
      result[key] = decoration
    }
  }
  return result
}

function install<A>(scope: Scope, api: ApiInternal<A>, total: Utils.Decorator<A>): void {
  let propagated = total

  if (scope.hasOwn(api.context)) {
    const context = scope.expect(api.context)

    context.total = total

    propagated = decorate(context.total, context.local)

    context.handle = createApiHandle(propagated, api.core)
  }

  for (const child of scope.expect(ChildrenContext)) {
    install(child, api, propagated)
  }
}

function createApiHandle<A>(decoration: Utils.Decorator<A>, core: A): A {
  const around = decoration.max
    ? decoration.min
      ? append(decoration.max, decoration.min)
      : decoration.max
    : decoration.min
  if (!around) {
    return core
  }
  const handle: A = {} as A
  for (const key of Object.keys(core as object) as (keyof A)[]) {
    const middleware = around[key] as Middleware<unknown[], unknown> | undefined
    if (middleware) {
      if (typeof core[key] === 'function') {
        handle[key] = ((...args: unknown[]) =>
          middleware(args, core[key] as (...args: unknown[]) => unknown)) as A[keyof A]
      } else {
        Object.defineProperty(handle, key, {
          enumerable: true,
          get() {
            return middleware([], () => core[key])
          },
        })
      }
    } else {
      handle[key] = core[key]
    }
  }
  return handle
}

function isOperation<T>(target: Operation<T> | T): target is Operation<T> {
  return (
    !!target &&
    !isNativeIterable(target) &&
    typeof (target as Operation<T>)[Symbol.iterator] === 'function'
  )
}

function isNativeIterable(target: unknown): boolean {
  return (
    typeof target === 'string' ||
    Array.isArray(target) ||
    target instanceof Map ||
    target instanceof Set
  )
}

function combine<TArgs extends unknown[], TReturn>(
  middlewares: Middleware<TArgs, TReturn>[],
): Middleware<TArgs, TReturn> {
  if (middlewares.length === 0) {
    return (args, next) => next(...args)
  }
  return middlewares.reduceRight(
    (sum, middleware) => (args, next) => middleware(args, (...inner) => sum(inner, next)),
  )
}

export interface ApiInternal<A> extends Api<A> {
  context: Context<{
    local: Utils.Decorator<A>
    total: Utils.Decorator<A>
    handle: A
  }>
  core: A
}

export function createApiInternal<A extends object>(name: string, core: A): ApiInternal<A> {
  const fields = Object.keys(core) as (keyof A)[]

  const context = createContext(`std:effect:api.${name}`) as ApiInternal<A>['context']

  const api: ApiInternal<A> = {
    core,
    context,

    invoke: (scope, key, args) => {
      const handle = scope.get(api.context)?.handle ?? core

      const member = handle[key]
      if (typeof member === 'function') {
        return member(...(args as AnyType[]))
      }
      return member as AnyType
    },
    around: (decorator, options) => ({
      *[Symbol.iterator]() {
        const scope = (yield getScope) as Scope
        decorateApi(scope, api, decorator, options)
      },
    }),
    operations: fields.reduce(
      (sum, field) => {
        if (typeof core[field] === 'function') {
          return Object.assign(sum, {
            [field]: (...args: AnyType[]) => ({
              *[Symbol.iterator]() {
                const scope = (yield getScope) as Scope
                const target = api.invoke(scope, field, args as AnyType)

                return isOperation(target) ? yield* target : target
              },
            }),
          })
        }
        return Object.assign(sum, {
          [field]: {
            *[Symbol.iterator]() {
              const scope = (yield getScope) as Scope
              const target = api.invoke(scope, field, [] as AnyType)
              return isOperation(target) ? yield* target : target
            },
          },
        })
      },
      {} as Api<A>['operations'],
    ),
  } as ApiInternal<A>

  return api
}

export function decorateApi<A>(
  scope: Scope,
  api: ApiInternal<A>,
  ...[decorator, options]: [decorator: Partial<Around<A>>, options?: { at: 'min' | 'max' }]
): void {
  // read existing total and local
  const current = scope.get(api.context) ?? { total: {}, local: {} }

  const local = decorate(current.local, {
    [options?.at ?? 'max']: decorator,
  })

  if (scope.hasOwn(api.context)) {
    current.local = local
  } else {
    scope.set(api.context, {
      local,
      total: current.total,
      handle: api.core,
    })
  }

  install(scope, api, current.total)
}
