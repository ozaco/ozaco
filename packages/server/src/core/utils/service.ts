import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { SERVICE } from '../const'
import type { Impl } from '../types/impl'

import { ServiceContext } from './context'

export const defineService: Impl.DefineService = options => {
  const { name, description, version, actions = {}, setup: rawSetup } = options

  const service: AnyType = definePlugin({
    subtype: SERVICE,

    name,
    description,
    version,

    setup: function* (...args: AnyType[]) {
      yield* ServiceContext.set(service)

      if (rawSetup) {
        return yield* rawSetup(...(args as AnyType))
      }
    } as AnyType,
  }).build(actions as AnyType)

  return service
}
