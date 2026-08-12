import { succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { createContext } from '../../base/context'
import { API } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { Context, Scope } from '../../types/operation'
import { isOperation } from '../../utils/is'

import { decorateApi } from './propagate'

const getScope: Helpers.Effect<Scope> = {
  cause: 'Fast, non-typesafe lookup of co-routine scope',
  enter: (resolve, routine) => {
    resolve(succeed(routine.scope))
    return didExit => didExit(succeed())
  },
}

export function createApiInternal<A extends object>(name: string, core: A): Helpers.ApiInternal<A> {
  const fields = Object.keys(core) as (keyof A)[]

  const context = createContext(`std:effect:api.${name}`) as Context<Helpers.ApiState<A>>

  const api: Helpers.ApiInternal<A> = {
    _t: API,
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
    actions: fields.reduce(
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
      {} as Helpers.ApiInternal<A>['actions'],
    ),
  } as Helpers.ApiInternal<A>

  return api
}
