import type { Plugin } from 'std:plugin'
import { defineProtocol, install } from 'std:plugin'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { SERVICE } from '../const'
import type { Action } from '../types/action'
import type { Impl } from '../types/impl'

import { ServiceContext } from './context'
import { isAction } from './is'

/**
 * Build a service, and its route table with it.
 *
 * `flatten` supplies the grammar: a nested `actions` record becomes dotted paths (`admin.purge`),
 * so a route's key and the `actionKey` a carrier puts on the wire are the same string. One spelling
 * of an address is the whole point — it used to be derived in several places and they disagreed.
 */
export const defineService: Impl.DefineService = (options): AnyType => {
  const routes = new Map<string, Action>()

  for (const [path, candidate] of Object.entries(flatten(options.actions as AnyType))) {
    if (isAction(candidate)) {
      routes.set(path, candidate)
    }
  }

  // The reverse direction, built alongside rather than scanned on demand: a carrier holding an
  // action and needing its address asks this, and asking used to mean walking every registered
  // service's actions on every call.
  const paths = new Map<Action, string>()
  for (const [path, action] of routes) {
    paths.set(action, path)
  }

  // Sealed once. Compiling twice hands out two plugins over one definition, and installing both
  // gives the service two contexts — the same object disagreeing with itself.
  let compiled: Plugin<AnyType, AnyType[], AnyType> | undefined

  const service: AnyType = defineProtocol({
    subtype: SERVICE,

    name: options.name,
    version: options.version,
    ...(options.description === undefined ? {} : { description: options.description }),

    handlers: {
      *_has(path: string) {
        return routes.has(path)
      },

      *_get(path: string) {
        return routes.get(path)
      },

      *_list() {
        return [...routes.entries()]
      },

      *_pathOf(action: Action) {
        return paths.get(action)
      },

      /**
       * `yield* AuthService.actions.install()` — the only way a service reaches a scope.
       *
       * A handler, not a property bolted onto the protocol object: the Protocol shape is fixed and
       * a service must not widen it. It seals first and installs the result, so the two can never
       * happen out of order and the first can never be skipped.
       */
      *install(...args: AnyType[]) {
        return yield* install(yield* service.actions._compile(), ...args)
      },

      *_compile() {
        compiled ??= service
          .implement({
            name: options.name,
            version: options.version,
            ...(options.description === undefined ? {} : { description: options.description }),

            *setup(...args: AnyType[]) {
              yield* ServiceContext.set(service)

              if (options.setup) {
                return yield* options.setup(...(args as AnyType))
              }
            },
          })
          .build(options.actions ?? {})

        return compiled
      },
    } as AnyType,
  })

  return service
}
