import { operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { SERVICE } from '../const'
import type { Impl } from '../types/impl'

export const defineService: Impl.DefineService = options => {
  const { name, version, actions: rawActions, setup: rawSetup } = options

  const actions: Record<string, AnyType> = {}

  for (const [rawActionKey, rawActionValue] of Object.entries(
    (rawActions ?? {}) as Record<string, AnyType>,
  )) {
    actions[rawActionKey] = operation(function* (...args) {
      try {
        yield* rawActionValue(...args)
      } catch (error) {
        yield* asFailure(error, rawActionKey)
      }
    })
  }

  const setup: AnyType = rawSetup || function* () {}

  const def = definePlugin({ name, version, setup })
  const plugin = def.build(actions)

  const service = Object.create(plugin) as AnyType
  service._st = SERVICE

  return Object.freeze(service)
}
