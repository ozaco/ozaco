import type { Operation } from 'std:effect'
import { createContext, operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { SERVICE } from '../const'
import type { ActionMeta } from '../types/action'
import type { Impl } from '../types/impl'
import type { Service } from '../types/service'

const SelfContext = createContext<Service>('server:service:self')

export function* useSelf(): Operation<Service> {
  return yield* useContext(SelfContext)
}

export const defineService: Impl.DefineService = options => {
  const { name, version, actions: rawActions, setup: rawSetup } = options

  const flatActions = flatten((rawActions ?? {}) as Record<string, AnyType>)
  const actions: Record<string, AnyType> = {}
  const metaMap = new Map<string, ActionMeta<AnyType>>()

  for (const [key, rawAction] of Object.entries(flatActions)) {
    actions[key] = operation(function* (...args: AnyType[]) {
      try {
        return yield* rawAction(...args)
      } catch (error) {
        yield* asFailure(error, key)
      }
    })

    metaMap.set(key, {
      input: rawAction.input,
      output: rawAction.output,
      title: rawAction.title,
      description: rawAction.description,
    })
  }

  let serviceRef: AnyType = null

  const setup: AnyType = function* (...args: AnyType[]) {
    yield* SelfContext.set(serviceRef)
    if (rawSetup) {
      return yield* rawSetup(...(args as AnyType))
    }
  }

  const def = definePlugin({ name, version, setup })
  const plugin = def.build(actions)

  const service = Object.create(plugin) as AnyType
  service._st = SERVICE
  service.meta = metaMap

  serviceRef = service

  return Object.freeze(service)
}
