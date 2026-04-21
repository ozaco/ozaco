import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { SelfContext, SERVICE } from '../const'
import type { ActionMeta } from '../types/action'
import type { Impl } from '../types/impl'

export const defineService: Impl.DefineService = options => {
  const { name, version, actions: rawActions, setup: rawSetup } = options

  const flatActions = flatten((rawActions ?? {}) as Record<string, AnyType>)
  const actions: Record<string, AnyType> = {}
  const metaMap = new Map<string, ActionMeta<AnyType>>()

  for (const [key, action] of Object.entries(flatActions)) {
    actions[key] = action

    metaMap.set(key, {
      isRaw: action.isRaw,
      input: action.input,
      output: action.output,
      title: action.title,
      description: action.description,
      allow: action.allow,
      deny: action.deny,
      settings: action.settings,
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
